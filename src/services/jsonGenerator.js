const { resolveLeagueIcon } = require('../utils/fotmobLogos');
const { nowYangon, formatTime12, formatDateDisplay, minutesUntilKickoff } = require('../utils/time');
const { hashPayload, sanitizeForCompare } = require('../utils/compare');
const { enrichMatchState } = require('./statusService');
const {
  aggregateStreamStatus,
  firstValidatedStreamUrl,
  firstValidatedStreamHeaders,
  isValidatedStream,
  aggregateValidationFields,
  maxSourceAttempts,
} = require('../utils/streamExtractPolicy');
const {
  getSourceMatchUrlState,
  sourceHasSavedMatchUrl,
  sanitizeSourcePages,
} = require('../utils/matchUrlDiscovery');

const STREAM_SOURCE_LABELS = {
  cakhia: 'Cakhia',
  xoilac: 'Xoilac',
  socolive: 'Socolive',
  phut: 'Phut',
  '90phut': 'Phut',
  mitomtm: 'Mitom',
  mitom: 'Mitom',
  manual: 'Manual',
};

function looksLikeDomain(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  return /https?:\/\//i.test(s) || /\b[\w-]+\.[a-z]{2,}(?:\/|\b)/i.test(s);
}

function streamSourceLabel(source) {
  const key = String(source || '').trim().toLowerCase();
  if (!key || key === 'stream') return '';
  if (looksLikeDomain(key)) return '';
  if (STREAM_SOURCE_LABELS[key]) return STREAM_SOURCE_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function streamQualityLabel(stream, pretty) {
  let quality = String(stream?.quality || '').trim();
  let name = String(stream?.name || '').trim();
  if (looksLikeDomain(quality)) quality = '';
  if (looksLikeDomain(name)) name = '';
  const raw = quality || name;
  if (!raw) return 'HD';
  let q = raw;
  const labels = [pretty, streamSourceLabel(stream?.source)].filter(Boolean);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    q = q.replace(new RegExp(`^${escaped}\\s*[·.]\\s*`, 'i'), '').trim();
    if (q.toLowerCase() === label.toLowerCase()) q = '';
  }
  q = q.replace(/^[\s·.]+/, '').trim();
  return q || 'HD';
}

/** Public stream title: quality only (HD ROY), never a domain or source host. */
function flutterStreamName(stream) {
  return streamQualityLabel(stream, streamSourceLabel(stream?.source));
}

function sourceAllowsPublishedStream(match, sourceName) {
  const name = String(sourceName || '').trim();
  if (!name) return true;
  if (name.toLowerCase() === 'manual') return true;
  return sourceHasSavedMatchUrl(getSourceMatchUrlState(match, name));
}

/** Already-extracted m3u8 is always published. Match URL is only required to clone a source tab. */
function expandStreamsForAvailableSources(match) {
  const list = [...(match?.streams || [])].filter((s) => s && String(s.url || '').trim());
  const template = list[0];
  if (!template) return list;
  const have = new Set(list.map((s) => String(s.source || '').toLowerCase()));
  for (const [name, state] of Object.entries(match?.streamSearch?.sources || {})) {
    if (String(state?.status || '') !== 'AVAILABLE') continue;
    if (!sourceAllowsPublishedStream(match, name)) continue;
    const key = String(name || '').toLowerCase();
    if (!key || have.has(key)) continue;
    list.push({
      ...template,
      source: name,
      name: undefined,
      quality: template.quality || template.name || 'Link 1',
    });
    have.add(key);
  }
  return list;
}

/** Top-level streamUrl must appear in streams[] so the player feed is not empty. */
function ensureStreamUrlInList(match, flutterStreams) {
  const url = String(match?.streamUrl || '').trim();
  if (!url) return flutterStreams;
  if (flutterStreams.some((s) => String(s.url || '').trim() === url)) return flutterStreams;
  const headers = flutterPlaybackHeaders(match.streamHeaders);
  const source = String(match.matchUrlSource || match.source || 'stream').trim() || 'stream';
  return [
    {
      source,
      type: 'm3u8',
      quality: 'HD',
      name: flutterStreamName({ source, quality: 'HD' }),
      url,
      headers,
      streamHeaders: headers,
      active: true,
      checkedAt: match.lastAttemptAt || null,
    },
    ...flutterStreams,
  ];
}

function flutterPlaybackHeaders(raw) {
  if (!raw || typeof raw !== 'object') {
    return { 'User-Agent': '', Referer: '' };
  }
  const headers = {
    'User-Agent': raw['User-Agent'] || raw['user-agent'] || '',
    Referer: raw.Referer || raw.referer || '',
  };
  const origin = raw.Origin || raw.origin;
  if (origin) headers.Origin = origin;
  const cookie = raw.Cookie || raw.cookie;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Generate Flutter-facing JSON payload.
 * Includes live matches + highlights + Myanmar TV channels.
 */
function generateFlutterJson(matches, meta = {}, extras = {}) {
  const cleanedMatches = (matches || []).map((raw) => {
    // Status from kickoff windows (Scheduled / PREPARING_STREAM / LIVE / END)
    const m = enrichMatchState(raw);
    const streamStatus =
      m.streamStatus ||
      aggregateStreamStatus(m.streamSearch, {
        hasValidatedStream: (m.streams || []).some((s) => isValidatedStream(s)),
        stopped: Boolean(m.streamSearch?.stopped),
        mins: minutesUntilKickoff(m.kickoff),
      });
    const validation =
      m.validationStatus != null || m.validationReason != null
        ? {
            validationStatus: m.validationStatus || null,
            validationReason: m.validationReason || null,
          }
        : aggregateValidationFields(m, streamStatus);
    const flutterStreams = ensureStreamUrlInList(
      m,
      expandStreamsForAvailableSources(m)
        .filter((s) => s && s.url)
        .map((s) => ({
          source: s.source,
          type: s.type || 'm3u8',
          quality: streamQualityLabel(s, streamSourceLabel(s.source)),
          name: flutterStreamName(s),
          url: s.url,
          headers: flutterPlaybackHeaders(s.streamHeaders || s.headers),
          streamHeaders: flutterPlaybackHeaders(s.streamHeaders || s.headers),
          active: s.active !== false,
          checkedAt: s.checkedAt || null,
          ...(s.validation?.state || s.validation?.reason
            ? {
                validationStatus: s.validation.state || s.validation.reason,
                validationReason:
                  s.validation.ok === true
                    ? null
                    : s.validation.state || s.validation.reason || null,
              }
            : {}),
          ...(s.manualId ? { manualId: s.manualId } : {}),
        }))
    );
    return {
    matchId: m.matchId,
    league: m.league,
    leagueIcon: resolveLeagueIcon(m),
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    homeTeamId: m.homeTeamId || null,
    awayTeamId: m.awayTeamId || null,
    homeLogo: m.homeLogo || null,
    awayLogo: m.awayLogo || null,
    date: formatDateDisplay(m.kickoff) || m.date,
    time: formatTime12(m.kickoff) || m.time,
    kickoff: m.kickoff,
    timezone: m.timezone || 'Asia/Yangon',
    status: m.status || 'Scheduled',
    h2h: m.h2h != null ? m.h2h : null,
    fotmobMatchId: m.fotmobMatchId || m.fotmobId || null,
    leagueId: m.leagueId || m.leagueFotmobId || null,
    leagueName: m.leagueName || m.league || null,
    source: m.source || (m.streams || []).find((s) => s && s.url)?.source || null,
    manual: Boolean(m.manual),
    statusLocked: Boolean(m.statusLocked),
    pinned: Boolean(m.pinned),
    featured: Boolean(m.featured),
    hasStreams: flutterStreams.length > 0,
    streamCount: flutterStreams.length,
    originalNames: m.originalNames || {},
    sourcePages: sanitizeSourcePages(m),
    streams: flutterStreams,
    streamAttempts: m.streamAttempts || {},
    matchUrl: m.matchUrl || null,
    matchUrlStatus: m.matchUrlStatus || 'MATCH_URL_PENDING',
    matchUrlAttempts: Number(m.matchUrlAttempts) || 0,
    lastMatchUrlAttemptAt: m.lastMatchUrlAttemptAt || null,
    matchUrlSource: m.matchUrlSource || null,
    streamUrl: m.streamUrl || firstValidatedStreamUrl(m) || null,
    streamHeaders: (() => {
      const raw = m.streamHeaders || firstValidatedStreamHeaders(m);
      return raw ? flutterPlaybackHeaders(raw) : null;
    })(),
    streamStatus,
    attempts: Number(m.attempts) || maxSourceAttempts(m.streamSearch) || 0,
    validationStatus: validation.validationStatus,
    validationReason: validation.validationReason,
    lastAttemptAt: m.lastAttemptAt || null,
    // Kickoff-relative stream-search state (Flutter-safe; optional)
    ...(m.streamSearch && typeof m.streamSearch === 'object'
      ? { streamSearch: m.streamSearch }
      : {}),
    ...(m.matchUrlSearch && typeof m.matchUrlSearch === 'object'
      ? { matchUrlSearch: m.matchUrlSearch }
      : {}),
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
  // Scraper site config belongs in config/sources.json, not the Flutter feed
  delete payload.meta.sourcesDoc;

  payload.meta.checksum = hashPayload(sanitizeForCompare(payload));
  return payload;
}

const PUBLIC_STREAM_KEYS = new Set([
  'type',
  'name',
  'url',
  'headers',
  'streamHeaders',
  'active',
]);

const PUBLIC_MATCH_KEYS = [
  'matchId',
  'league',
  'leagueIcon',
  'homeTeam',
  'awayTeam',
  'homeTeamId',
  'awayTeamId',
  'homeLogo',
  'awayLogo',
  'date',
  'time',
  'kickoff',
  'timezone',
  'status',
  'h2h',
  'fotmobMatchId',
  'leagueId',
  'leagueName',
  'pinned',
  'featured',
  'hasStreams',
  'streamCount',
  'streams',
  'streamUrl',
  'streamHeaders',
  'streamStatus',
];

function toPublicStream(stream) {
  if (!stream || !stream.url) return null;
  const out = {};
  for (const key of PUBLIC_STREAM_KEYS) {
    if (stream[key] !== undefined) out[key] = stream[key];
  }
  out.name = flutterStreamName(stream);
  delete out.source;
  delete out.quality;
  return out;
}

/** Flutter GitHub matches.json — fixture + stream only (no Match URL / admin / debug). */
function toPublicMatch(match) {
  if (!match) return match;
  let streams = (match.streams || []).map(toPublicStream).filter(Boolean);
  const out = {};
  for (const key of PUBLIC_MATCH_KEYS) {
    if (key === 'streams') continue;
    if (match[key] !== undefined) out[key] = match[key];
  }
  if (!out.streamUrl && streams[0]) out.streamUrl = streams[0].url;
  if (!out.streamHeaders && streams[0]) {
    out.streamHeaders = streams[0].streamHeaders || streams[0].headers || null;
  }
  const topUrl = String(out.streamUrl || '').trim();
  if (topUrl && !streams.some((s) => String(s.url || '').trim() === topUrl)) {
    streams = [
      {
        type: 'm3u8',
        name: flutterStreamName({
          source: match.matchUrlSource || match.source,
          quality: 'HD',
        }),
        url: topUrl,
        headers: out.streamHeaders || null,
        streamHeaders: out.streamHeaders || null,
        active: true,
      },
      ...streams,
    ];
  }
  out.streams = streams;
  out.hasStreams = streams.length > 0;
  out.streamCount = streams.length;
  return out;
}

function toPublicMatchesPayload(payload) {
  if (!payload || !Array.isArray(payload.matches)) return payload;
  const matches = payload.matches.map(toPublicMatch);
  const next = {
    version: payload.version || 1,
    generatedAt: payload.generatedAt,
    timezone: payload.timezone || 'Asia/Yangon',
    matchCount: matches.length,
    matches,
    meta: {
      feed: 'matches',
      liveCount: matches.filter((m) => m.status === 'LIVE').length,
      scheduledCount: matches.filter((m) => m.status === 'Scheduled').length,
      endedCount: matches.filter((m) => m.status === 'END').length,
    },
  };
  next.meta.checksum = hashPayload(sanitizeForCompare(next));
  return next;
}

module.exports = {
  generateFlutterJson,
  flutterPlaybackHeaders,
  flutterStreamName,
  toPublicMatch,
  toPublicMatchesPayload,
};
