const { DEFAULT_UA } = require('../browser/puppeteerManager');

const PLAYBACK_UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const PLAYBACK_HEADER_NAMES = new Set([
  'User-Agent',
  'Referer',
  'Origin',
  'Cookie',
  'Accept',
]);

const CANONICAL_HEADER_NAMES = {
  'user-agent': 'User-Agent',
  referer: 'Referer',
  origin: 'Origin',
  cookie: 'Cookie',
  accept: 'Accept',
};

const SENSITIVE_HEADER_RE = /cookie|auth|token|set-cookie|authorization|api[-_]?key/i;

function canonicalizeHeaderName(name) {
  const key = String(name || '').toLowerCase();
  return CANONICAL_HEADER_NAMES[key] || name;
}

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function pickPlaybackHeaders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = canonicalizeHeaderName(key);
    if (!PLAYBACK_HEADER_NAMES.has(name)) continue;
    if (isBlank(value)) continue;
    out[name] = String(value);
  }
  return out;
}

function originFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function sourceDomainReferer(sourceConfig = {}) {
  const domain = Array.isArray(sourceConfig.domains) ? sourceConfig.domains[0] : '';
  if (!domain) return '';
  try {
    const parsed = new URL(domain);
    return `${parsed.origin}/`;
  } catch {
    return String(domain);
  }
}

/**
 * Source playback headers. Prefer dedicated playbackHeaders; otherwise reuse
 * existing source.headers for playback-relevant keys only.
 */
function sourcePlaybackHeaders(sourceConfig = {}) {
  const playback = pickPlaybackHeaders(sourceConfig.playbackHeaders);
  if (Object.keys(playback).length) return playback;
  return pickPlaybackHeaders(sourceConfig.headers);
}

function isDefaultUserAgent(ua) {
  const value = String(ua || '');
  if (!value) return true;
  if (value === DEFAULT_UA) return true;
  if (process.env.USER_AGENT && value === process.env.USER_AGENT) return true;
  return false;
}

function globalDefaultHeaders() {
  return {
    Accept: '*/*',
    'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
  };
}

/**
 * Merge playback headers:
 *   stream-specific → source-specific → global/default
 *
 * Guessed match-page Referer / default desktop UA do not override configured
 * source playback headers. A distinct captured Referer (embed/CDN) does.
 */
function mergePlaybackHeaders({
  streamHeaders,
  sourceConfig = {},
  matchPageUrl = '',
} = {}) {
  const merged = { ...globalDefaultHeaders() };
  if (matchPageUrl) merged.Referer = String(matchPageUrl);

  const source = sourcePlaybackHeaders(sourceConfig);
  Object.assign(merged, source);

  const stream = pickPlaybackHeaders(streamHeaders);
  for (const [name, value] of Object.entries(stream)) {
    if (isBlank(value)) continue;
    if (name === 'User-Agent' && source['User-Agent'] && isDefaultUserAgent(value)) {
      continue;
    }
    if (
      name === 'Referer' &&
      source.Referer &&
      matchPageUrl &&
      String(value) === String(matchPageUrl)
    ) {
      continue;
    }
    merged[name] = value;
  }

  return merged;
}

function sourceOnlyPlaybackHeaders(sourceConfig = {}, matchPageUrl = '') {
  return mergePlaybackHeaders({
    streamHeaders: {},
    sourceConfig,
    matchPageUrl: sourcePlaybackHeaders(sourceConfig).Referer || matchPageUrl,
  });
}

function playbackHeadersForClient(headers) {
  const picked = pickPlaybackHeaders(headers);
  delete picked.Accept;
  return picked;
}

function headerPresence(headers, name) {
  const value = headers?.[name];
  return isBlank(value) ? 'none' : 'configured';
}

function redactHeadersForLog(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADER_RE.test(key) || SENSITIVE_HEADER_RE.test(String(value || ''))) {
      out[key] = isBlank(value) ? 'none' : 'configured';
      continue;
    }
    if (['User-Agent', 'Referer', 'Origin'].includes(canonicalizeHeaderName(key))) {
      out[key] = isBlank(value) ? 'none' : 'configured';
      continue;
    }
    out[key] = isBlank(value) ? 'none' : 'configured';
  }
  return out;
}

function headersEqual(a, b) {
  const left = pickPlaybackHeaders(a);
  const right = pickPlaybackHeaders(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (String(left[key] || '') !== String(right[key] || '')) return false;
  }
  return true;
}

function containsSensitive(value) {
  return SENSITIVE_HEADER_RE.test(String(value || ''));
}

module.exports = {
  PLAYBACK_UA_MOBILE,
  PLAYBACK_HEADER_NAMES,
  pickPlaybackHeaders,
  sourcePlaybackHeaders,
  sourceDomainReferer,
  mergePlaybackHeaders,
  sourceOnlyPlaybackHeaders,
  playbackHeadersForClient,
  headerPresence,
  redactHeadersForLog,
  headersEqual,
  originFromUrl,
  containsSensitive,
  canonicalizeHeaderName,
};
