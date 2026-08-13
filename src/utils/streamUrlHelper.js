const { DateTime } = require('luxon');

/** Indochina Time (ICT) — GMT+7 */
const ICT_ZONE = 'Asia/Bangkok';

/** Noise tokens stripped when cleaning team names for matching. */
const TEAM_NOISE_WORDS = new Set([
  'fc',
  'cf',
  'sc',
  'ac',
  'afc',
  'united',
  'club',
  'de',
  'la',
  'el',
  'los',
  'las',
  'the',
  'and',
  'of',
  'football',
  'soccer',
  'sporting',
  'athletic',
  'atletico',
  'atlético',
]);

/**
 * Decode a URL slug segment into a readable team/title fragment.
 * "lernayin-artsakh" → "lernayin artsakh"
 */
function slugToText(slug) {
  return String(slug || '')
    .replace(/[_+]+/g, '-')
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Title-case a team fragment for display (keeps short tokens like "b" as-is).
 */
function titleCaseWords(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (w.length <= 1) return w.toUpperCase();
      if (/^[A-Z0-9]+$/.test(w) && w.length <= 3) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Clean team names for fuzzy matching:
 * remove FC / CF / United / Club / De / La, extra spaces, special characters.
 */
function cleanTeamName(name) {
  let s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return '';

  const kept = s
    .split(/\s+/)
    .filter((tok) => tok && !TEAM_NOISE_WORDS.has(tok.toLowerCase()));

  // If everything was noise, fall back to original cleaned string
  const out = (kept.length ? kept : s.split(/\s+/)).join(' ').trim();
  return out.replace(/\s+/g, ' ');
}

/**
 * Parse HHMM or HMM ICT clock into { hour, minute }.
 * Examples: "1930" → 19:30, "930" → 09:30, "19:30" → 19:30
 */
function parseIctClock(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;

  const colon = t.match(/^(\d{1,2}):(\d{2})$/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
    return null;
  }

  const digits = t.replace(/\D/g, '');
  if (digits.length === 3) {
    const hour = Number(digits.slice(0, 1));
    const minute = Number(digits.slice(1));
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  if (digits.length === 4) {
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2));
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  return null;
}

/**
 * Build a Luxon DateTime in ICT from dd-MM-yyyy + HHMM clock parts.
 */
function buildIctDateTime({ day, month, year, hour, minute }) {
  const dt = DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: 0,
      millisecond: 0,
    },
    { zone: ICT_ZONE }
  );
  return dt.isValid ? dt : null;
}

/**
 * Extract the meaningful path slug from a streaming match URL.
 */
function extractMatchSlug(url) {
  let raw = String(url || '').trim();
  if (!raw) return '';

  try {
    const u = new URL(raw);
    raw = u.pathname || raw;
  } catch {
    // not a full URL — treat as path/slug
  }

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  // Prefer slug that contains "-vs-" and time/date markers
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i].toLowerCase();
    if (p.includes('-vs-') && (p.includes('-luc-') || p.includes('-ngay-'))) {
      return parts[i];
    }
  }
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase().includes('-vs-')) return parts[i];
  }
  return parts[parts.length - 1] || '';
}

/**
 * Parse a streaming site match URL into teams + ICT kickoff, plus UTC equivalents.
 *
 * Supports slugs like:
 *   lernayin-artsakh-vs-ararat-armenia-b-luc-1930-ngay-13-08-2026
 *
 * @param {string} url
 * @returns {{
 *   homeTeam: string,
 *   awayTeam: string,
 *   homeTeamClean: string,
 *   awayTeamClean: string,
 *   date: string,          // YYYY-MM-DD (ICT calendar date)
 *   time: string,          // HH:mm (ICT)
 *   timezone: string,      // 'ICT' / GMT+7
 *   ictDateTime: import('luxon').DateTime | null,
 *   utcDate: Date | null,
 *   utcTimestamp: number | null, // epoch ms
 *   utcIso: string | null,
 *   slug: string,
 *   ok: boolean,
 *   error?: string,
 * }}
 */
function parseStreamUrl(url) {
  const empty = {
    homeTeam: '',
    awayTeam: '',
    homeTeamClean: '',
    awayTeamClean: '',
    date: '',
    time: '',
    timezone: 'ICT',
    ictDateTime: null,
    utcDate: null,
    utcTimestamp: null,
    utcIso: null,
    slug: '',
    ok: false,
  };

  const slug = extractMatchSlug(url);
  if (!slug) {
    return { ...empty, error: 'empty_url' };
  }

  const lower = slug.toLowerCase();

  // Primary pattern: {home}-vs-{away}-luc-{HHMM}-ngay-{DD}-{MM}-{YYYY}
  let m = lower.match(
    /^(.+?)-vs-(.+?)-luc-(\d{3,4})-ngay-(\d{1,2})-(\d{1,2})-(\d{4})$/
  );

  // Alternate: ngay before luc
  if (!m) {
    m = lower.match(
      /^(.+?)-vs-(.+?)-ngay-(\d{1,2})-(\d{1,2})-(\d{4})-luc-(\d{3,4})$/
    );
    if (m) {
      m = [m[0], m[1], m[2], m[6], m[3], m[4], m[5]];
    }
  }

  // Fallback: teams only (no embedded kickoff)
  if (!m) {
    const vs = lower.match(/^(.+?)-vs-(.+)$/);
    if (!vs) {
      return { ...empty, slug, error: 'unrecognized_slug' };
    }
    const homeTeam = titleCaseWords(slugToText(vs[1]));
    const awayTeam = titleCaseWords(slugToText(vs[2]));
    return {
      ...empty,
      homeTeam,
      awayTeam,
      homeTeamClean: cleanTeamName(homeTeam),
      awayTeamClean: cleanTeamName(awayTeam),
      slug,
      error: 'missing_kickoff_in_slug',
    };
  }

  const homeSlug = m[1];
  const awaySlug = m[2];
  const clockRaw = m[3];
  const day = m[4];
  const month = m[5];
  const year = m[6];

  const clock = parseIctClock(clockRaw);
  if (!clock) {
    return { ...empty, slug, error: 'invalid_time' };
  }

  const ict = buildIctDateTime({
    day,
    month,
    year,
    hour: clock.hour,
    minute: clock.minute,
  });
  if (!ict) {
    return { ...empty, slug, error: 'invalid_datetime' };
  }

  const homeTeam = titleCaseWords(slugToText(homeSlug));
  const awayTeam = titleCaseWords(slugToText(awaySlug));
  const utc = ict.toUTC();

  return {
    homeTeam,
    awayTeam,
    homeTeamClean: cleanTeamName(homeTeam),
    awayTeamClean: cleanTeamName(awayTeam),
    date: ict.toFormat('yyyy-MM-dd'),
    time: ict.toFormat('HH:mm'),
    timezone: 'ICT',
    ictDateTime: ict,
    utcDate: utc.toJSDate(),
    utcTimestamp: utc.toMillis(),
    utcIso: utc.toISO(),
    slug,
    ok: true,
  };
}

/**
 * Coerce FotMob / stream times into UTC millis.
 * Accepts Date, Luxon DateTime, ISO string, epoch ms/seconds, or parseStreamUrl result.
 */
function toUtcMillis(input) {
  if (input == null || input === '') return null;

  if (typeof input === 'object' && input.utcTimestamp != null) {
    return Number(input.utcTimestamp);
  }
  if (typeof input === 'object' && input.utcDate instanceof Date) {
    return input.utcDate.getTime();
  }
  if (DateTime.isDateTime(input)) {
    return input.toUTC().toMillis();
  }
  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return input < 1e12 ? input * 1000 : input;
  }

  const raw = String(input).trim();
  const iso = DateTime.fromISO(raw, { setZone: true });
  if (iso.isValid) return iso.toUTC().toMillis();

  const js = new Date(raw);
  const ms = js.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when stream kickoff is within ±windowMinutes of FotMob kickoff (UTC).
 *
 * @param {Date|string|number|import('luxon').DateTime} fotmobUtcTime
 * @param {Date|string|number|import('luxon').DateTime|object} streamUtcTime
 * @param {number} [windowMinutes=30]
 */
function isMatchWithinWindow(fotmobUtcTime, streamUtcTime, windowMinutes = 30) {
  const a = toUtcMillis(fotmobUtcTime);
  const b = toUtcMillis(streamUtcTime);
  if (a == null || b == null) return false;

  const windowMs = Math.max(0, Number(windowMinutes) || 0) * 60 * 1000;
  return Math.abs(a - b) <= windowMs;
}

/**
 * Canonical league/country tags and common aliases (SPA, ENG, LaLiga, …).
 * Values are normalized lowercase keys that map to the same bucket.
 */
const LEAGUE_COUNTRY_GROUPS = [
  ['eng', 'england', 'english', 'epl', 'premier league', 'premierleague', '英超'],
  ['spa', 'esp', 'spain', 'spanish', 'la liga', 'laliga', '西甲'],
  ['ita', 'italy', 'italian', 'serie a', 'seriea', '意甲'],
  ['ger', 'deu', 'germany', 'german', 'bundesliga', '德甲'],
  ['fra', 'france', 'french', 'ligue 1', 'ligue1', '法甲'],
  ['por', 'portugal', 'portuguese', 'primeira', 'liga portugal'],
  ['ned', 'nld', 'netherlands', 'dutch', 'eredivisie'],
  ['bra', 'brazil', 'brazilian', 'brasileirao', 'brazil serie a'],
  ['kor', 'korea', 'k league', 'kleague', 'k-league'],
  ['vie', 'vietnam', 'v league', 'v.league', 'vleague'],
  ['ucl', 'champions league', 'uefa champions league', 'c1'],
  ['uel', 'europa league', 'uefa europa league'],
  ['fifa', 'world cup', 'fifa world cup'],
  ['uefa', 'euro', 'uefa euro'],
  ['concacaf', 'copa america', 'copa América', 'copa america'],
  ['asean', 'aff', 'asean championship'],
  ['friendly', 'friendlies', 'club friendlies', 'int club friendlies'],
];

const LEAGUE_TAG_LOOKUP = (() => {
  const map = new Map();
  for (const group of LEAGUE_COUNTRY_GROUPS) {
    const canonical = foldTag(group[0]);
    for (const alias of group) {
      map.set(foldTag(alias), canonical);
    }
  }
  return map;
})();

function foldTag(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeLeagueTag(value) {
  const folded = foldTag(value);
  if (!folded) return null;
  if (LEAGUE_TAG_LOOKUP.has(folded)) return LEAGUE_TAG_LOOKUP.get(folded);

  // Token-level: "ENG Premier League" → eng
  for (const tok of folded.split(' ')) {
    if (tok.length >= 2 && LEAGUE_TAG_LOOKUP.has(tok)) {
      return LEAGUE_TAG_LOOKUP.get(tok);
    }
  }

  // Compact form without spaces: "laliga", "premierleague"
  const compact = folded.replace(/\s+/g, '');
  if (LEAGUE_TAG_LOOKUP.has(compact)) return LEAGUE_TAG_LOOKUP.get(compact);

  // Keep multi-char folded string as its own tag for exact-ish overlap
  return folded.length >= 3 ? folded : null;
}

/**
 * Collect normalized league/country tags from a FotMob or stream object + URL.
 */
function collectLeagueCountryTags(source = {}, urlOrSlug = '') {
  const tags = new Set();
  const push = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const v of value) push(v);
      return;
    }
    const canon = canonicalizeLeagueTag(value);
    if (canon) tags.add(canon);
  };

  push(source.league);
  push(source.leagueName);
  push(source.leagueCode);
  push(source.country);
  push(source.countryCode);
  push(source.ccode);
  push(source.nation);
  push(source.tags);
  push(source.leagueTags);
  push(source.originalNames?.league);

  const hay = String(urlOrSlug || source.url || source.slug || '').toLowerCase();
  if (hay) {
    // Path segments / slug tokens that look like codes or known aliases
    for (const part of hay.split(/[^a-z0-9]+/i)) {
      if (part.length >= 2 && part.length <= 24 && LEAGUE_TAG_LOOKUP.has(part)) {
        push(part);
      }
    }
    for (const [alias, canon] of LEAGUE_TAG_LOOKUP.entries()) {
      if (alias.length >= 3 && hay.includes(alias.replace(/\s+/g, '-'))) {
        tags.add(canon);
      } else if (alias.length >= 3 && hay.includes(alias)) {
        tags.add(canon);
      }
    }
  }

  return tags;
}

function leagueCountryMatches(fotmobMatch, streamData) {
  const fotmobTags = collectLeagueCountryTags(fotmobMatch);
  const streamTags = collectLeagueCountryTags(
    streamData,
    streamData.url || streamData.slug || ''
  );

  if (!fotmobTags.size || !streamTags.size) return false;

  for (const tag of streamTags) {
    if (fotmobTags.has(tag)) return true;
  }
  return false;
}

/**
 * Core keywords from a cleaned team name (tokens length ≥ 3).
 */
function coreTeamKeywords(name) {
  const cleaned = cleanTeamName(name).toLowerCase();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const long = tokens.filter((t) => t.length >= 3);
  return long.length ? long : tokens.filter((t) => t.length >= 2);
}

/**
 * Layer 3: BOTH FotMob home and away core keywords appear in the stream URL/slug.
 */
function teamNamesInUrl(fotmobMatch, streamData) {
  const haystack = [
    streamData.slug,
    streamData.url,
    streamData.matchUrl,
    streamData.path,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[%]/g, ' ');

  if (!haystack.trim()) return false;

  // Also accept hyphen/space folded form
  const hay = haystack.replace(/[^a-z0-9]+/g, ' ');

  const home = fotmobMatch.homeTeam || fotmobMatch.home || '';
  const away = fotmobMatch.awayTeam || fotmobMatch.away || '';

  const homeKeys = coreTeamKeywords(home);
  const awayKeys = coreTeamKeywords(away);
  if (!homeKeys.length || !awayKeys.length) return false;

  const hasAll = (keys) => keys.every((k) => hay.includes(k));
  return hasAll(homeKeys) && hasAll(awayKeys);
}

/**
 * Normalize stream input: URL string → parseStreamUrl result, or enrich object.
 */
function normalizeStreamUrlData(streamUrlData) {
  if (streamUrlData == null) return null;

  if (typeof streamUrlData === 'string') {
    const parsed = parseStreamUrl(streamUrlData);
    return { ...parsed, url: streamUrlData };
  }

  if (typeof streamUrlData !== 'object') return null;

  // Already parsed or partial scrape card
  if (streamUrlData.ok === true || streamUrlData.utcTimestamp != null) {
    return streamUrlData;
  }

  if (streamUrlData.url || streamUrlData.matchUrl) {
    const parsed = parseStreamUrl(streamUrlData.url || streamUrlData.matchUrl);
    return {
      ...parsed,
      ...streamUrlData,
      // Prefer explicit scrape fields when provided
      homeTeam: streamUrlData.homeTeam || parsed.homeTeam,
      awayTeam: streamUrlData.awayTeam || parsed.awayTeam,
      league: streamUrlData.league || streamUrlData.leagueName || parsed.league,
      country: streamUrlData.country || streamUrlData.ccode || parsed.country,
      url: streamUrlData.url || streamUrlData.matchUrl,
      slug: streamUrlData.slug || parsed.slug,
      utcTimestamp: streamUrlData.utcTimestamp ?? parsed.utcTimestamp,
      utcDate: streamUrlData.utcDate || parsed.utcDate,
      utcIso: streamUrlData.utcIso || parsed.utcIso,
    };
  }

  return streamUrlData;
}

/**
 * 3-layer validation: match a stream URL/card to a FotMob fixture.
 *
 * Layer 1 — Time: kickoffs within ±30 minutes (UTC)
 * Layer 2 — League/Country: shared tag/code (e.g. SPA, ENG, LaLiga)
 * Layer 3 — Teams: BOTH home & away core keywords appear in the URL string
 *
 * @param {object} fotmobMatch - { homeTeam, awayTeam, kickoff, league, country?, ccode? }
 * @param {string|object} streamUrlData - URL string or parseStreamUrl / scrape object
 * @param {{ windowMinutes?: number, skipLeagueCheck?: boolean }} [options]
 * @returns {boolean}
 */
function matchStreamToFotmob(fotmobMatch, streamUrlData, options = {}) {
  if (!fotmobMatch || typeof fotmobMatch !== 'object') return false;

  const stream = normalizeStreamUrlData(streamUrlData);
  if (!stream) return false;

  const windowMinutes =
    options.windowMinutes == null ? 30 : Number(options.windowMinutes);

  // Layer 1 — Time Check
  const fotmobTime =
    fotmobMatch.kickoff ||
    fotmobMatch.utcTime ||
    fotmobMatch.startTime ||
    fotmobMatch.timeUTC ||
    fotmobMatch.kickoffUtc;
  const streamTime =
    stream.utcTimestamp ??
    stream.utcDate ??
    stream.utcIso ??
    stream.kickoff ??
    stream.ictDateTime;

  if (!isMatchWithinWindow(fotmobTime, streamTime, windowMinutes)) {
    return false;
  }

  // Layer 2 — League / Country Check (optional skip when list HTML has no tags)
  if (!options.skipLeagueCheck && !leagueCountryMatches(fotmobMatch, stream)) {
    return false;
  }

  // Layer 3 — Team Names Check (keywords in URL)
  if (!teamNamesInUrl(fotmobMatch, stream)) {
    return false;
  }

  return true;
}

module.exports = {
  ICT_ZONE,
  TEAM_NOISE_WORDS,
  LEAGUE_COUNTRY_GROUPS,
  parseStreamUrl,
  cleanTeamName,
  isMatchWithinWindow,
  matchStreamToFotmob,
  toUtcMillis,
  parseIctClock,
  slugToText,
  titleCaseWords,
  extractMatchSlug,
  collectLeagueCountryTags,
  coreTeamKeywords,
  canonicalizeLeagueTag,
};
