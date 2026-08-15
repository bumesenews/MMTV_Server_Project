const {
  resolveMatchUrlSearchSlot,
  minutesUntilKickoff,
  MATCH_URL_MAX_ATTEMPTS,
} = require('./time');
const { MATCH_URL_STATUS } = require('./streamUrlHelper');

/**
 * Per-source Match URL discovery state on a FotMob fixture.
 * Today-page search runs at most 3 times: −30 / −15 / −5. Once a URL is saved,
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

function getSourceMatchUrlState(fixture, sourceName) {
  const search = ensureMatchUrlSearch(fixture);
  const raw = search.sources?.[sourceName] || {};
  const url =
    raw.matchUrl ||
    (fixture?.sourcePages && fixture.sourcePages[sourceName]) ||
    null;
  let status = raw.status || null;
  if (!status) {
    status = url ? MATCH_URL_STATUS.FOUND : MATCH_URL_STATUS.NOT_FOUND;
  }
  return {
    matchUrl: url || null,
    status,
    attempts: Number(raw.attempts) || 0,
    lastAttemptAt: raw.lastAttemptAt || null,
    slotsDone: { ...(raw.slotsDone || {}) },
    confidence: Number(raw.confidence) || 0,
  };
}

function sourceHasSavedMatchUrl(state) {
  if (!state?.matchUrl) return false;
  return (
    state.status === MATCH_URL_STATUS.FOUND ||
    state.status === MATCH_URL_STATUS.CONFIRMED
  );
}

/**
 * True when this source should scrape the Today page for this FotMob fixture.
 */
function needsMatchUrlDiscovery(fixture, sourceName, nowSec) {
  const st = getSourceMatchUrlState(fixture, sourceName);
  if (sourceHasSavedMatchUrl(st)) return false;
  if (st.attempts >= MATCH_URL_MAX_ATTEMPTS) return false;
  const slot = resolveMatchUrlSearchSlot(fixture?.kickoff, nowSec);
  if (!slot) return false;
  if (st.slotsDone[slot.id]) return false;
  return true;
}

function applySourceDiscoveryResult(fixture, sourceName, hit, slot, nowIso) {
  const search = ensureMatchUrlSearch(fixture);
  const prev = getSourceMatchUrlState(fixture, sourceName);
  const attempts = Math.min(MATCH_URL_MAX_ATTEMPTS, prev.attempts + 1);
  const slotsDone = { ...prev.slotsDone };
  if (slot?.id) slotsDone[slot.id] = true;

  let status = prev.status;
  let matchUrl = prev.matchUrl;
  let confidence = prev.confidence;

  if (hit?.matchUrl && hit.accepted !== false) {
    matchUrl = hit.matchUrl;
    confidence = Number(hit.confidence || hit.score || 0) || confidence;
    status =
      hit.status === MATCH_URL_STATUS.CONFIRMED
        ? MATCH_URL_STATUS.CONFIRMED
        : MATCH_URL_STATUS.FOUND;
  } else if (!matchUrl && attempts >= MATCH_URL_MAX_ATTEMPTS) {
    status = MATCH_URL_STATUS.NOT_FOUND;
  } else if (!matchUrl) {
    status = MATCH_URL_STATUS.NOT_FOUND;
  }

  search.sources[sourceName] = {
    matchUrl,
    status,
    attempts,
    lastAttemptAt: nowIso,
    slotsDone,
    confidence,
  };
  if (slot?.id) search.slotsDone[slot.id] = true;

  const sourcePages = { ...(fixture.sourcePages || {}) };
  if (matchUrl) sourcePages[sourceName] = matchUrl;

  return aggregateMatchUrlFields({
    ...fixture,
    sourcePages,
    matchUrlSearch: search,
    lastMatchUrlAttemptAt: nowIso,
  });
}

function skipDiscoveryKeepKnown(fixture, sourceName) {
  const st = getSourceMatchUrlState(fixture, sourceName);
  if (!sourceHasSavedMatchUrl(st)) return fixture;
  const sourcePages = { ...(fixture.sourcePages || {}) };
  if (st.matchUrl) sourcePages[sourceName] = st.matchUrl;
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
  if (next.matchUrl && next.matchUrlStatus !== MATCH_URL_STATUS.NOT_FOUND) {
    return next;
  }
  const mins = minutesUntilKickoff(fixture?.kickoff, nowSec);
  const attempts = Number(next.matchUrlAttempts) || 0;
  if ((mins != null && mins <= 0) || attempts >= MATCH_URL_MAX_ATTEMPTS) {
    return {
      ...next,
      matchUrlStatus: MATCH_URL_STATUS.NOT_FOUND,
    };
  }
  return {
    ...next,
    matchUrlStatus: next.matchUrlStatus || MATCH_URL_STATUS.NOT_FOUND,
  };
}

function aggregateMatchUrlFields(fixture) {
  const search = ensureMatchUrlSearch(fixture);
  const sourcePages = { ...(fixture.sourcePages || {}) };

  let bestUrl = fixture.matchUrl || null;
  let bestStatus = MATCH_URL_STATUS.NOT_FOUND;
  let bestScore = -1;
  let maxAttempts = 0;
  let lastAt = fixture.lastMatchUrlAttemptAt || null;

  for (const [name, raw] of Object.entries(search.sources || {})) {
    const url = raw.matchUrl || sourcePages[name] || null;
    if (url) sourcePages[name] = url;
    const attempts = Number(raw.attempts) || 0;
    if (attempts > maxAttempts) maxAttempts = attempts;
    if (raw.lastAttemptAt && (!lastAt || raw.lastAttemptAt > lastAt)) {
      lastAt = raw.lastAttemptAt;
    }
    const conf = Number(raw.confidence) || 0;
    const status = raw.status || (url ? MATCH_URL_STATUS.FOUND : MATCH_URL_STATUS.NOT_FOUND);
    const rank =
      status === MATCH_URL_STATUS.CONFIRMED
        ? 200 + conf
        : status === MATCH_URL_STATUS.FOUND
          ? 100 + conf
          : 0;
    if (url && rank > bestScore) {
      bestUrl = url;
      bestStatus = status;
      bestScore = rank;
    }
  }

  if (!bestUrl) {
    for (const url of Object.values(sourcePages)) {
      if (url) {
        bestUrl = url;
        bestStatus = MATCH_URL_STATUS.FOUND;
        break;
      }
    }
  }

  if (typeof fixture.matchUrlAttempts === 'number' && fixture.matchUrlAttempts > maxAttempts) {
    maxAttempts = fixture.matchUrlAttempts;
  }

  return {
    ...fixture,
    sourcePages,
    matchUrlSearch: search,
    matchUrl: bestUrl || null,
    matchUrlStatus: bestUrl ? bestStatus : MATCH_URL_STATUS.NOT_FOUND,
    matchUrlAttempts: maxAttempts,
    lastMatchUrlAttemptAt: lastAt || null,
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
};
