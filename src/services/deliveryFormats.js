const { nowYangon } = require('../utils/time');
const { hashPayload, sanitizeForCompare } = require('../utils/compare');

/**
 * Split Flutter delivery feeds:
 * - mainlive.json → admin-managed MainLive feed (separate from scraper)
 * - matches.json  → scraped fixtures + merged streams (FotMob, etc.)
 * - highlight.json
 * - myanmartv.json (channels array)
 */

/**
 * Scraped matches feed — matches only (no highlights/channels nested).
 */
function formatMatchesDelivery(matchesPayload) {
  const matches = matchesPayload?.matches || [];
  const payload = {
    version: matchesPayload?.version || 1,
    generatedAt: matchesPayload?.generatedAt || nowYangon().toISO(),
    timezone: 'Asia/Yangon',
    matchCount: matches.length,
    matches,
    meta: {
      ...(matchesPayload?.meta || {}),
      feed: 'matches',
      liveCount: matches.filter((m) => m.status === 'LIVE').length,
      scheduledCount: matches.filter((m) => m.status === 'Scheduled').length,
      endedCount: matches.filter((m) => m.status === 'END').length,
    },
  };
  payload.meta.checksum = hashPayload(sanitizeForCompare(payload));
  return payload;
}

/**
 * Admin MainLive feed — same JSON shape as matches.json, separate file.
 */
function formatMainLiveDelivery(matchesPayload) {
  const matches = matchesPayload?.matches || [];
  const payload = {
    version: matchesPayload?.version || 1,
    generatedAt: matchesPayload?.generatedAt || nowYangon().toISO(),
    timezone: 'Asia/Yangon',
    matchCount: matches.length,
    matches,
    meta: {
      ...(matchesPayload?.meta || {}),
      feed: 'mainlive',
      source: matchesPayload?.meta?.source || 'admin',
      liveCount: matches.filter((m) => m.status === 'LIVE').length,
      scheduledCount: matches.filter((m) => m.status === 'Scheduled').length,
      endedCount: matches.filter((m) => m.status === 'END').length,
    },
  };
  payload.meta.checksum = hashPayload(sanitizeForCompare(payload));
  return payload;
}

/**
 * Highlights feed (MM_TV.Pro highlight.json shape).
 */
function formatHighlightsDelivery(highlights = [], meta = {}) {
  const list = (highlights || []).map((h) => ({
    id: h.id || null,
    title: h.title || '',
    img: h.img || null,
    url: h.url || null,
    match_date: h.match_date || h.matchDate || null,
    embed_url: h.embed_url || h.embedUrl || null,
    m3u8: h.m3u8 || null,
    headers: h.headers || null,
    source: h.source || 'highlight',
  }));

  return {
    source: meta.source || 'https://hoofoot.com/',
    scraped_at: meta.scraped_at || new Date().toISOString(),
    count: list.length,
    highlights: list,
  };
}

/**
 * Myanmar TV channels — plain array [{ title, img, streamUrl }].
 */
function formatChannelsDelivery(channels = []) {
  return (channels || []).map((c) => ({
    title: c.title || '',
    img: c.img || null,
    streamUrl: c.streamUrl || '',
  }));
}

function mapTipRow(tip = {}) {
  return {
    id: tip.id || null,
    day: tip.day || null,
    date: tip.date || null,
    league: tip.league || null,
    homeTeam: tip.homeTeam || '',
    awayTeam: tip.awayTeam || '',
    match: tip.match || `${tip.homeTeam || ''} v ${tip.awayTeam || ''}`.trim(),
    prediction: tip.prediction || '',
    predictionSide: tip.predictionSide || null,
    odds: {
      home: tip.odds?.home ?? null,
      draw: tip.odds?.draw ?? null,
      away: tip.odds?.away ?? null,
    },
    homeForm: Array.isArray(tip.homeForm) ? tip.homeForm : [],
    awayForm: Array.isArray(tip.awayForm) ? tip.awayForm : [],
    url: tip.url || null,
  };
}

function formatDayTips(dayPayload = {}, fallbackDay = 'today') {
  const tips = (dayPayload.tips || []).map(mapTipRow);
  return {
    day: dayPayload.day || fallbackDay,
    date: dayPayload.date || null,
    label: dayPayload.label || (fallbackDay === 'tomorrow' ? "Tomorrow's Tips" : "Today's Tips"),
    pageUrl: dayPayload.pageUrl || null,
    count: tips.length,
    tips,
  };
}

/**
 * PredictZ today + tomorrow tips feed.
 */
function formatTipsDelivery(payload = {}) {
  const today = formatDayTips(payload.today, 'today');
  const tomorrow = formatDayTips(payload.tomorrow, 'tomorrow');
  return {
    source: payload.source || 'https://www.predictz.com/',
    scraped_at: payload.scraped_at || new Date().toISOString(),
    timezone: payload.timezone || 'Asia/Yangon',
    today,
    tomorrow,
    count: today.count + tomorrow.count,
  };
}

/**
 * Build scraper delivery files from pipeline outputs.
 * mainlive.json is admin-owned and omitted here so publish does not overwrite it.
 */
function buildDeliveryBundle({ matchesPayload, highlights, channels }) {
  return {
    matches: formatMatchesDelivery(matchesPayload),
    highlight: formatHighlightsDelivery(highlights || []),
    myanmartv: formatChannelsDelivery(channels || []),
  };
}

module.exports = {
  formatMatchesDelivery,
  formatMainLiveDelivery,
  formatHighlightsDelivery,
  formatChannelsDelivery,
  formatTipsDelivery,
  buildDeliveryBundle,
};
