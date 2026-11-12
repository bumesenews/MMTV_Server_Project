const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { isDirectMediaUrl } = require('../sources/highlightMedia');
const {
  StreamValidator,
  VALIDATION_STATE,
  parseHlsPlaylist,
} = require('./streamValidator');

const INTERVAL_DAYS = 2;
const PLAYLIST_MAX_BYTES = 512 * 1024;

function playbackStateFile() {
  return path.resolve(
    process.cwd(),
    process.env.HIGHLIGHT_PLAYBACK_STATE_PATH || './data/schedule/highlight-playback.json'
  );
}

function playbackIntervalDays(env = process.env) {
  const days = Number(env.HIGHLIGHT_PLAYBACK_INTERVAL_DAYS || INTERVAL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : INTERVAL_DAYS;
}

function readPlaybackState(file = playbackStateFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePlaybackState(state, file = playbackStateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

function markPlaybackChecked(meta = {}, when = new Date()) {
  const file = playbackStateFile();
  const prev = readPlaybackState(file);
  writePlaybackState(
    {
      ...prev,
      lastCheckedAt: (when instanceof Date ? when : new Date(when)).toISOString(),
      removed: Number(meta.removed) || 0,
      kept: Number(meta.kept) || 0,
    },
    file
  );
}

/**
 * True when no check has completed, or the last one is at least `intervalDays` old.
 * @param {string|null|undefined} lastCheckedAt
 * @param {Date|import('luxon').DateTime|string|number|null} [now]
 */
function isHighlightPlaybackDue(lastCheckedAt, now = null, intervalDays = playbackIntervalDays()) {
  if (!lastCheckedAt) return true;
  const last = DateTime.fromISO(String(lastCheckedAt));
  if (!last.isValid) return true;
  let current;
  if (now == null) current = DateTime.now();
  else if (DateTime.isDateTime(now)) current = now;
  else if (now instanceof Date) current = DateTime.fromJSDate(now);
  else if (typeof now === 'number') current = DateTime.fromMillis(now);
  else current = DateTime.fromISO(String(now));
  if (!current.isValid) return true;
  const elapsedMs = current.toMillis() - last.toMillis();
  return elapsedMs >= intervalDays * 24 * 60 * 60 * 1000;
}

/**
 * remove = the stored video cannot be played.
 * keep = playable, or the failure is temporary (timeout, 401/403, 5xx).
 */
function playbackDecision(validation) {
  const state = validation?.state;
  if (state === VALIDATION_STATE.AVAILABLE) return 'keep';
  if (
    state === VALIDATION_STATE.HTTP_404 ||
    state === VALIDATION_STATE.HTTP_410 ||
    state === VALIDATION_STATE.NOT_HLS ||
    state === VALIDATION_STATE.EMPTY_PLAYLIST ||
    state === VALIDATION_STATE.NO_SEGMENTS
  ) {
    return 'remove';
  }
  const status = Number(validation?.statusCode || 0);
  if (status === 404 || status === 410) return 'remove';
  if (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 429
  ) {
    return 'remove';
  }
  return 'keep';
}

function mediaUrlOf(highlight) {
  return isDirectMediaUrl(highlight?.m3u8) || '';
}

function validationFromStatus(status, reason) {
  if (status === 200 || status === 206) {
    return { state: VALIDATION_STATE.AVAILABLE, statusCode: status, reason: reason || 'ok' };
  }
  if (status === 401) {
    return { state: VALIDATION_STATE.HTTP_401, statusCode: status, reason: 'http_401' };
  }
  if (status === 403) {
    return { state: VALIDATION_STATE.HTTP_403, statusCode: status, reason: 'http_403' };
  }
  if (status === 404) {
    return { state: VALIDATION_STATE.HTTP_404, statusCode: status, reason: 'http_404' };
  }
  if (status === 410) {
    return { state: VALIDATION_STATE.HTTP_410, statusCode: status, reason: 'http_410' };
  }
  return {
    state: VALIDATION_STATE.INVALID,
    statusCode: status || null,
    reason: reason || (status ? `http_${status}` : 'fetch_failed'),
  };
}

function isTransientFetchError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    /timeout|maxContentLength|maxBodyLength/i.test(message)
  );
}

async function probeBytes(http, url, headers, timeout) {
  try {
    const response = await http.get(url, {
      timeout,
      headers: { ...(headers || {}), Range: 'bytes=0-1023' },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      maxContentLength: 64 * 1024,
      maxBodyLength: 64 * 1024,
    });
    return validationFromStatus(Number(response?.status));
  } catch (err) {
    if (isTransientFetchError(err)) {
      return { state: VALIDATION_STATE.TIMEOUT, statusCode: null, reason: 'timeout' };
    }
    return { state: VALIDATION_STATE.INVALID, statusCode: null, reason: 'fetch_failed' };
  }
}

async function fetchPlaylistText(http, url, headers, timeout) {
  const response = await http.get(url, {
    timeout,
    headers: headers || {},
    responseType: 'text',
    maxRedirects: 5,
    validateStatus: () => true,
    maxContentLength: PLAYLIST_MAX_BYTES,
    maxBodyLength: PLAYLIST_MAX_BYTES,
  });
  return {
    status: Number(response?.status),
    body: String(response?.data || ''),
  };
}

/**
 * A playlist can list segments that the CDN has already deleted.
 * Only 404/410 on the first segment counts as unplayable.
 */
async function probeFirstSegment(http, playlistUrl, headers, timeout) {
  const playlist = await fetchPlaylistText(http, playlistUrl, headers, timeout);
  if (playlist.status === 404 || playlist.status === 410) {
    return validationFromStatus(playlist.status);
  }
  if (playlist.status < 200 || playlist.status >= 400) return null;
  const parsed = parseHlsPlaylist(playlist.body, playlistUrl);
  let segmentUrl = parsed.kind === 'media' ? parsed.segments[0] : '';
  if (!segmentUrl && parsed.kind === 'master' && parsed.variants[0]) {
    const variant = await fetchPlaylistText(http, parsed.variants[0], headers, timeout);
    if (variant.status === 404 || variant.status === 410) {
      return validationFromStatus(variant.status);
    }
    if (variant.status < 200 || variant.status >= 400) return null;
    const media = parseHlsPlaylist(variant.body, parsed.variants[0]);
    segmentUrl = media.segments[0] || '';
  }
  if (!segmentUrl) return null;
  return probeBytes(http, segmentUrl, headers, timeout);
}

/**
 * @returns {Promise<{ remove: boolean, reason: string, state: string|null }>}
 */
async function checkHighlightPlayable(highlight, options = {}) {
  const url = mediaUrlOf(highlight);
  if (!url) {
    return { remove: true, reason: 'no_media', state: null };
  }

  const timeout = Number(options.timeout || process.env.HIGHLIGHT_PLAYBACK_TIMEOUT_MS || 12000);
  const http = options.http || require('axios');
  const headers = highlight?.headers && typeof highlight.headers === 'object' ? highlight.headers : {};
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { remove: true, reason: 'invalid_url', state: VALIDATION_STATE.INVALID };
  }

  if (/\.mp4$/i.test(pathname)) {
    const validation = await probeBytes(http, url, headers, timeout);
    const decision = playbackDecision(validation);
    return {
      remove: decision === 'remove',
      reason: validation.reason || validation.state,
      state: validation.state,
    };
  }

  const validator =
    options.validator ||
    new StreamValidator({
      http,
      timeout,
      resolveMasterVariant: true,
    });

  let result;
  try {
    result = await validator.validate({
      url,
      headers,
      source: highlight.source || 'highlight',
      embedUrl: highlight.embed_url || highlight.embedUrl || null,
      keepPlaybackHeaders: true,
    });
  } catch (err) {
    return { remove: false, reason: 'check_failed', state: VALIDATION_STATE.TIMEOUT };
  }

  const validation = result?.validation || {};
  if (playbackDecision(validation) === 'remove') {
    return {
      remove: true,
      reason: validation.reason || validation.state,
      state: validation.state,
    };
  }

  if (options.probeSegments !== false && validation.state === VALIDATION_STATE.AVAILABLE) {
    try {
      const segment = await probeFirstSegment(
        http,
        url,
        result.headers || headers,
        timeout
      );
      if (segment && playbackDecision(segment) === 'remove') {
        return {
          remove: true,
          reason: segment.reason || 'segment_dead',
          state: segment.state,
        };
      }
    } catch (err) {
      if (!isTransientFetchError(err)) {
        return { remove: false, reason: 'segment_check_failed', state: validation.state };
      }
    }
  }

  return {
    remove: false,
    reason: validation.reason || 'ok',
    state: validation.state || null,
  };
}

module.exports = {
  INTERVAL_DAYS,
  playbackIntervalDays,
  readPlaybackState,
  markPlaybackChecked,
  isHighlightPlaybackDue,
  playbackDecision,
  checkHighlightPlayable,
  mediaUrlOf,
};
