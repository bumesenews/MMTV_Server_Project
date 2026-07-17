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

class Normalizer {
  constructor({ leagues = [], teams = [] } = {}) {
    this.leagueIndex = buildAliasIndex(leagues);
    this.teamIndex = buildAliasIndex(teams);
    this.allowedLeagues = new Set(
      (leagues || []).map((l) => cleanText(l.standardName)).filter(Boolean)
    );
  }

  reload({ leagues = [], teams = [] } = {}) {
    this.leagueIndex = buildAliasIndex(leagues);
    this.teamIndex = buildAliasIndex(teams);
    this.allowedLeagues = new Set(
      (leagues || []).map((l) => cleanText(l.standardName)).filter(Boolean)
    );
  }

  normalizeLeague(rawName) {
    const cleaned = cleanText(rawName);
    if (!cleaned) return null;
    const mapped = this.leagueIndex.get(foldKey(cleaned));
    return mapped || cleaned;
  }

  isAllowedLeague(rawOrStandard) {
    const standard = this.normalizeLeague(rawOrStandard);
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

  filterAllowedLeague(rawLeague) {
    const standard = this.normalizeLeague(rawLeague);
    const allowed = this.isAllowedLeague(standard);
    if (!allowed) {
      logger.debug('League filtered out', { league: rawLeague, standard });
    } else {
      logEvent(events.LEAGUE_FILTERED, 'League allowed', {
        league: rawLeague,
        standard,
      });
    }
    return allowed ? standard : null;
  }
}

module.exports = {
  cleanText,
  foldKey,
  buildAliasIndex,
  Normalizer,
};
