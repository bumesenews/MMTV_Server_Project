const { minutesUntilKickoff, nowUtcUnixSeconds } = require('../../utils/time');

/** First MainLive m3u8 search opens this many minutes before kickoff. */
const MAINLIVE_EXTRACT_LEAD_MIN = 30;
/** If that search finds nothing, try once more after this many minutes. */
const MAINLIVE_EXTRACT_RETRY_MIN = 15;
const MAINLIVE_EXTRACT_MAX_ATTEMPTS = 2;

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

function hasAutomaticStream(match) {
  return (match?.streams || []).some((s) => {
    const src = String(s.source || '').toLowerCase();
    return src && src !== 'manual';
  });
}

/**
 * Page Match URLs: first search at kickoff−30, one more search 15 minutes
 * after that attempt if it found nothing. A pasted .m3u8 is stored immediately.
 */
function matchUrlEntries(match) {
  const rows = [];
  const push = (row, fallback = {}) => {
    const url = String(
      typeof row === 'string' ? row : row?.url || row?.matchUrl || ''
    ).trim();
    if (!url || rows.some((item) => item.url === url)) return;
    rows.push({
      url,
      source: String(row?.source || row?.matchUrlSource || fallback.source || '').trim() || null,
      status: row?.status || fallback.status || null,
      error: row?.error || fallback.error || null,
      attempts: Number(row?.attempts ?? fallback.attempts) || 0,
      extractedAt: row?.extractedAt || fallback.extractedAt || null,
    });
  };
  if (Array.isArray(match?.matchUrls)) {
    for (const row of match.matchUrls) push(row);
  }
  const primary = String(match?.matchUrl || '').trim();
  if (primary && !rows.some((item) => item.url === primary)) {
    rows.unshift({
      url: primary,
      source: match?.matchUrlSource || null,
      status: match?.matchUrlStatus || null,
      error: match?.matchUrlExtractError || null,
      attempts: Number(match?.matchUrlExtractAttempts) || 0,
      extractedAt: match?.matchUrlExtractAt || null,
    });
  }
  return rows;
}

function urlExtractPlan(match, entry, { force = false, nowSec = nowUtcUnixSeconds() } = {}) {
  if (!match) return { due: false, reason: 'no_match' };
  const url = String(entry?.url || '').trim();
  if (!url) return { due: false, reason: 'no_match_url' };
  if (String(match.status || '') === 'END') return { due: false, reason: 'ended' };
  if (looksLikeM3u8(url)) {
    const hasUrl = (match.streams || []).some((s) => String(s.url || '').trim() === url);
    return hasUrl
      ? { due: false, reason: 'already_m3u8' }
      : { due: true, reason: 'already_m3u8' };
  }
  const listed = Array.isArray(match.matchUrls) ? match.matchUrls.length : 0;
  const single = listed <= 1;
  if (single && hasAutomaticStream(match) && !force) return { due: false, reason: 'found' };
  if (!single && String(entry.status || '') === 'AVAILABLE' && !force) {
    return { due: false, reason: 'found' };
  }

  const mins = minutesUntilKickoff(match.kickoff, nowSec);
  if (mins == null || mins > MAINLIVE_EXTRACT_LEAD_MIN) {
    return { due: false, reason: 'before_lead' };
  }
  if (force) return { due: true, reason: 'force' };

  const attempts = single
    ? Number(match.matchUrlExtractAttempts) || Number(entry.attempts) || 0
    : Number(entry.attempts) || 0;
  if (attempts <= 0) return { due: true, reason: 'lead' };
  if (attempts >= MAINLIVE_EXTRACT_MAX_ATTEMPTS) {
    return { due: false, reason: 'attempts_done' };
  }
  const at = Date.parse((single ? match.matchUrlExtractAt : entry.extractedAt) || '');
  if (!Number.isFinite(at)) return { due: true, reason: 'retry' };
  const waitedMs = nowSec * 1000 - at;
  if (waitedMs < MAINLIVE_EXTRACT_RETRY_MIN * 60 * 1000) {
    return { due: false, reason: 'retry_wait' };
  }
  return { due: true, reason: 'retry' };
}

function mainLiveExtractPlan(match, options = {}) {
  const entries = matchUrlEntries(match);
  if (!entries.length) return { due: false, reason: 'no_match_url' };
  let blocked = null;
  for (const entry of entries) {
    const plan = urlExtractPlan(match, entry, options);
    if (plan.due) return { ...plan, url: entry.url };
    if (!blocked) blocked = plan;
  }
  return blocked || { due: false, reason: 'no_match_url' };
}

function needsMainLiveExtract(match, options) {
  return mainLiveExtractPlan(match, options).due;
}

module.exports = {
  looksLikeM3u8,
  hostOf,
  resolveSourceFromUrl,
  matchUrlEntries,
  urlExtractPlan,
  mainLiveExtractPlan,
  needsMainLiveExtract,
  MAINLIVE_EXTRACT_LEAD_MIN,
  MAINLIVE_EXTRACT_RETRY_MIN,
  MAINLIVE_EXTRACT_MAX_ATTEMPTS,
};
