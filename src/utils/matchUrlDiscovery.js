const { logger } = require('./logger');
const {
  resolveMatchUrlSearchSlot,
  resolveMatchUrlLiveSlot,
  resolveAnyMatchUrlSlot,
  minutesUntilKickoff,
  MATCH_URL_MAX_ATTEMPTS,
  MATCH_URL_SEARCH_SLOTS,
  STREAM_SEARCH_INTERVAL_MINUTES,
  MATCH_LIVE_DURATION_MIN,
} = require('./time');
const { MATCH_URL_STATUS } = require('./streamUrlHelper');

function isConfirmedMatchUrlStatus(status) {
  return (
    status === MATCH_URL_STATUS.CONFIRMED ||
    status === MATCH_URL_STATUS.CONFIRMED_LEGACY
  );
}

function isSavedMatchUrlStatus(status) {
  return status === MATCH_URL_STATUS.FOUND || isConfirmedMatchUrlStatus(status);
}

function isFailedMatchUrlStatus(status) {
  return status === MATCH_URL_STATUS.FAILED;
}

/**
 * Unique Match URL job: matchId + source + operation + attempt.
 * Same attempt must not run twice simultaneously.
 */
function matchUrlJobKey(matchId, sourceName, attemptOrSlot) {
  let attemptLabel = 'attempt1';
  if (attemptOrSlot && typeof attemptOrSlot === 'object') {
    const n = Number(attemptOrSlot.attempt);
    attemptLabel = n > 0 ? `attempt${n}` : `attempt:${attemptOrSlot.id || 'none'}`;
  } else if (typeof attemptOrSlot === 'number' && attemptOrSlot > 0) {
    attemptLabel = `attempt${attemptOrSlot}`;
  } else if (attemptOrSlot) {
    const raw = String(attemptOrSlot);
    attemptLabel = raw.startsWith('attempt') ? raw : `attempt:${raw}`;
  }
  return `${matchId || 'unknown'}:${sourceName || 'source'}:match-url:${attemptLabel}`;
}

function isTransientDiscoverError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  if (
    [
      'ETIMEDOUT',
      'ESOCKETTIMEDOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }
  if (
    /timeout|timed out|dns|enotfound|econnreset|econnrefused|eai_again|socket hang up|network|ehostunreach/.test(
      msg
    )
  ) {
    return true;
  }
  if (/\b(403|404|429|502|503)\b/.test(msg) || /status code 40[34]/.test(msg)) {
    return true;
  }
  if (/antibot|cloudflare|access denied|just a moment/.test(msg)) {
    return true;
  }
  return false;
}

function slotLeadLabel(slot) {
  if (!slot) return 'unknown';
  if (slot.early) return 'early';
  if (slot.live) return 'live (kickoff to +2h)';
  const n = Number(slot.maxInclusive);
  return Number.isFinite(n) ? `-${n} minutes` : String(slot.id || 'unknown');
}

function nextMatchUrlSlot(slot) {
  if (!slot?.id) return null;
  const slots = MATCH_URL_SEARCH_SLOTS || [];
  const idx = slots.findIndex((s) => s.id === slot.id);
  if (idx < 0 || idx + 1 >= slots.length) return null;
  return slots[idx + 1];
}

function logMatchUrlDiscovery({
  fixture,
  sourceName,
  slot,
  attempt,
  result,
  matchUrl = null,
} = {}) {
  const home = fixture?.homeTeam || '?';
  const away = fixture?.awayTeam || '?';
  const time = fixture?.kickoffTime || fixture?.time || '';
  logger.info(
    `[ MATCH URL DISCOVERY ] Match: ${home} vs ${away} Kickoff: ${time} Source: ${sourceName} Attempt: ${attempt}/${MATCH_URL_MAX_ATTEMPTS} Scheduled: ${slotLeadLabel(slot)} Result: ${result}`
  );
  if (matchUrl && (result === 'FOUND' || result === 'CONFIRMED')) {
    logger.info(
      `[ MATCH URL FOUND ] Source: ${sourceName} Match: ${home} vs ${away} Match URL: ${matchUrl} Attempt: ${attempt}/${MATCH_URL_MAX_ATTEMPTS} Status: ${
        result === 'CONFIRMED'
          ? MATCH_URL_STATUS.CONFIRMED
          : MATCH_URL_STATUS.FOUND
      }`
    );
  }
}

function logMatchUrlFallback({ sourceName, previousSlot, nextSlot } = {}) {
  if (!nextSlot) return;
  logger.info(
    `[ MATCH URL FALLBACK ] Source: ${sourceName} Previous attempt: ${slotLeadLabel(previousSlot)} NOT_FOUND Next attempt: ${slotLeadLabel(nextSlot)}`
  );
}

function logMatchUrlFailed({ sourceName, attempts } = {}) {
  logger.info(
    `[ MATCH URL FAILED ] Source: ${sourceName} Attempts: ${attempts}/${MATCH_URL_MAX_ATTEMPTS} Result: ${MATCH_URL_STATUS.FAILED}`
  );
}

/**
 * Per-source Match URL discovery state on a FotMob fixture.
 * Today-page search runs at most 3 times: −60 / −45 / −30. Once a URL is saved,
 * that source is not searched again.
 */
function ensureMatchUrlSearch(fixture) {
  const prev =
    fixture?.matchUrlSearch && typeof fixture.matchUrlSearch === 'object'
      ? fixture.matchUrlSearch
      : {};
  return {
    slotsDone: { ...(prev.slotsDone || {}) },
    sources: { ...(prev.sources || {}) },
  };
}

function repairSlotsDone(slotsDone, attempts, hasUrl) {
  const next = { ...(slotsDone || {}) };
  const n = Number(attempts) || 0;
  if (hasUrl || n >= MATCH_URL_MAX_ATTEMPTS) return next;
  // Legacy tEarly rows marked t30 done after one miss and never ran −60/−45.
  if (next.tEarly && !next.t60 && !next.t45) {
    delete next.tEarly;
    delete next.t30;
  }
  return next;
}

function discoveredMatchUrl(raw) {
  const url = String(raw?.matchUrl || '').trim();
  return url || null;
}

/**
 * sourcePages must follow per-source discovery. Ignore leftover sister-site
 * slugs when this source never saved its own Match URL.
 */
function getSourceMatchUrlState(fixture, sourceName) {
  const search = ensureMatchUrlSearch(fixture);
  const raw = search.sources?.[sourceName] || {};
  const pageUrl = fixture?.sourcePages?.[sourceName] || null;
  const discovered = discoveredMatchUrl(raw);
  // Legacy rows had a page URL and no per-source search status.
  const url = discovered || (!raw.status ? pageUrl : null);
  let status = raw.status || null;
  if (!status) {
    status = url ? MATCH_URL_STATUS.FOUND : MATCH_URL_STATUS.PENDING;
  } else if (
    discovered &&
    (status === MATCH_URL_STATUS.NOT_FOUND ||
      status === MATCH_URL_STATUS.PENDING ||
      status === MATCH_URL_STATUS.SEARCHING)
  ) {
    status = MATCH_URL_STATUS.FOUND;
  } else if (status === MATCH_URL_STATUS.NOT_FOUND && !discovered) {
    const attempts = Number(raw.attempts) || 0;
    status =
      attempts >= MATCH_URL_MAX_ATTEMPTS
        ? MATCH_URL_STATUS.FAILED
        : MATCH_URL_STATUS.PENDING;
  } else if (status === MATCH_URL_STATUS.CONFIRMED_LEGACY) {
    status = MATCH_URL_STATUS.CONFIRMED;
  }
  const attempts = Number(raw.attempts) || 0;
  return {
    matchUrl: url || null,
    status,
    attempts,
    liveAttempts: Number(raw.liveAttempts) || 0,
    lastAttemptAt: raw.lastAttemptAt || null,
    slotsDone: repairSlotsDone(raw.slotsDone, attempts, Boolean(url)),
    confidence: Number(raw.confidence) || 0,
  };
}

function sourceHasSavedMatchUrl(state) {
  if (!state?.matchUrl) return false;
  return isSavedMatchUrlStatus(state.status);
}

function lastAttemptAgeSec(lastAttemptAt, nowSec) {
  if (!lastAttemptAt) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(lastAttemptAt);
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return nowSec - Math.floor(ms / 1000);
}

/**
 * True when this source should scrape the Today page for this FotMob fixture.
 */
function needsMatchUrlDiscovery(fixture, sourceName, nowSec) {
  const st = getSourceMatchUrlState(fixture, sourceName);
  if (sourceHasSavedMatchUrl(st)) return false;

  const cooldownSec = Math.max(1, STREAM_SEARCH_INTERVAL_MINUTES) * 60;
  const liveSlot = resolveMatchUrlLiveSlot(fixture?.kickoff, nowSec);
  if (liveSlot) {
    if ((Number(st.liveAttempts) || 0) >= MATCH_URL_MAX_ATTEMPTS) return false;
    return lastAttemptAgeSec(st.lastAttemptAt, nowSec) >= cooldownSec;
  }

  const slot = resolveMatchUrlSearchSlot(fixture?.kickoff, nowSec);
  if (!slot) return false;

  // Listings often appear after the −30 miss. Keep hunting in the last
  // pre-kickoff window even after MATCH_URL_FAILED, with the same cooldown.
  if (isFailedMatchUrlStatus(st.status) || st.attempts >= MATCH_URL_MAX_ATTEMPTS) {
    if (slot.early) return false;
    return lastAttemptAgeSec(st.lastAttemptAt, nowSec) >= cooldownSec;
  }

  if (slot.early) {
    return !st.slotsDone[slot.id];
  }
  if (!st.slotsDone[slot.id]) return true;

  // Leftover budget: old tEarly/t30 rows marked the slot done after 1 miss,
  // skipping −60/−45. Keep searching until 3 attempts, with interval cooldown.
  return lastAttemptAgeSec(st.lastAttemptAt, nowSec) >= cooldownSec;
}

function applySourceDiscoveryResult(fixture, sourceName, hit, slot, nowIso) {
  const search = ensureMatchUrlSearch(fixture);
  const prev = getSourceMatchUrlState(fixture, sourceName);
  let attempts = prev.attempts;
  let liveAttempts = prev.liveAttempts;
  if (slot?.early) {
    attempts = prev.attempts;
  } else if (slot?.live) {
    liveAttempts = Math.min(MATCH_URL_MAX_ATTEMPTS, (Number(prev.liveAttempts) || 0) + 1);
  } else {
    attempts = Math.min(MATCH_URL_MAX_ATTEMPTS, prev.attempts + 1);
  }
  const slotsDone = { ...prev.slotsDone };
  if (slot?.id) slotsDone[slot.id] = true;

  let status = prev.status;
  let matchUrl = prev.matchUrl;
  let confidence = prev.confidence;
  let resultLabel = 'NOT_FOUND';

  if (hit?.matchUrl && hit.accepted !== false) {
    matchUrl = hit.matchUrl;
    confidence = Number(hit.confidence || hit.score || 0) || confidence;
    const confirmed =
      isConfirmedMatchUrlStatus(hit.status) ||
      Number(confidence) >= 90;
    status = confirmed ? MATCH_URL_STATUS.CONFIRMED : MATCH_URL_STATUS.FOUND;
    resultLabel = confirmed ? 'CONFIRMED' : 'FOUND';
  } else if (
    !matchUrl &&
    ((slot?.live && liveAttempts >= MATCH_URL_MAX_ATTEMPTS) ||
      (!slot?.live && !slot?.early && attempts >= MATCH_URL_MAX_ATTEMPTS))
  ) {
    status = MATCH_URL_STATUS.FAILED;
    resultLabel = 'FAILED';
  } else if (!matchUrl) {
    status = slot?.live ? MATCH_URL_STATUS.SEARCHING : MATCH_URL_STATUS.PENDING;
    resultLabel = 'NOT_FOUND';
  }

  search.sources[sourceName] = {
    matchUrl,
    status,
    attempts,
    liveAttempts,
    lastAttemptAt: nowIso,
    slotsDone,
    confidence,
  };
  if (slot?.id) search.slotsDone[slot.id] = true;

  const sourcePages = { ...(fixture.sourcePages || {}) };
  if (matchUrl) sourcePages[sourceName] = matchUrl;
  else delete sourcePages[sourceName];

  logMatchUrlDiscovery({
    fixture,
    sourceName,
    slot,
    attempt: slot?.live ? liveAttempts : attempts,
    result: resultLabel,
    matchUrl,
  });
  if (resultLabel === 'NOT_FOUND') {
    logMatchUrlFallback({
      sourceName,
      previousSlot: slot,
      nextSlot: nextMatchUrlSlot(slot),
    });
  }
  if (resultLabel === 'FAILED') {
    logMatchUrlFailed({ sourceName, attempts });
  }

  return aggregateMatchUrlFields({
    ...fixture,
    sourcePages,
    matchUrlSearch: search,
    lastMatchUrlAttemptAt: nowIso,
  });
}

function skipDiscoveryKeepKnown(fixture, sourceName) {
  const st = getSourceMatchUrlState(fixture, sourceName);
  const sourcePages = { ...(fixture.sourcePages || {}) };
  if (sourceHasSavedMatchUrl(st) && st.matchUrl) {
    sourcePages[sourceName] = st.matchUrl;
  } else {
    delete sourcePages[sourceName];
  }
  return aggregateMatchUrlFields({
    ...fixture,
    sourcePages,
    matchUrlSearch: ensureMatchUrlSearch(fixture),
  });
}

/**
 * After kickoff (or 3 failed slots), never leave an unknown status.
 */
function finalizeMatchUrlStatus(fixture, nowSec) {
  const next = aggregateMatchUrlFields(fixture);
  if (next.matchUrl && next.matchUrlStatus !== MATCH_URL_STATUS.FAILED) {
    return next;
  }
  const mins = minutesUntilKickoff(fixture?.kickoff, nowSec);
  const liveOpen =
    mins != null && mins <= 0 && mins > -MATCH_LIVE_DURATION_MIN;
  if (liveOpen) {
    return {
      ...next,
      matchUrlStatus: MATCH_URL_STATUS.SEARCHING,
    };
  }
  if (mins != null && mins <= -MATCH_LIVE_DURATION_MIN) {
    return {
      ...next,
      matchUrlStatus: MATCH_URL_STATUS.FAILED,
    };
  }
  // Three pre-kickoff misses are not terminal — live catch-up still runs.
  if (
    !next.matchUrl &&
    next.matchUrlStatus === MATCH_URL_STATUS.FAILED &&
    mins != null &&
    mins > 0
  ) {
    return {
      ...next,
      matchUrlStatus: MATCH_URL_STATUS.SEARCHING,
    };
  }
  return {
    ...next,
    matchUrlStatus: next.matchUrlStatus || MATCH_URL_STATUS.PENDING,
  };
}

function sanitizeSourcePages(fixture) {
  const search = ensureMatchUrlSearch(fixture);
  const prev = { ...(fixture.sourcePages || {}) };
  const names = Object.keys(search.sources || {});
  if (!names.length) return prev;

  const next = {};
  for (const name of names) {
    const raw = search.sources[name] || {};
    const url = discoveredMatchUrl(raw);
    if (!url) continue;
    next[name] = url;
  }
  return next;
}

function aggregateMatchUrlFields(fixture) {
  const search = ensureMatchUrlSearch(fixture);
  const sourcePages = sanitizeSourcePages(fixture);

  let bestUrl = fixture.matchUrl || null;
  let bestStatus = isSavedMatchUrlStatus(fixture.matchUrlStatus)
    ? isConfirmedMatchUrlStatus(fixture.matchUrlStatus)
      ? MATCH_URL_STATUS.CONFIRMED
      : MATCH_URL_STATUS.FOUND
    : MATCH_URL_STATUS.PENDING;
  let bestScore = bestUrl ? 1 : -1;
  let bestSource = fixture.matchUrlSource || null;
  let maxAttempts = 0;
  let lastAt = fixture.lastMatchUrlAttemptAt || null;
  let allFailed = true;
  let sourceCount = 0;

  for (const [name, raw] of Object.entries(search.sources || {})) {
    sourceCount += 1;
    const url = discoveredMatchUrl(raw) || sourcePages[name] || null;
    const attempts = Number(raw.attempts) || 0;
    if (attempts > maxAttempts) maxAttempts = attempts;
    if (raw.lastAttemptAt && (!lastAt || raw.lastAttemptAt > lastAt)) {
      lastAt = raw.lastAttemptAt;
    }
    const conf = Number(raw.confidence) || 0;
    let status = raw.status || (url ? MATCH_URL_STATUS.FOUND : MATCH_URL_STATUS.PENDING);
    if (status === MATCH_URL_STATUS.CONFIRMED_LEGACY) status = MATCH_URL_STATUS.CONFIRMED;
    if (status === MATCH_URL_STATUS.NOT_FOUND && url) status = MATCH_URL_STATUS.FOUND;
    if (status === MATCH_URL_STATUS.NOT_FOUND && !url) {
      status =
        attempts >= MATCH_URL_MAX_ATTEMPTS
          ? MATCH_URL_STATUS.FAILED
          : MATCH_URL_STATUS.PENDING;
    }
    if (status !== MATCH_URL_STATUS.FAILED) allFailed = false;
    const rank = isConfirmedMatchUrlStatus(status)
      ? 200 + conf
      : status === MATCH_URL_STATUS.FOUND
        ? 100 + conf
        : 0;
    if (url && rank > bestScore) {
      bestUrl = url;
      bestStatus = isConfirmedMatchUrlStatus(status)
        ? MATCH_URL_STATUS.CONFIRMED
        : status;
      bestScore = rank;
      bestSource = name;
    }
  }

  if (!bestUrl) {
    for (const [name, url] of Object.entries(sourcePages)) {
      if (url) {
        bestUrl = url;
        bestStatus = MATCH_URL_STATUS.FOUND;
        bestSource = name;
        break;
      }
    }
  }

  if (typeof fixture.matchUrlAttempts === 'number' && fixture.matchUrlAttempts > maxAttempts) {
    maxAttempts = fixture.matchUrlAttempts;
  }

  let matchUrlStatus = bestUrl ? bestStatus : MATCH_URL_STATUS.PENDING;
  if (!bestUrl && allFailed && sourceCount) {
    matchUrlStatus = MATCH_URL_STATUS.FAILED;
  }

  return {
    ...fixture,
    sourcePages,
    matchUrlSearch: search,
    matchUrl: bestUrl || null,
    matchUrlStatus,
    matchUrlAttempts: maxAttempts,
    lastMatchUrlAttemptAt: lastAt || null,
    matchUrlSource: bestUrl ? bestSource : null,
  };
}

module.exports = {
  MATCH_URL_STATUS,
  MATCH_URL_MAX_ATTEMPTS,
  ensureMatchUrlSearch,
  getSourceMatchUrlState,
  sourceHasSavedMatchUrl,
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  skipDiscoveryKeepKnown,
  finalizeMatchUrlStatus,
  aggregateMatchUrlFields,
  matchUrlJobKey,
  isTransientDiscoverError,
  isConfirmedMatchUrlStatus,
  isSavedMatchUrlStatus,
  sanitizeSourcePages,
  slotLeadLabel,
  nextMatchUrlSlot,
};
