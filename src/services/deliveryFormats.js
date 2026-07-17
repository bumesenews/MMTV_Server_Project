const { nowYangon } = require('../utils/time');
const { hashPayload, sanitizeForCompare } = require('../utils/compare');

/**
 * Split Flutter delivery feeds (MM_TV.Pro / existing raw GitHub shapes):
 * - matches.json  → main live (FotMob + merged streams)
 * - soco.json     → { leagues: [...] } like pkutoelay-alt/soco
 * - highlight.json
 * - myanmartv.json (channels array)
 */

function formatMonth(kickoffIsoOrUnix) {
  const d = toDate(kickoffIsoOrUnix);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Yangon',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function formatClock(kickoffIsoOrUnix) {
  const d = toDate(kickoffIsoOrUnix);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Yangon',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(d);
}

function toDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Main live feed — matches only (no highlights/channels nested).
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
 * Soco live — leagues-grouped shape used by Flutter:
 * { leagues: [{ league_name, league_icon, matches: [{ home_team, away_team, month, time, links }] }] }
 */
function formatSocoLeagues(socoMatches = [], { leagueIcons = {} } = {}) {
  const byLeague = new Map();

  for (const m of socoMatches || []) {
    const leagueName = String(m.league || m.league_name || 'Unknown').trim() || 'Unknown';
    if (!byLeague.has(leagueName)) {
      byLeague.set(leagueName, {
        league_name: leagueName,
        league_icon: m.leagueIcon || leagueIcons[leagueName] || '',
        matches: [],
      });
    }

    const links = normalizeSocoLinks(m);
    const kickoff = m.kickoff || m.kickoffUnix || null;

    byLeague.get(leagueName).matches.push({
      home_team: {
        name: m.homeTeam || m.home_team?.name || '',
        logo: m.homeLogo || m.home_team?.logo || '',
      },
      away_team: {
        name: m.awayTeam || m.away_team?.name || '',
        logo: m.awayLogo || m.away_team?.logo || '',
      },
      month: m.month || formatMonth(kickoff),
      time: m.clock || formatClock(kickoff),
      links,
    });
  }

  return { leagues: [...byLeague.values()] };
}

function normalizeSocoLinks(match) {
  if (Array.isArray(match.links) && match.links.length) {
    return match.links
      .filter((l) => l && (l.url || l.name))
      .map((l) => ({
        name: l.name || 'Link 1',
        url: l.url || '',
        reffer: l.reffer || l.referer || match.matchUrl || '',
      }));
  }

  // Fallback from merged AWS stream objects
  if (Array.isArray(match.streams) && match.streams.length) {
    return match.streams
      .filter((s) => s && s.url)
      .map((s, i) => ({
        name: s.quality || `Link ${i + 1}`,
        url: s.url,
        reffer: s.headers?.Referer || match.matchUrl || '',
      }));
  }

  if (match.stream?.url) {
    return [
      {
        name: match.stream.quality || 'Link 1',
        url: match.stream.url,
        reffer: match.stream.reffer || match.matchUrl || '',
      },
    ];
  }

  return [];
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
 * Build all four delivery files from pipeline outputs.
 */
function buildDeliveryBundle({ matchesPayload, socoMatches, highlights, channels }) {
  return {
    matches: formatMatchesDelivery(matchesPayload),
    soco: formatSocoLeagues(socoMatches || []),
    highlight: formatHighlightsDelivery(highlights || []),
    myanmartv: formatChannelsDelivery(channels || []),
  };
}

module.exports = {
  formatMatchesDelivery,
  formatSocoLeagues,
  formatHighlightsDelivery,
  formatChannelsDelivery,
  buildDeliveryBundle,
  formatMonth,
  formatClock,
};
