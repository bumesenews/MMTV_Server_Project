const { sourceHasSavedMatchUrl } = require('./matchUrlDiscovery');
const { isStreamSearchStopped } = require('./time');
const { MAX_POST_KICKOFF_ATTEMPTS, maxPlayerStreams } = require('./scraperConfig');

const STREAM_SOURCE_STATUS = {
  PREPARING: 'PREPARING_STREAM',
  SEARCHING: 'SEARCHING',
  AVAILABLE: 'AVAILABLE',
  FAILED: 'FAILED',
};

const VALIDATION_REASON = {
  HTTP_403: 'HTTP_403',
  HTTP_404: 'HTTP_404',
  TIMEOUT: 'TIMEOUT',
  NOT_HLS: 'NOT_HLS',
  EMPTY_PLAYLIST: 'EMPTY_PLAYLIST',
  NO_SEGMENTS: 'NO_SEGMENTS',
  INVALID_URL: 'INVALID_URL',
  NOT_FOUND: 'NOT_FOUND',
  BROWSER_ERROR: 'BROWSER_ERROR',
  INVALID: 'INVALID',
};

function isBrowserProtocolError(raw) {
  const msg = String(raw?.message || raw || '');
  return /detached Frame|Target closed|Session closed|Protocol error|Browser disconnected|Execution context was destroyed|Cannot find context/i.test(
    msg
  );
}

function normalizeValidationReason(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (isBrowserProtocolError(value)) return VALIDATION_REASON.BROWSER_ERROR;
  const upper = value.toUpperCase().replace(/[\s-]+/g, '_');
  if (VALIDATION_REASON[upper]) return VALIDATION_REASON[upper];
  if (upper === 'HTTP_401') return VALIDATION_REASON.HTTP_403;
  if (/invalid_url|empty_url|invalid_protocol/i.test(value)) {
    return VALIDATION_REASON.INVALID_URL;
  }
  if (value === '403' || /http_403/i.test(value)) return VALIDATION_REASON.HTTP_403;
  if (value === '404' || /http_404/i.test(value)) return VALIDATION_REASON.HTTP_404;
  if (/not_hls|not_m3u8/i.test(value)) return VALIDATION_REASON.NOT_HLS;
  if (/empty_playlist/i.test(value)) return VALIDATION_REASON.EMPTY_PLAYLIST;
  if (/no_segments/i.test(value)) return VALIDATION_REASON.NO_SEGMENTS;
  if (/timeout|etimedout|econnaborted/i.test(value)) return VALIDATION_REASON.TIMEOUT;
  if (/no_valid_stream|not_found|no stream/i.test(value)) return VALIDATION_REASON.NOT_FOUND;
  // Never leak Puppeteer / stack text into Flutter validationStatus
  return VALIDATION_REASON.NOT_FOUND;
}

function normalizeExtractError(raw) {
  return normalizeValidationReason(raw) || VALIDATION_REASON.NOT_FOUND;
}

function isKnownValidationReason(raw) {
  const normalized = normalizeValidationReason(raw);
  if (!normalized) return false;
  if (VALIDATION_REASON[normalized]) return true;
  return ['HTTP_401', 'AVAILABLE', 'VALIDATING', 'FAILED'].includes(normalized);
}

/**
 * Unique extract job: matchId + source + operation + attempt.
 * Same attempt must never run twice simultaneously.
 */
function extractJobKey(matchId, sourceName, attemptOrSlot) {
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
  return `${matchId || 'unknown'}:${sourceName || 'source'}:stream:${attemptLabel}`;
}

function isValidatedStream(stream) {
  if (!stream?.url) return false;
  if (stream.active === false) return false;
  if (String(stream.source || '').toLowerCase() === 'manual') return true;
  return stream.validation?.ok === true;
}

function sourceHasValidatedStream(match, sourceName) {
  return (match?.streams || []).some(
    (s) => String(s?.source || '') === String(sourceName || '') && isValidatedStream(s)
  );
}

function uniqueSourceStreamUrls(match, sourceName) {
  const name = String(sourceName || '').toLowerCase();
  const urls = new Set();
  for (const stream of match?.streams || []) {
    if (String(stream?.source || '').toLowerCase() !== name) continue;
    const url = String(stream?.url || '')
      .trim()
      .split('#')[0]
      .toLowerCase();
    if (url) urls.add(url);
  }
  return urls;
}

function sourceNeedsMorePlayerStreams(match, sourceName) {
  if (!match) return false;
  const urls = uniqueSourceStreamUrls(match, sourceName);
  if (!urls.size) return false;
  return urls.size < maxPlayerStreams();
}

function normalizeSourceStatus(status) {
  if (!status || status === 'PENDING') return STREAM_SOURCE_STATUS.PREPARING;
  return status;
}

function readSourceExtractState(streamSearch, sourceName) {
  const raw = streamSearch?.sources?.[sourceName] || {};
  return {
    status: normalizeSourceStatus(raw.status),
    attempts: Number(raw.attempts) || 0,
    postKickoffAttempts: Number(raw.postKickoffAttempts) || 0,
    lastError: raw.lastError || null,
    lastAttemptAt: raw.lastAttemptAt || null,
    updatedAt: raw.updatedAt || null,
    slotsDone: { ...(raw.slotsDone || {}) },
    extractionMethod: raw.extractionMethod || null,
  };
}

/**
 * Decide whether to extract a stream from a confirmed Match URL for one source.
 * Runs from −30m through +10m. AVAILABLE / permanent FAILED / +15 stop /
 * missing Match URL / same slot → skip.
 */
function decideSourceExtract({
  sourceName,
  streamSearch,
  matchUrlState,
  slot = null,
  stopped = false,
  force = false,
  match = null,
} = {}) {
  const st = readSourceExtractState(streamSearch, sourceName);
  const missingOwnStream =
    match != null && !sourceHasValidatedStream(match, sourceName);
  const needsMorePlayers = sourceNeedsMorePlayerStreams(match, sourceName);

  if (stopped && !needsMorePlayers) {
    return { skip: true, reason: 'stopped', status: st.status };
  }

  if (st.status === STREAM_SOURCE_STATUS.AVAILABLE && !missingOwnStream && !needsMorePlayers) {
    return { skip: true, reason: 'already_available', status: st.status };
  }

  if (
    st.status === STREAM_SOURCE_STATUS.FAILED &&
    st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS
  ) {
    return { skip: true, reason: 'already_failed', status: st.status };
  }

  if (slot?.postKickoff && st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS) {
    return {
      skip: true,
      reason: 'already_failed',
      status: STREAM_SOURCE_STATUS.FAILED,
      markFailed: true,
    };
  }

  if (!force && slot?.id && st.slotsDone[slot.id] && !missingOwnStream && !needsMorePlayers) {
    return { skip: true, reason: 'duplicate_attempt', status: st.status };
  }

  if (!matchUrlState?.matchUrl || !sourceHasSavedMatchUrl(matchUrlState)) {
    return { skip: true, reason: 'no_confirmed_match_url', status: st.status };
  }

  return {
    skip: false,
    reason: 'extract',
    matchUrl: matchUrlState.matchUrl,
    status: STREAM_SOURCE_STATUS.SEARCHING,
  };
}

function nextSourceStateAfterAttempt({
  previous = {},
  slot = null,
  validatedStreams = [],
  error = null,
  extractionMethod = null,
  nowIso = new Date().toISOString(),
} = {}) {
  const attempts = (Number(previous.attempts) || 0) + 1;
  const postKickoffAttempts =
    (Number(previous.postKickoffAttempts) || 0) + (slot?.postKickoff ? 1 : 0);
  const slotsDone = { ...(previous.slotsDone || {}) };
  if (slot?.id) slotsDone[slot.id] = true;

  if (validatedStreams?.length) {
    return {
      status: STREAM_SOURCE_STATUS.AVAILABLE,
      attempts,
      postKickoffAttempts,
      lastError: null,
      lastAttemptAt: nowIso,
      updatedAt: nowIso,
      slotsDone,
      extractionMethod: extractionMethod || previous.extractionMethod || null,
    };
  }

  const exhausted =
    Boolean(slot?.postKickoff) && postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS;

  return {
    status: exhausted ? STREAM_SOURCE_STATUS.FAILED : STREAM_SOURCE_STATUS.SEARCHING,
    attempts,
    postKickoffAttempts,
    lastError: normalizeExtractError(error || 'NOT_FOUND'),
    lastAttemptAt: nowIso,
    updatedAt: nowIso,
    slotsDone,
    extractionMethod: extractionMethod || previous.extractionMethod || null,
  };
}

function aggregateStreamStatus(
  streamSearch,
  { hasValidatedStream = false, stopped = false, mins = null } = {}
) {
  if (hasValidatedStream) return STREAM_SOURCE_STATUS.AVAILABLE;

  const sources = Object.values(streamSearch?.sources || {});
  if (sources.some((s) => s.status === STREAM_SOURCE_STATUS.AVAILABLE)) {
    return STREAM_SOURCE_STATUS.AVAILABLE;
  }
  if (sources.some((s) => s.status === STREAM_SOURCE_STATUS.SEARCHING)) {
    return STREAM_SOURCE_STATUS.SEARCHING;
  }

  const named = sources.filter((s) => s && s.status);
  if (
    named.length &&
    named.every((s) => s.status === STREAM_SOURCE_STATUS.FAILED)
  ) {
    return STREAM_SOURCE_STATUS.FAILED;
  }

  if (stopped) {
    // Started search with no playable stream (including empty sources after
    // Match URL failure) is FAILED, not PREPARING.
    if (named.length || streamSearch?.started) return STREAM_SOURCE_STATUS.FAILED;
    return STREAM_SOURCE_STATUS.PREPARING;
  }

  if (mins != null && mins <= 0) return STREAM_SOURCE_STATUS.SEARCHING;
  return STREAM_SOURCE_STATUS.PREPARING;
}

function firstValidatedStreamUrl(match) {
  const hit = firstClientStream(match);
  return hit?.url || null;
}

function firstValidatedStreamHeaders(match) {
  const hit = firstClientStream(match);
  if (!hit) return null;
  return hit.streamHeaders || hit.headers || null;
}

function firstClientStream(match) {
  const validated = (match?.streams || []).find((s) => isValidatedStream(s));
  if (validated) return validated;
  if (String(match?.streamStatus || '') !== STREAM_SOURCE_STATUS.AVAILABLE) return null;
  return (match?.streams || []).find((s) => s?.url && s.active !== false) || null;
}

function latestSourceExtractState(streamSearch) {
  let latest = null;
  for (const src of Object.values(streamSearch?.sources || {})) {
    if (!src) continue;
    if (!latest || String(src.lastAttemptAt || '') > String(latest.lastAttemptAt || '')) {
      latest = src;
    }
  }
  return latest;
}

function maxSourceAttempts(streamSearch) {
  let max = 0;
  for (const src of Object.values(streamSearch?.sources || {})) {
    const n = Number(src?.postKickoffAttempts || src?.attempts || 0);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Keep validationStatus separate from streamStatus.
 * AVAILABLE streamStatus requires validation.ok === true.
 */
function aggregateValidationFields(match, streamStatus) {
  if ((match?.streams || []).some((s) => isValidatedStream(s))) {
    const hit = (match.streams || []).find((s) => isValidatedStream(s));
    return {
      validationStatus: STREAM_SOURCE_STATUS.AVAILABLE,
      validationReason: null,
    };
  }

  const latest = latestSourceExtractState(match?.streamSearch);
  const lastError = normalizeValidationReason(latest?.lastError);

  if (streamStatus === STREAM_SOURCE_STATUS.SEARCHING) {
    const hideStatus = ['BROWSER_ERROR', 'NOT_FOUND', 'TIMEOUT', 'INVALID'];
    return {
      validationStatus: hideStatus.includes(lastError) ? 'VALIDATING' : lastError || 'VALIDATING',
      validationReason: lastError,
    };
  }
  if (streamStatus === STREAM_SOURCE_STATUS.FAILED) {
    return {
      validationStatus: lastError || STREAM_SOURCE_STATUS.FAILED,
      validationReason: lastError || STREAM_SOURCE_STATUS.FAILED,
    };
  }
  return {
    validationStatus: null,
    validationReason: null,
  };
}

function shouldAbortExtract(kickoff, streamSearch, nowSec) {
  return isStreamSearchStopped(kickoff, streamSearch, nowSec);
}

module.exports = {
  STREAM_SOURCE_STATUS,
  MAX_POST_KICKOFF_ATTEMPTS,
  VALIDATION_REASON,
  extractJobKey,
  isValidatedStream,
  sourceHasValidatedStream,
  uniqueSourceStreamUrls,
  sourceNeedsMorePlayerStreams,
  normalizeSourceStatus,
  readSourceExtractState,
  decideSourceExtract,
  nextSourceStateAfterAttempt,
  aggregateStreamStatus,
  firstValidatedStreamUrl,
  firstValidatedStreamHeaders,
  firstClientStream,
  latestSourceExtractState,
  maxSourceAttempts,
  aggregateValidationFields,
  normalizeValidationReason,
  isKnownValidationReason,
  isBrowserProtocolError,
  normalizeExtractError,
  shouldAbortExtract,
};
