const path = require('path');
const { JsonStore } = require('../store/jsonStore');

const DEFAULT_LEAGUES = [
  'UEFA Champions League',
  'UEFA Europa League',
  'English Premier League (EPL)',
  'La Liga',
  'Serie A',
  'Bundesliga',
  'Ligue 1',
  'FIFA World Cup',
  'UEFA Euro',
  'Copa América',
  'V.League 1 (Vietnam)',
];

class LeagueAdminService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    const leagues = {};
    for (const name of DEFAULT_LEAGUES) {
      leagues[name] = { enabled: true, standardName: name };
    }
    this.store = new JsonStore(path.join(dataDir, 'league-settings.json'), { leagues });
  }

  list() {
    const doc = this.store.read();
    return DEFAULT_LEAGUES.map((name) => {
      const row = doc.leagues?.[name] || { enabled: true, standardName: name };
      return {
        standardName: name,
        enabled: row.enabled !== false,
      };
    });
  }

  setEnabled(standardName, enabled) {
    if (!DEFAULT_LEAGUES.includes(standardName)) {
      throw new Error('Unsupported league');
    }
    this.store.update((doc) => {
      doc.leagues = doc.leagues || {};
      doc.leagues[standardName] = {
        standardName,
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
      };
      return doc;
    });
    return this.list().find((l) => l.standardName === standardName);
  }

  isEnabled(standardName) {
    const row = this.store.read().leagues?.[standardName];
    if (!row) return true;
    return row.enabled !== false;
  }

  filterMatches(matches = []) {
    return matches.filter((m) => this.isEnabled(m.league));
  }

  /**
   * Filter league alias list used by Normalizer / FotMob filter.
   */
  filterAllowedLeagueDefs(allowedLeagues = []) {
    return (allowedLeagues || []).filter((l) => this.isEnabled(l.standardName));
  }
}

module.exports = { LeagueAdminService, DEFAULT_LEAGUES };
