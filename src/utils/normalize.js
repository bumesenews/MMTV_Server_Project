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
const AMBIGUOUS_LEAGUE_KEYS = new Set(['serie a', 'premier league', 'epl', 'pl']);

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

function isItalyCountry(countryFold) {
  return Boolean(
    countryFold && (countryFold.includes('ital') || countryFold === 'ita')
  );
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
        return null;
      }
      return mapped;
    }

    // FotMob often prefixes with country codes (INT Club Friendlies, ENG Premier League,
    // ARM Premier League). Strip a short leading token and retry — still gated for
    // ambiguous names so ARM/ECU cannot collapse into EPL/Serie A.
    const strippedKey = key.replace(
      /^(int|eng|esp|ita|ger|fra|ned|por|bra|kor|usa|arm|ecu|tan|uefa|fifa|conmebol|afc)\s+/,
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
    const leadPrefixes = ['', 'uefa ', 'fifa ', 'english ', 'england ', 'spanish ', 'spain ', 'italian ', 'italy ', 'german ', 'germany ', 'french ', 'france ', 'armenian ', 'armenia ', 'tanzanian ', 'tanzania '];
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
    const mapped = this.teamIndex.get(foldKey(cleaned));
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
   * Fix mislabeled matches (e.g. TAN/ARM Premier League → EPL) using FotMob
   * originalNames / country / fotmob league id. Safe no-op when unchanged.
   */
  repairMatchLeague(match) {
    if (!match || typeof match !== 'object') return match;

    const fotmob = match.originalNames?.fotmob || {};
    const rawLeague =
      cleanText(fotmob.league) ||
      cleanText(match.rawLeague) ||
      cleanText(match.league);
    const country =
      cleanText(fotmob.country) ||
      cleanText(match.country) ||
      '';
    const fotmobId =
      match.leagueFotmobId ||
      match.tournamentId ||
      fotmob.leagueId ||
      null;

    if (!rawLeague && fotmobId == null) return match;

    const fixed = this.filterAllowedLeague(rawLeague, { country, fotmobId });
    if (!fixed || fixed === match.league) return match;

    logEvent(events.LEAGUE_FILTERED, 'League label repaired', {
      matchId: match.matchId,
      from: match.league,
      to: fixed,
      rawLeague,
      country: country || null,
      fotmobId: fotmobId || null,
    });

    return { ...match, league: fixed };
  }

  repairMatchLeagues(matches = []) {
    return (matches || []).map((m) => this.repairMatchLeague(m));
  }
}

module.exports = {
  cleanText,
  foldKey,
  buildAliasIndex,
  buildFotmobIdIndex,
  Normalizer,
};
