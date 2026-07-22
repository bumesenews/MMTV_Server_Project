const { nowYangon } = require('../utils/time');
const { hashPayload, sanitizeForCompare } = require('../utils/compare');
const { enrichMatchState } = require('./statusService');

/**
 * Generate Flutter-facing JSON payload.
 * Includes live matches + highlights + Myanmar TV channels.
 */
function generateFlutterJson(matches, meta = {}, extras = {}) {
  const cleanedMatches = (matches || []).map((raw) => {
    // Status from fixture kickoff time (Scheduled / LIVE / END@+120m)
    const m = enrichMatchState(raw);
    return {
    matchId: m.matchId,
    league: m.league,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    homeTeamId: m.homeTeamId || null,
    awayTeamId: m.awayTeamId || null,
    homeLogo: m.homeLogo || null,
    awayLogo: m.awayLogo || null,
    date: m.date,
    time: m.time,
    kickoff: m.kickoff,
    timezone: m.timezone || 'Asia/Yangon',
    status: m.status || 'Scheduled',
    pinned: Boolean(m.pinned),
    featured: Boolean(m.featured),
    hasStreams: Boolean(m.hasStreams),
    streamCount: m.streamCount || 0,
    originalNames: m.originalNames || {},
    sourcePages: m.sourcePages || {},
    streams: (m.streams || [])
      .filter((s) => s && s.url)
      .map((s) => ({
        source: s.source,
        type: s.type || 'm3u8',
        quality: s.quality || 'HD',
        url: s.url,
        headers: {
          'User-Agent': s.headers?.['User-Agent'] || '',
          Referer: s.headers?.Referer || '',
          ...(s.headers?.Cookie ? { Cookie: s.headers.Cookie } : {}),
        },
        active: Boolean(s.active),
        checkedAt: s.checkedAt || null,
        ...(s.manualId ? { manualId: s.manualId } : {}),
      })),
    streamAttempts: m.streamAttempts || {},
    updatedAt: m.updatedAt || new Date().toISOString(),
  };
  });

  const highlights = (extras.highlights || meta.highlights || []).map((h) => ({
    id: h.id,
    title: h.title,
    img: h.img || null,
    url: h.url || null,
    matchDate: h.matchDate || null,
    embedUrl: h.embedUrl || null,
    m3u8: h.m3u8 || null,
    headers: h.headers || null,
    source: h.source || 'highlight',
  }));

  const channels = (extras.channels || meta.channels || []).map((c) => ({
    title: c.title,
    img: c.img || null,
    pageUrl: c.pageUrl || c.url || null,
    streamUrl: c.streamUrl || '',
    headers: c.headers || null,
    active: Boolean(c.active ?? c.streamUrl),
    source: c.source || 'myanmartv',
  }));

  const payload = {
    version: 1,
    generatedAt: nowYangon().toISO(),
    timezone: 'Asia/Yangon',
    matchCount: cleanedMatches.length,
    matches: cleanedMatches,
    highlights,
    highlightCount: highlights.length,
    channels,
    channelCount: channels.length,
    meta: {
      ...meta,
      liveCount: cleanedMatches.filter((m) => m.status === 'LIVE').length,
      scheduledCount: cleanedMatches.filter((m) => m.status === 'Scheduled').length,
      endedCount: cleanedMatches.filter((m) => m.status === 'END').length,
      manualStreamCount: cleanedMatches.reduce(
        (n, m) => n + (m.streams || []).filter((s) => s.source === 'manual').length,
        0
      ),
      highlightCount: highlights.length,
      channelCount: channels.length,
    },
  };

  // Avoid nesting bulky arrays twice in meta
  delete payload.meta.highlights;
  delete payload.meta.channels;

  payload.meta.checksum = hashPayload(sanitizeForCompare(payload));
  return payload;
}

module.exports = { generateFlutterJson };
