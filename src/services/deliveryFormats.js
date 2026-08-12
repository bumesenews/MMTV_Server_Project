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
  buildDeliveryBundle,
};
