const { resolveLeagueIcon } = require('../utils/fotmobLogos');
const { nowYangon, formatTime12, minutesUntilKickoff } = require('../utils/time');
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

function flutterStreamName(stream) {
  const source = String(stream?.source || '').trim();
  const pretty = source
    ? source.charAt(0).toUpperCase() + source.slice(1).toLowerCase()
    : '';
  const quality = String(stream?.name || stream?.quality || '').trim();
  if (!pretty) return quality || 'HD';
  if (!quality || quality.toLowerCase() === pretty.toLowerCase()) return pretty;
  if (quality.toLowerCase().startsWith(`${pretty.toLowerCase()} ·`)) return quality;
  return `${pretty} · ${quality}`;
}

function sourceAllowsPublishedStream(match, sourceName) {
  const name = String(sourceName || '').trim();
  if (!name) return true;
  if (name.toLowerCase() === 'manual') return true;
  return sourceHasSavedMatchUrl(getSourceMatchUrlState(match, name));
}

/** If a source is AVAILABLE but its stream was collapsed as a URL duplicate, still expose a link. */
function expandStreamsForAvailableSources(match) {
  const list = [...(match?.streams || [])]
    .filter((s) => s && s.url)
    .filter((s) => sourceAllowsPublishedStream(match, s.source));
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
    const flutterStreams = expandStreamsForAvailableSources(m)
      .filter((s) => s && s.url)
      .map((s) => ({
        source: s.source,
        type: s.type || 'm3u8',
        quality: s.quality || s.name || 'HD',
        name: flutterStreamName(s),
        url: s.url,
        headers: flutterPlaybackHeaders(s.streamHeaders || s.headers),
        streamHeaders: flutterPlaybackHeaders(s.streamHeaders || s.headers),
        active: Boolean(s.active),
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
      }));
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
    date: m.date,
    time: formatTime12(m.kickoff) || m.time,
    kickoff: m.kickoff,
    timezone: m.timezone || 'Asia/Yangon',
    status: m.status || 'Scheduled',
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

module.exports = { generateFlutterJson, flutterPlaybackHeaders };
