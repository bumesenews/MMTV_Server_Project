const { STREAM_SEARCH_INTERVAL_MINUTES } = require('../../utils/time');

function looksLikeM3u8(url) {
  return /\.m3u8(\?|#|$)/i.test(String(url || '').trim());
}

function hostOf(url) {
  try {
    return new URL(String(url || '').trim()).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function sourceHosts(config = {}) {
  const hosts = [];
  for (const d of [].concat(config.domains || [], config.mirrorDomains || [])) {
    const raw = String(d || '').trim();
    if (!raw) continue;
    const host = hostOf(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (host) hosts.push(host);
  }
  return hosts;
}

function hostMatches(pageHost, sourceHost) {
  if (!pageHost || !sourceHost) return false;
  return pageHost === sourceHost || pageHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${pageHost}`);
}

function resolveSourceFromUrl(sources, matchUrl, preferredName) {
  const list = Array.isArray(sources) ? sources : [];
  const pref = String(preferredName || '').trim().toLowerCase();
  if (pref && pref !== 'auto') {
    const named = list.find((s) => String(s.name || '').toLowerCase() === pref);
    if (named) return named;
  }
  const host = hostOf(matchUrl);
  if (host) {
    const hit = list.find((s) =>
      sourceHosts(s.config || s).some((h) => hostMatches(host, h))
    );
    if (hit) return hit;
  }
  return list[0] || null;
}

function extractCooldownMs() {
  return Math.max(1, Number(STREAM_SEARCH_INTERVAL_MINUTES) || 5) * 60 * 1000;
}

function needsMainLiveExtract(match, { force = false } = {}) {
  if (!match) return false;
  const url = String(match.matchUrl || '').trim();
  if (!url) return false;
  if (String(match.status || '') === 'END') return false;
  if (looksLikeM3u8(url)) {
    const hasUrl = (match.streams || []).some((s) => String(s.url || '').trim() === url);
    return !hasUrl;
  }
  const hasAuto = (match.streams || []).some((s) => {
    const src = String(s.source || '').toLowerCase();
    return src && src !== 'manual';
  });
  if (hasAuto && !force) return false;
  if (force) return true;
  const at = Date.parse(match.matchUrlExtractAt || '');
  if (Number.isFinite(at) && Date.now() - at < extractCooldownMs()) {
    return match.matchUrlStatus === 'SEARCHING';
  }
  return true;
}

module.exports = {
  looksLikeM3u8,
  hostOf,
  resolveSourceFromUrl,
  needsMainLiveExtract,
};
