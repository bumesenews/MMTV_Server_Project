const { DateTime } = require('luxon');
const {
  foldKey,
  stripClubAffixes,
  stripGenderPrefix,
  teamMatchKey,
} = require('./normalize');
const { ZONE: YANGON_ZONE, MATCH_TIME_TOLERANCE_MIN, formatDate } = require('./time');

/** Indochina Time (ICT) — GMT+7 (Vietnamese streaming sites embed this clock). */
const ICT_ZONE = 'Asia/Bangkok';

/** Confidence weights — home/away required; date/time complete the identity. */
const MATCH_SCORE_WEIGHTS = {
  HOME: 40,
  AWAY: 40,
  DATE: 10,
  TIME: 10,
  CONFIRMED_MIN: 90,
  POSSIBLE_MIN: 75,
};

const MATCH_URL_STATUS = {
  PENDING: 'MATCH_URL_PENDING',
  SEARCHING: 'MATCH_URL_SEARCHING',
  NOT_FOUND: 'MATCH_URL_NOT_FOUND',
  FOUND: 'MATCH_URL_FOUND',
  CONFIRMED: 'MATCH_URL_CONFIRMED',
  CONFIRMED_LEGACY: 'MATCH_CONFIRMED',
  FAILED: 'MATCH_URL_FAILED',
  REJECTED: 'REJECTED',
  POSSIBLE: 'POSSIBLE_MATCH',
};

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
 * Strip tracking/query/hash and trailing random IDs from a match URL slug.
 * houseId and similar query params are ignored (URL.pathname already drops them).
 */
function stripDynamicSlugTail(slug) {
  let s = String(slug || '').trim();
  if (!s) return '';
  s = s.replace(/[?#].*$/, '');
  s = decodeURIComponentSafe(s);
  // {yyyy}-{randomId} after ngay-DD-MM-YYYY
  s = s.replace(/-(\d{4})-[a-z0-9]{4,}$/i, '-$1');
  return s.replace(/\/+$/, '');
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
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
    raw = raw.replace(/[?#].*$/, '');
  }

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  // Prefer slug that contains "-vs-" and time/date markers
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i].toLowerCase();
    if (p.includes('-vs-') && (p.includes('-luc-') || p.includes('-ngay-'))) {
      return stripDynamicSlugTail(parts[i]);
    }
  }
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase().includes('-vs-')) {
      return stripDynamicSlugTail(parts[i]);
    }
  }
  return stripDynamicSlugTail(parts[parts.length - 1] || '');
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
    yangonDate: '',
    yangonTime: '',
    yangonIso: null,
    slug: '',
    ok: false,
  };

  const slug = extractMatchSlug(url);
  if (!slug) {
    return { ...empty, error: 'empty_url' };
  }

  const lower = slug.toLowerCase();

  // Primary: {home}-vs-{away}-luc-{HHMM}-ngay-{DD}-{MM}-{YYYY}[ -randomId]
  // Random suffix / query already stripped by extractMatchSlug.
  let m = lower.match(
    /^(.+?)-vs-(.+?)-luc-(\d{3,4})-ngay-(\d{1,2})-(\d{1,2})-(\d{4})(?:-[a-z0-9]+)?$/
  );

  // Alternate: ngay before luc
  if (!m) {
    m = lower.match(
      /^(.+?)-vs-(.+?)-ngay-(\d{1,2})-(\d{1,2})-(\d{4})-luc-(\d{3,4})(?:-[a-z0-9]+)?$/
    );
    if (m) {
      m = [m[0], m[1], m[2], m[6], m[3], m[4], m[5]];
    }
  }

  // Search (unanchored) so extra trailing tokens cannot hide the date/time
  if (!m) {
    const found = lower.match(
      /^(.+?)-vs-(.+?)-luc-(\d{3,4})-ngay-(\d{1,2})-(\d{1,2})-(\d{4})/
    );
    if (found) m = found;
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
  const yangon = ict.setZone(YANGON_ZONE);

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
    yangonDate: yangon.toFormat('yyyy-MM-dd'),
    yangonTime: yangon.toFormat('HH:mm'),
    yangonIso: yangon.toISO(),
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
      yangonDate: streamUrlData.yangonDate || parsed.yangonDate,
      yangonTime: streamUrlData.yangonTime || parsed.yangonTime,
      yangonIso: streamUrlData.yangonIso || parsed.yangonIso,
    };
  }

  return streamUrlData;
}

function canonicalizeTeamForMatch(rawName, normalizer) {
  const cleaned = stripNationalSquadPrefix(String(rawName || '').trim());
  if (!cleaned) return '';
  const aliased = resolveTeamNameAlias(cleaned, normalizer);
  return teamMatchKey(aliased || cleaned);
}

const NATIONAL_SQUAD_PREFIX = /^(dt|doi tuyen|u-?\d{1,2}|olympic)\s+/i;

function stripNationalSquadPrefix(value) {
  let s = String(value || '').trim();
  let prev = null;
  while (s && s !== prev) {
    prev = s;
    s = s.replace(NATIONAL_SQUAD_PREFIX, '').trim();
  }
  return s || String(value || '').trim();
}

/** Vietnamese / local spellings that foldKey will not equate (Thai Lan ≠ Thailand). */
const TEAM_NAME_ALIAS_TO_STANDARD = {
  'thai lan': 'Thailand',
  thailan: 'Thailand',
  'dt thai lan': 'Thailand',
  singapura: 'Singapore',
  'viet nam': 'Vietnam',
  vietnam: 'Vietnam',
  'dt viet nam': 'Vietnam',
};

function resolveTeamNameAlias(name, normalizer) {
  const folded = foldKey(name);
  const compact = folded.replace(/\s+/g, '');
  const mapped =
    TEAM_NAME_ALIAS_TO_STANDARD[folded] || TEAM_NAME_ALIAS_TO_STANDARD[compact];
  if (mapped) return mapped;
  if (normalizer?.teamIndex) {
    const fromIndex =
      normalizer.teamIndex.get(folded) || normalizer.teamIndex.get(compact);
    if (fromIndex) return fromIndex;
    const stripped = stripClubAffixes(stripGenderPrefix(name));
    if (stripped && foldKey(stripped) !== folded) {
      return (
        normalizer.teamIndex.get(foldKey(stripped)) ||
        mapped ||
        name
      );
    }
  } else if (normalizer?.normalizeTeam) {
    return normalizer.normalizeTeam(name);
  }
  return name;
}

/**
 * Compare FotMob team vs streaming-URL team via existing alias/foldKey system.
 * exact = 40, fuzzy (multi-token containment / full token overlap) = 32, else 0.
 * Single-token containment is rejected (Inter Milan vs Milan / AC Milan).
 */
function tokenAbbrevCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** Nottm Forest ↔ Nottingham Forest: every shorter-list token equals or abbreviates a longer-list token. */
function tokensMatchWithAbbreviations(aTok, bTok) {
  if (!aTok.length || !bTok.length) return false;
  const [shortList, longList] = aTok.length <= bTok.length ? [aTok, bTok] : [bTok, aTok];
  if (shortList.length < 2) return false;
  const used = new Set();
  for (const token of shortList) {
    let hit = -1;
    for (let i = 0; i < longList.length; i += 1) {
      if (used.has(i)) continue;
      if (tokenAbbrevCompatible(token, longList[i])) {
        hit = i;
        break;
      }
    }
    if (hit < 0) return false;
    used.add(hit);
  }
  return true;
}

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const row = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) row[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    let prevDiag = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const tmp = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return row[t.length];
}

function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Dynamic fuzzy fallback for transliterations that aliases/foldKey miss.
 * Thai Lan ↔ Thailand (thailan vs thailand), Singapura ↔ Singapore.
 *
 * Guards: both compact names ≥6 chars, length gap ≤2, shared prefix ≥6,
 * Levenshtein ≤2 and ≤25% of the longer name. Rejects Milan/Milano,
 * Australia/Austria, Chelsea/Cheltenham, and one-token substrings.
 */
function compactNamesFuzzyMatch(left, right) {
  const x = String(left || '').replace(/\s+/g, '');
  const y = String(right || '').replace(/\s+/g, '');
  if (!x || !y || x === y) return x === y;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < 6) return false;
  if (long.length - short.length > 2) return false;
  if (commonPrefixLength(short, long) < 6) return false;
  const dist = levenshteinDistance(x, y);
  if (dist < 1 || dist > 2) return false;
  return dist / long.length <= 0.25;
}

function compareTeamIdentity(fotmobName, streamName, normalizer) {
  const a = canonicalizeTeamForMatch(fotmobName, normalizer);
  const b = canonicalizeTeamForMatch(streamName, normalizer);
  if (!a || !b) return { score: 0, kind: 'none', fotmobKey: a, streamKey: b };
  if (a === b) {
    return { score: MATCH_SCORE_WEIGHTS.HOME, kind: 'exact', fotmobKey: a, streamKey: b };
  }

  const compact = (s) => String(s || '').replace(/\s+/g, '');
  if (compact(a) && compact(a) === compact(b)) {
    return { score: MATCH_SCORE_WEIGHTS.HOME, kind: 'exact', fotmobKey: a, streamKey: b };
  }

  const stripYearTokens = (s) =>
    String(s || '')
      .replace(/\b(?:18|19|20)\d{2}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const aYearless = stripYearTokens(a);
  const bYearless = stripYearTokens(b);
  if (aYearless && bYearless && compact(aYearless) === compact(bYearless)) {
    return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
  }

  const aTok = a.split(' ').filter((t) => t.length >= 2);
  const bTok = b.split(' ').filter((t) => t.length >= 2);

  if (tokensMatchWithAbbreviations(aTok, bTok)) {
    return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const shortTok = shorter.split(' ').filter((t) => t.length >= 2);
  const longTok = longer.split(' ').filter((t) => t.length >= 2);
  if (shortTok.length && longer.includes(shorter)) {
    const leftover = longTok.filter((t) => !shortTok.includes(t));
    if (leftover.length && leftover.every((t) => /^\d{2,4}$/.test(t))) {
      return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
    }
  }

  // Distinctive first token: Jagiellonia ↔ Jagiellonia Białystok.
  // 8+ chars so Milan / Inter / Forest cannot attach to a longer club name.
  if (shortTok.length === 1 && longTok.length >= 2) {
    const head = shortTok[0];
    if (head.length >= 8 && head === longTok[0]) {
      return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
    }
  }

  // Multi-token containment only (avoids "milan" matching "inter milan")
  if (shortTok.length >= 2 && longer.includes(shorter)) {
    return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
  }

  if (aTok.length && bTok.length) {
    const setB = new Set(bTok);
    const overlap = aTok.filter((t) => setB.has(t)).length;
    const need = Math.min(aTok.length, bTok.length);
    if (need >= 2 && overlap === need) {
      return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
    }
  }

  if (compactNamesFuzzyMatch(a, b)) {
    return { score: 32, kind: 'fuzzy', fotmobKey: a, streamKey: b };
  }

  return { score: 0, kind: 'none', fotmobKey: a, streamKey: b };
}

function fotmobYangonDate(fotmobMatch) {
  const kick =
    fotmobMatch?.kickoff ||
    fotmobMatch?.utcTime ||
    fotmobMatch?.startTime ||
    fotmobMatch?.kickoffUtc;
  if (fotmobMatch?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(fotmobMatch.date))) {
    return String(fotmobMatch.date);
  }
  return formatDate(kick);
}

function streamYangonDate(stream) {
  if (stream?.yangonDate) return stream.yangonDate;
  const ms = toUtcMillis(
    stream?.utcTimestamp ??
      stream?.utcDate ??
      stream?.utcIso ??
      stream?.kickoff ??
      stream?.ictDateTime
  );
  if (ms == null) return '';
  return DateTime.fromMillis(ms, { zone: 'utc' }).setZone(YANGON_ZONE).toFormat('yyyy-MM-dd');
}

function extraLeagueValidation(fotmobMatch, stream) {
  const fotmobTags = collectLeagueCountryTags(fotmobMatch);
  const streamTags = collectLeagueCountryTags(
    stream,
    stream.url || stream.slug || stream.matchUrl || ''
  );
  if (!fotmobTags.size || !streamTags.size) return { known: false, matches: false };
  for (const tag of streamTags) {
    if (fotmobTags.has(tag)) return { known: true, matches: true };
  }
  return { known: true, matches: false };
}

function emptyScoreResult(reason) {
  return {
    accepted: false,
    status: MATCH_URL_STATUS.REJECTED,
    score: 0,
    reason: reason || 'rejected',
    home: { score: 0, kind: 'none' },
    away: { score: 0, kind: 'none' },
    dateMatched: false,
    timeMatched: false,
    league: { known: false, matches: false },
    ambiguous: false,
  };
}

/**
 * Score a streaming Match URL against a FotMob fixture.
 *
 * Primary identity: Home + Away + Date + Kickoff (canonical Asia/Yangon).
 * League is secondary validation only (used for POSSIBLE_MATCH).
 * Both teams must match — one-team hits are always rejected.
 */
function scoreStreamMatch(fotmobMatch, streamUrlData, options = {}) {
  if (!fotmobMatch || typeof fotmobMatch !== 'object') {
    return emptyScoreResult('missing_fotmob');
  }

  const stream = normalizeStreamUrlData(streamUrlData);
  if (!stream) return emptyScoreResult('missing_stream');

  const normalizer = options.normalizer || null;
  const timeTolerance =
    options.timeToleranceMinutes == null
      ? MATCH_TIME_TOLERANCE_MIN
      : Number(options.timeToleranceMinutes);

  const homeName = fotmobMatch.homeTeam || fotmobMatch.home || '';
  const awayName = fotmobMatch.awayTeam || fotmobMatch.away || '';
  const streamHome = stream.homeTeam || stream.home || '';
  const streamAway = stream.awayTeam || stream.away || '';

  const home = compareTeamIdentity(homeName, streamHome, normalizer);
  const away = compareTeamIdentity(awayName, streamAway, normalizer);

  if (home.score <= 0 || away.score <= 0) {
    return {
      ...emptyScoreResult('teams_mismatch'),
      home,
      away,
    };
  }

  const fotDate = fotmobYangonDate(fotmobMatch);
  const strDate = streamYangonDate(stream);
  const dateKnown = Boolean(fotDate && strDate);
  const dateMatched = dateKnown && fotDate === strDate;

  if (dateKnown && !dateMatched) {
    return {
      ...emptyScoreResult('date_mismatch'),
      home,
      away,
      dateMatched: false,
    };
  }

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
    stream.yangonIso ??
    stream.kickoff ??
    stream.ictDateTime;
  const fotMs = toUtcMillis(fotmobTime);
  const strMs = toUtcMillis(streamTime);
  const timeKnown = fotMs != null && strMs != null;
  const timeMatched = timeKnown && isMatchWithinWindow(fotmobTime, streamTime, timeTolerance);

  if (timeKnown && !timeMatched) {
    return {
      ...emptyScoreResult('time_mismatch'),
      home,
      away,
      dateMatched,
    };
  }

  let score = home.score + away.score;
  if (dateMatched) score += MATCH_SCORE_WEIGHTS.DATE;
  if (timeMatched) score += MATCH_SCORE_WEIGHTS.TIME;

  const league = extraLeagueValidation(fotmobMatch, stream);
  const fuzzyTeam = home.kind === 'fuzzy' || away.kind === 'fuzzy';
  const incompleteClock = !dateKnown || !timeKnown;

  // Cap incomplete / fuzzy identity at POSSIBLE so league extra-validation runs
  if ((fuzzyTeam || incompleteClock) && score >= MATCH_SCORE_WEIGHTS.CONFIRMED_MIN) {
    score = MATCH_SCORE_WEIGHTS.CONFIRMED_MIN - 1;
  }

  if (score < MATCH_SCORE_WEIGHTS.POSSIBLE_MIN) {
    return {
      accepted: false,
      status: MATCH_URL_STATUS.REJECTED,
      score,
      reason: 'below_threshold',
      home,
      away,
      dateMatched,
      timeMatched,
      league,
      ambiguous: false,
    };
  }

  if (score >= MATCH_SCORE_WEIGHTS.CONFIRMED_MIN) {
    return {
      accepted: true,
      status: MATCH_URL_STATUS.CONFIRMED,
      score,
      reason: 'confirmed',
      home,
      away,
      dateMatched,
      timeMatched,
      league,
      ambiguous: false,
    };
  }

  // POSSIBLE_MATCH (75–89): extra validation via league when the site provided one.
  // Streaming sites often mislabel league — missing tags do not reject.
  // A *known conflicting* league on a fuzzy team match is rejected.
  if (fuzzyTeam && league.known && !league.matches) {
    return {
      accepted: false,
      status: MATCH_URL_STATUS.REJECTED,
      score,
      reason: 'possible_league_conflict',
      home,
      away,
      dateMatched,
      timeMatched,
      league,
      ambiguous: false,
    };
  }

  return {
    accepted: true,
    status: MATCH_URL_STATUS.FOUND,
    score,
    reason: 'possible_accepted',
    home,
    away,
    dateMatched,
    timeMatched,
    league,
    ambiguous: false,
  };
}

/**
 * Boolean wrapper kept for existing call sites.
 * League is secondary — skipLeagueCheck is accepted but no longer required for a hit.
 */
function matchStreamToFotmob(fotmobMatch, streamUrlData, options = {}) {
  const scored = scoreStreamMatch(fotmobMatch, streamUrlData, {
    ...options,
    timeToleranceMinutes:
      options.timeToleranceMinutes != null
        ? options.timeToleranceMinutes
        : options.windowMinutes != null && Number(options.windowMinutes) <= 15
          ? Number(options.windowMinutes)
          : MATCH_TIME_TOLERANCE_MIN,
  });
  return Boolean(scored.accepted);
}

module.exports = {
  ICT_ZONE,
  YANGON_ZONE,
  TEAM_NOISE_WORDS,
  LEAGUE_COUNTRY_GROUPS,
  MATCH_SCORE_WEIGHTS,
  MATCH_URL_STATUS,
  parseStreamUrl,
  cleanTeamName,
  isMatchWithinWindow,
  matchStreamToFotmob,
  scoreStreamMatch,
  compareTeamIdentity,
  compactNamesFuzzyMatch,
  canonicalizeTeamForMatch,
  toUtcMillis,
  parseIctClock,
  slugToText,
  titleCaseWords,
  extractMatchSlug,
  stripDynamicSlugTail,
  collectLeagueCountryTags,
  coreTeamKeywords,
  canonicalizeLeagueTag,
  teamNamesInUrl,
  leagueCountryMatches,
};
