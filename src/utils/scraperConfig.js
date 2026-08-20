/**
 * Runtime scraper/search settings from .env.
 * Reuses existing names; does not invent a second config system.
 *
 * STREAM_MAX_ATTEMPTS is the post-kickoff stream-search cap (kickoff / +5 / +10).
 * MAX_STREAM_RETRIES remains the per-request Puppeteer/HTTP retry in sources — do not alias.
 */

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * How many player tabs / embed pages to fetch per source (TOM, HDTOM, …).
 * Extra tabs are axios HTML — cheap vs Chrome — but still multiply work.
 * 1GB default: 2 (TOM + HDTOM). Set HTTP_STREAM_MAX_EMBEDS=4 for all tabs.
 */
function maxPlayerStreams(env = process.env) {
  const raw = env.HTTP_STREAM_MAX_EMBEDS;
  if (raw != null && String(raw).trim() !== '') {
    return Math.min(8, parsePositiveInt(raw, 2));
  }
  if (String(env.LOW_MEMORY_MODE || '').toLowerCase() === 'false') return 6;
  return 2;
}

function parseMinutesList(value, fallbackList) {
  const raw = String(value == null ? '' : value).trim();
  const parts = raw
    .split(/[,\s]+/)
    .map((item) => Number(item))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const unique = [...new Set(parts)].sort((a, b) => b - a);
  return unique.length ? unique : [...fallbackList];
}

function buildMatchUrlSlots(preKickoffMinutes) {
  const mins = [...preKickoffMinutes].sort((a, b) => b - a);
  const slots = [];
  for (let i = 0; i < mins.length; i += 1) {
    const maxInclusive = mins[i];
    const minExclusive = i + 1 < mins.length ? mins[i + 1] : 0;
    slots.push({
      id: `t${maxInclusive}`,
      minExclusive,
      maxInclusive,
      attempt: i + 1,
    });
  }
  return slots;
}

function buildStreamSearchSlots(offsets, stopAfterMin) {
  const unique = [...new Set(offsets.map((n) => Math.max(0, Number(n) || 0)))]
    .filter((n) => n < stopAfterMin)
    .sort((a, b) => a - b);
  const slots = [];
  for (let i = 0; i < unique.length; i += 1) {
    const offset = unique[i];
    const next = i + 1 < unique.length ? unique[i + 1] : stopAfterMin;
    slots.push({
      id: offset === 0 ? 't0' : `tP${offset}`,
      minExclusive: -next,
      maxInclusive: -offset,
      postKickoff: true,
      attempt: i + 1,
      offsetMin: offset,
    });
  }
  return slots;
}

function loadScraperConfig(env = process.env) {
  const matchUrlPreKickoffMinutes = parseMinutesList(
    env.MATCH_URL_PRE_KICKOFF_MINUTES,
    [60, 45, 30]
  );
  const streamMaxAttempts = parsePositiveInt(env.STREAM_MAX_ATTEMPTS, 3);
  const streamPostKickoffMaxMinutes = parsePositiveInt(
    env.STREAM_POST_KICKOFF_MAX_MINUTES,
    15
  );
  const streamSearchIntervalMinutes = parsePositiveInt(
    env.STREAM_SEARCH_INTERVAL_MINUTES,
    5
  );
  const scraperConcurrency = parsePositiveInt(env.SCRAPER_CONCURRENCY, 2);

  const streamAttemptOffsets = [];
  for (let i = 0; i < streamMaxAttempts; i += 1) {
    const offset = i * streamSearchIntervalMinutes;
    if (offset < streamPostKickoffMaxMinutes) streamAttemptOffsets.push(offset);
  }
  if (!streamAttemptOffsets.length) streamAttemptOffsets.push(0);

  const matchUrlSearchSlots = buildMatchUrlSlots(matchUrlPreKickoffMinutes);
  const matchUrlLeadMin = matchUrlPreKickoffMinutes[0] || 45;
  const streamExtractPreKickoffMinutes = parseMinutesList(
    env.STREAM_EXTRACT_PRE_KICKOFF_MINUTES,
    [30, 15, 5]
  );
  const streamExtractLeadMin = streamExtractPreKickoffMinutes[0] || 30;
  const matchUrlEarlyDiscovery =
    String(env.MATCH_URL_EARLY_DISCOVERY || 'false').toLowerCase() === 'true';
  const matchUrlEarlySlot = matchUrlEarlyDiscovery
    ? {
        id: 'tEarly',
        minExclusive: matchUrlLeadMin,
        maxInclusive: 72 * 60,
        attempt: 0,
        early: true,
      }
    : null;
  const preKickoffExtractSlots = buildMatchUrlSlots(streamExtractPreKickoffMinutes).map(
    (slot) => ({
      ...slot,
      postKickoff: false,
    })
  );
  const streamSearchSlots = [
    ...preKickoffExtractSlots,
    ...buildStreamSearchSlots(streamAttemptOffsets, streamPostKickoffMaxMinutes),
  ];

  return {
    matchUrlPreKickoffMinutes,
    matchUrlMaxAttempts: matchUrlPreKickoffMinutes.length,
    matchUrlSearchSlots,
    matchUrlLeadMin,
    matchUrlEarlyDiscovery,
    matchUrlEarlySlot,
    streamExtractPreKickoffMinutes,
    streamExtractLeadMin,
    streamMaxAttempts,
    streamPostKickoffMaxMinutes,
    streamSearchIntervalMinutes,
    streamAttemptOffsets,
    streamSearchSlots,
    scraperConcurrency,
    streamFindLeadMin: streamExtractLeadMin,
    puppeteerConcurrency: parsePositiveInt(env.PUPPETEER_CONCURRENCY, 1),
    httpStreamMaxEmbeds: maxPlayerStreams(env),
  };
}

const CONFIG = loadScraperConfig();

module.exports = {
  parsePositiveInt,
  parseMinutesList,
  maxPlayerStreams,
  buildMatchUrlSlots,
  buildStreamSearchSlots,
  loadScraperConfig,
  CONFIG,
  STREAM_FIND_LEAD_MIN: CONFIG.streamExtractLeadMin,
  MATCH_URL_LEAD_MIN: CONFIG.matchUrlLeadMin,
  STREAM_EXTRACT_LEAD_MIN: CONFIG.streamExtractLeadMin,
  STREAM_SEARCH_STOP_AFTER_MIN: CONFIG.streamPostKickoffMaxMinutes,
  STREAM_SEARCH_INTERVAL_MINUTES: CONFIG.streamSearchIntervalMinutes,
  STREAM_MAX_ATTEMPTS: CONFIG.streamMaxAttempts,
  MATCH_URL_MAX_ATTEMPTS: CONFIG.matchUrlMaxAttempts,
  MATCH_URL_SEARCH_SLOTS: CONFIG.matchUrlSearchSlots,
  STREAM_SEARCH_SLOTS: CONFIG.streamSearchSlots,
  MATCH_URL_EARLY_SLOT: CONFIG.matchUrlEarlySlot,
  MAX_POST_KICKOFF_ATTEMPTS: CONFIG.streamMaxAttempts,
  SCRAPER_CONCURRENCY: CONFIG.scraperConcurrency,
  PUPPETEER_CONCURRENCY: CONFIG.puppeteerConcurrency,
  HTTP_STREAM_MAX_EMBEDS: CONFIG.httpStreamMaxEmbeds,
};
