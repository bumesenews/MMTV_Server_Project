const { logger, logEvent, events } = require('./logger');

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function foldKey(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripClubAffixes(value) {
  let s = cleanText(value);
  if (!s) return '';
  const affix =
    /^(fc|fk|sc|cf|ac|afc|cfc|ifc|sk|nk|bk|ifk|sd)\s+|\s+(fc|fk|sc|cf|ac|afc|cfc|ifc|sk|nk|bk|ifk|sd|football club|sporting club)$/i;
  let prev = null;
  while (s && s !== prev) {
    prev = s;
    s = s.replace(affix, ' ').replace(/\s+/g, ' ').trim();
  }
  return s;
}

/** Vietnamese "nữ" / English women's prefix used in streaming slugs. */
const GENDER_PREFIX_RE = /^(nu|nữ|nu+|wfc|women|womens|ladies)\s+/i;

function stripGenderPrefix(value) {
  const s = cleanText(value);
  if (!s) return '';
  return s.replace(GENDER_PREFIX_RE, '').trim() || s;
}

/**
 * Canonical key for team identity matching (aliases applied by Normalizer first).
 */
function teamMatchKey(value) {
  const stripped = stripClubAffixes(stripGenderPrefix(value));
  return foldKey(stripped || value);
}

function buildAliasIndex(entries, nameKey = 'standardName') {
  const index = new Map();
  for (const entry of entries || []) {
    const standard = cleanText(entry[nameKey] || entry.standardName);
    if (!standard) continue;
    const aliases = [standard, ...(entry.aliases || [])];
    for (const alias of aliases) {
      const key = foldKey(alias);
      if (key) index.set(key, standard);
    }
  }
  return index;
}

function buildFotmobIdIndex(entries) {
  const index = new Map();
  for (const entry of entries || []) {
    const standard = cleanText(entry.standardName);
    if (!standard) continue;
    for (const id of entry.fotmobIds || []) {
      const n = Number(id);
      if (Number.isFinite(n)) index.set(n, standard);
    }
  }
  return index;
}

/** Bare names used by multiple countries — never map without country/id context. */
const AMBIGUOUS_LEAGUE_KEYS = new Set([
  'serie a',
  'premier league',
  'premier division',
  'epl',
  'pl',
  'bundesliga',
]);

function isEnglandCountry(countryFold) {
  return Boolean(
    countryFold &&
      (countryFold === 'eng' ||
        countryFold === 'gb' ||
        countryFold === 'gbr' ||
        countryFold.includes('england') ||
        countryFold.includes('english'))
  );
}

/** FotMob youth / academy comps must never map onto senior EPL / Serie A / etc. */
function isYouthCompetition(value) {
  const key = foldKey(value);
  if (!key) return false;
  return (
    /\bu-?1[5-9]\b/.test(key) ||
    /\bu-?2[0-1]\b/.test(key) ||
    /\b(u18|u19|u20|u21|youth|academy|junior)\b/.test(key)
  );
}

function isItalyCountry(countryFold) {
  return Boolean(
    countryFold && (countryFold.includes('ital') || countryFold === 'ita')
  );
}

function isGermanyCountry(countryFold) {
  return Boolean(
    countryFold &&
      (countryFold === 'ger' ||
        countryFold === 'deu' ||
        countryFold === 'de' ||
        countryFold.includes('german'))
  );
}

/** Pull leading FotMob country code from names like "RUS Premier League". */
function inferCountryCodeFromLeagueName(rawName) {
  const m = String(rawName || '')
    .trim()
    .match(/^([A-Za-z]{3})\s+/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Display labels for FotMob country-coded "XXX Premier League" names.
 * Used so we never invent EPL when the country code is not ENG.
 * Keep in sync with leagues.json entries when those comps are allow-listed.
 */
const COUNTRY_PREMIER_LEAGUE_LABELS = {
  ARM: 'Armenian Premier League',
  AZE: 'Azerbaijani Premier League',
  BIH: 'Bosnian Premier League',
  BLR: 'Belarusian Premier League',
  CAN: 'Canadian Premier League',
  EGY: 'Egyptian Premier League',
  ENG: 'English Premier League (EPL)',
  FRO: 'Faroe Islands Premier League',
  GHA: 'Ghanaian Premier League',
  JOR: 'Jordanian Premier League',
  KAZ: 'Kazakh Premier League',
  RUS: 'Russian Premier League',
  SIN: 'Singapore Premier League',
  TAN: 'Tanzanian Premier League',
  THA: 'Thai Premier League',
  UKR: 'Ukrainian Premier League',
  WAL: 'Welsh Premier League',
};

function countryPremierLeagueLabel(countryCode) {
  const code = String(countryCode || '')
    .trim()
    .toUpperCase();
  if (!code) return null;
  return COUNTRY_PREMIER_LEAGUE_LABELS[code] || `${code} Premier League`;
}

/**
 * True when FotMob evidence shows this is NOT English Premier League.
 * (Team identity is irrelevant — only league/country fields matter.)
 */
function isFalseEnglishPremierLabel(match) {
  const league = cleanText(match?.league);
  if (league !== 'English Premier League (EPL)') return false;

  const fotmob = match?.originalNames?.fotmob || {};
  const raw = cleanText(fotmob.league || match?.rawLeague || '');
  const country = cleanText(fotmob.country || match?.country || '');
  const inferred = inferCountryCodeFromLeagueName(raw);
  if (isYouthCompetition(raw) || isYouthCompetition(league)) return true;
  if (
    isYouthCompetition(match?.homeTeam) ||
    isYouthCompetition(match?.awayTeam)
  ) {
    return true;
  }
  const evidence = foldKey(`${country} ${inferred} ${raw}`);
  if (!raw && !country && !inferred) return false; // no evidence — don't touch real/manual EPL
  if (/\b(eng|england|english)\b/.test(evidence)) return false;
  if (inferred === 'ENG') return false;
  return true;
}

/**
 * True when an ambiguous alias may be accepted for this raw key + country.
 * "ENG Premier League" / "English Premier League" carry England in the name itself.
 */
function ambiguousLeagueAllowed(aliasKey, rawKey, countryFold) {
  if (aliasKey === 'serie a') {
    return isItalyCountry(countryFold) || /\b(ita|italy|italian)\b/.test(rawKey);
  }
  if (aliasKey === 'premier league' || aliasKey === 'epl' || aliasKey === 'pl') {
    return isEnglandCountry(countryFold) || /\b(eng|england|english)\b/.test(rawKey);
  }
  if (aliasKey === 'premier division') {
    // Bare "Premier Division" is used by multiple countries (e.g. Belarus).
    return (
      Boolean(countryFold) &&
      (countryFold.includes('belarus') ||
        countryFold === 'blr' ||
        /\b(blr|belarus|belarusian)\b/.test(rawKey))
    );
  }
  if (aliasKey === 'bundesliga') {
    return isGermanyCountry(countryFold) || /\b(ger|deu|germany|german)\b/.test(rawKey);
  }
  return true;
}

class Normalizer {
  constructor({ leagues = [], teams = [] } = {}) {
    this.leagues = leagues || [];
    this.leagueIndex = buildAliasIndex(leagues);
    this.fotmobIdIndex = buildFotmobIdIndex(leagues);
    this.teamIndex = buildAliasIndex(teams);
    this.allowedLeagues = new Set(
      (leagues || []).map((l) => cleanText(l.standardName)).filter(Boolean)
    );
  }

  reload({ leagues = [], teams = [] } = {}) {
    this.leagues = leagues || [];
    this.leagueIndex = buildAliasIndex(leagues);
    this.fotmobIdIndex = buildFotmobIdIndex(leagues);
    this.teamIndex = buildAliasIndex(teams);
    this.allowedLeagues = new Set(
      (leagues || []).map((l) => cleanText(l.standardName)).filter(Boolean)
    );
  }

  /**
   * Prefer FotMob league id when present (avoids Ecuador Serie A → Italy Serie A,
   * Armenia Premier League → English Premier League).
   * Then try "Country + name", exact alias, then safe prefix match
   * (e.g. "Europa League Qualification", "ASEAN Championship Grp. A").
   * Never map Women's / INT women's comps onto men's UEFA CL via substring.
   * Never default bare "Premier League" to EPL without England context.
   */
  normalizeLeague(rawName, { fotmobId = null, country = '' } = {}) {
    const id = Number(fotmobId);
    if (Number.isFinite(id) && this.fotmobIdIndex.has(id)) {
      return this.fotmobIdIndex.get(id);
    }

    const cleaned = cleanText(rawName);
    if (!cleaned) return null;

    if (isYouthCompetition(cleaned)) return null;

    const countryClean = cleanText(country);
    const countryFold = foldKey(countryClean);
    if (countryClean) {
      const withCountry = this.leagueIndex.get(foldKey(`${countryClean} ${cleaned}`));
      if (withCountry) return withCountry;
    }

    const key = foldKey(cleaned);
    const mapped = this.leagueIndex.get(key);
    if (mapped) {
      // Bare "Serie A" / "Premier League" are used by multiple countries on FotMob.
      // Only accept with matching country context or via fotmobIds above.
      if (AMBIGUOUS_LEAGUE_KEYS.has(key)) {
        if (ambiguousLeagueAllowed(key, key, countryFold)) return mapped;
        // Non-England "Premier League" with a country code → country label, never EPL.
        if (key === 'premier league' || key === 'epl' || key === 'pl') {
          const code =
            String(countryClean || '').toUpperCase() ||
            inferCountryCodeFromLeagueName(cleaned);
          if (code && code !== 'ENG') {
            return countryPremierLeagueLabel(code);
          }
        }
        return null;
      }
      return mapped;
    }

    // "RUS Premier League" / "TAN Premier League" — resolve by code before stripping
    // collapses them onto bare EPL aliases.
    const codedPremier = key.match(
      /^([a-z]{3})\s+premier\s+league(?:\s+qualification)?$/
    );
    if (codedPremier) {
      const code = codedPremier[1].toUpperCase();
      const labeled = countryPremierLeagueLabel(code);
      const labeledKey = foldKey(labeled);
      const fromLabel = this.leagueIndex.get(labeledKey);
      if (fromLabel) return fromLabel;
      const fromCoded = this.leagueIndex.get(key);
      if (fromCoded) return fromCoded;
      if (code === 'ENG') return 'English Premier League (EPL)';
      return labeled;
    }

    // FotMob often prefixes with country codes (INT Club Friendlies, ENG Premier League,
    // ARM Premier League). Strip a short leading token and retry — still gated for
    // ambiguous names so ARM/ECU cannot collapse into EPL/Serie A.
    const strippedKey = key.replace(
      /^(int|eng|esp|ita|ger|fra|ned|por|bra|kor|usa|arm|aut|aze|bih|ecu|tan|rus|blr|ukr|egy|gha|jor|kaz|tha|wal|can|fro|sin|uefa|fifa|conmebol|afc)\s+/,
      ''
    );
    if (strippedKey && strippedKey !== key) {
      const strippedMapped = this.leagueIndex.get(strippedKey);
      if (strippedMapped) {
        if (AMBIGUOUS_LEAGUE_KEYS.has(strippedKey)) {
          if (ambiguousLeagueAllowed(strippedKey, key, countryFold)) {
            return strippedMapped;
          }
        } else {
          return strippedMapped;
        }
      }
    }

    // Reject women's competitions unless the alias/standard is explicitly women's
    const isWomensRaw = /\bwom[e]?n'?s?\b|\bfemale\b|\bladies\b/i.test(key);

    // Fuzzy: longest alias where the raw name STARTS with the alias
    // (optionally after a known competition prefix). No mid-string includes.
    const leadPrefixes = ['', 'uefa ', 'fifa ', 'english ', 'england ', 'spanish ', 'spain ', 'italian ', 'italy ', 'german ', 'germany ', 'french ', 'france ', 'armenian ', 'armenia ', 'tanzanian ', 'tanzania ', 'russian ', 'russia ', 'belarusian ', 'belarus ', 'ukrainian ', 'ukraine '];
    let best = null;
    let bestLen = 0;
    for (const [aliasKey, standard] of this.leagueIndex.entries()) {
      if (!aliasKey || aliasKey.length < 5) continue;
      if (AMBIGUOUS_LEAGUE_KEYS.has(key) || AMBIGUOUS_LEAGUE_KEYS.has(aliasKey)) {
        if (!ambiguousLeagueAllowed(aliasKey, key, countryFold)) continue;
      }
      // Do not map Summer Series / friendlies onto EPL via "Premier League" prefix
      if (
        (aliasKey === 'premier league' || aliasKey === 'english premier league' || aliasKey === 'epl') &&
        /summer\s*series|friendl/.test(key)
      ) {
        continue;
      }
      const isWomensAlias = /\bwom[e]?n'?s?\b|\bfemale\b|\bladies\b/i.test(aliasKey);
      if (isWomensRaw && !isWomensAlias) continue;

      let hit = false;
      for (const prefix of leadPrefixes) {
        const candidate = `${prefix}${aliasKey}`;
        if (key === candidate || key.startsWith(`${candidate} `) || key.startsWith(`${candidate} grp`) || key.startsWith(`${candidate} group`) || key.startsWith(`${candidate} qualification`)) {
          hit = true;
          break;
        }
      }
      if (hit && aliasKey.length > bestLen) {
        best = standard;
        bestLen = aliasKey.length;
      }
    }
    if (best) return best;

    // Prefer country + league.name when nothing mapped (never invent EPL).
    if (countryClean && !foldKey(cleaned).includes(countryFold)) {
      return `${countryClean} ${cleaned}`.trim();
    }
    return cleaned;
  }

  isAllowedLeague(rawOrStandard, opts = {}) {
    const standard = this.normalizeLeague(rawOrStandard, opts);
    return Boolean(standard && this.allowedLeagues.has(standard));
  }

  normalizeTeam(rawName) {
    const cleaned = cleanText(rawName);
    if (!cleaned) return cleaned;

    const lookup = (name) => {
      const key = foldKey(name);
      if (!key) return null;
      return this.teamIndex.get(key) || null;
    };

    let mapped = lookup(cleaned);
    if (!mapped) {
      const stripped = stripClubAffixes(stripGenderPrefix(cleaned));
      if (stripped && foldKey(stripped) !== foldKey(cleaned)) {
        mapped = lookup(stripped);
      }
    }

    if (mapped && mapped !== cleaned) {
      logEvent(events.TEAM_NORMALIZED, 'Team normalized', {
        from: cleaned,
        to: mapped,
      });
    }
    return mapped || cleaned;
  }

  filterAllowedLeague(rawLeague, opts = {}) {
    const standard = this.normalizeLeague(rawLeague, opts);
    const allowed = Boolean(standard && this.allowedLeagues.has(standard));
    if (!allowed) {
      logger.debug('League filtered out', {
        league: rawLeague,
        standard,
        fotmobId: opts.fotmobId || null,
        country: opts.country || null,
      });
    } else {
      logEvent(events.LEAGUE_FILTERED, 'League allowed', {
        league: rawLeague,
        standard,
        fotmobId: opts.fotmobId || null,
      });
    }
    return allowed ? standard : null;
  }

  /**
   * Fix mislabeled matches (e.g. RUS/TAN/ARM Premier League → EPL) using FotMob
   * originalNames / country / fotmob league id.
   * Never leaves a false EPL label when FotMob clearly named another country.
   */
  repairMatchLeague(match) {
    if (!match || typeof match !== 'object') return match;

    const fotmob = match.originalNames?.fotmob || {};
    const rawLeague =
      cleanText(fotmob.league) ||
      cleanText(match.rawLeague) ||
      '';
    const inferredCountry = inferCountryCodeFromLeagueName(rawLeague);
    const country =
      cleanText(fotmob.country) ||
      cleanText(match.country) ||
      inferredCountry ||
      '';
    const fotmobId =
      match.leagueFotmobId ||
      match.tournamentId ||
      fotmob.leagueId ||
      null;

    if (!rawLeague && fotmobId == null) return match;

    const opts = { country, fotmobId };
    const fixed = this.filterAllowedLeague(rawLeague, opts);
    if (fixed && fixed !== match.league) {
      logEvent(events.LEAGUE_FILTERED, 'League label repaired', {
        matchId: match.matchId,
        from: match.league,
        to: fixed,
        rawLeague,
        country: country || null,
        fotmobId: fotmobId || null,
      });
      return {
        ...match,
        league: fixed,
        leagueName: fixed,
        country: country || match.country || null,
      };
    }

    // Stale rows: league stuck as EPL while FotMob original is another country.
    const current = cleanText(match.league);
    const rawFold = foldKey(rawLeague);
    const falseEpl =
      current === 'English Premier League (EPL)' &&
      rawFold &&
      !/\b(eng|england|english)\b/.test(rawFold) &&
      !isEnglandCountry(foldKey(country));
    if (falseEpl) {
      const display =
        this.normalizeLeague(rawLeague, opts) ||
        (country && !rawFold.includes(foldKey(country))
          ? `${country} ${rawLeague}`
          : rawLeague);
      if (display && display !== current) {
        logEvent(events.LEAGUE_FILTERED, 'League label repaired (false EPL)', {
          matchId: match.matchId,
          from: current,
          to: display,
          rawLeague,
          country: country || null,
        });
        return {
          ...match,
          league: display,
          leagueName: display,
          country: country || match.country || null,
        };
      }
    }

    return match;
  }

  repairMatchLeagues(matches = []) {
    return (matches || []).map((m) => this.repairMatchLeague(m));
  }
}

module.exports = {
  cleanText,
  foldKey,
  stripClubAffixes,
  stripGenderPrefix,
  teamMatchKey,
  buildAliasIndex,
  buildFotmobIdIndex,
  Normalizer,
  inferCountryCodeFromLeagueName,
  countryPremierLeagueLabel,
  isFalseEnglishPremierLabel,
  isYouthCompetition,
  COUNTRY_PREMIER_LEAGUE_LABELS,
};
