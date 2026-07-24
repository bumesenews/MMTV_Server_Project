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
   * Prefer FotMob league id when present (avoids Ecuador Serie A → Italy Serie A).
   * Then try "Country + name", exact alias, then prefix/contains alias match
   * (e.g. "Europa League Qualification", "ASEAN Championship Grp. A").
   */
  normalizeLeague(rawName, { fotmobId = null, country = '' } = {}) {
    const id = Number(fotmobId);
    if (Number.isFinite(id) && this.fotmobIdIndex.has(id)) {
      return this.fotmobIdIndex.get(id);
    }

    const cleaned = cleanText(rawName);
    if (!cleaned) return null;

    const countryClean = cleanText(country);
    if (countryClean) {
      const withCountry = this.leagueIndex.get(foldKey(`${countryClean} ${cleaned}`));
      if (withCountry) return withCountry;
    }

    const key = foldKey(cleaned);
    const mapped = this.leagueIndex.get(key);
    if (mapped) {
      // Bare "Serie A" is ambiguous (Italy id 55 vs Ecuador id 246 on FotMob).
      // Only accept with Italy context or via fotmobIds above.
      if (key === 'serie a') {
        const countryFold = foldKey(countryClean);
        if (countryFold && (countryFold.includes('ital') || countryFold === 'ita')) {
          return mapped;
        }
        return null;
      }
      return mapped;
    }

    // Fuzzy: longest alias that is a prefix of the raw name (or vice versa for short forms)
    let best = null;
    let bestLen = 0;
    for (const [aliasKey, standard] of this.leagueIndex.entries()) {
      if (!aliasKey || aliasKey.length < 5) continue;
      if (key === 'serie a' || aliasKey === 'serie a') continue;
      const hit =
        key === aliasKey ||
        key.startsWith(`${aliasKey} `) ||
        key.startsWith(`${aliasKey} grp`) ||
        key.startsWith(`${aliasKey} group`) ||
        key.startsWith(`${aliasKey} qualification`) ||
        key.includes(` ${aliasKey} `);
      if (hit && aliasKey.length > bestLen) {
        best = standard;
        bestLen = aliasKey.length;
      }
    }
    if (best) return best;

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
}

module.exports = {
  cleanText,
  foldKey,
  buildAliasIndex,
  buildFotmobIdIndex,
  Normalizer,
};
