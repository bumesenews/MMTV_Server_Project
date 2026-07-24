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
  'FIFA Club World Cup',
  'UEFA Euro',
  'Copa América',
  'AFF Cup',
  'K League 1 (KOR D1)',
  'Brazil Serie A (BRA D1)',
  'V.League 1 (Vietnam)',
];

class LeagueAdminService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    const leagues = {};
    for (const name of DEFAULT_LEAGUES) {
      leagues[name] = { enabled: true, standardName: name, iconUrl: null };
    }
    this.store = new JsonStore(path.join(dataDir, 'league-settings.json'), { leagues });
    this._ensureDefaults();
  }

  _ensureDefaults() {
    this.store.update((doc) => {
      doc.leagues = doc.leagues || {};
      for (const name of DEFAULT_LEAGUES) {
        if (!doc.leagues[name]) {
          doc.leagues[name] = { enabled: true, standardName: name, iconUrl: null };
        } else if (doc.leagues[name].iconUrl === undefined) {
          doc.leagues[name].iconUrl = doc.leagues[name].iconUrl || null;
        }
      }
      return doc;
    });
  }

  list() {
    const doc = this.store.read();
    return Object.values(doc.leagues || {})
      .filter((row) => row && row.deleted !== true)
      .map((row) => ({
        standardName: row.standardName,
        enabled: row.enabled !== false,
        iconUrl: row.iconUrl || null,
        custom: !DEFAULT_LEAGUES.includes(row.standardName),
      }))
      .sort((a, b) => a.standardName.localeCompare(b.standardName));
  }

  add({ standardName, iconUrl, enabled = true } = {}) {
    const name = String(standardName || '').trim();
    if (!name) throw new Error('League name is required');
    const doc = this.store.read();
    doc.leagues = doc.leagues || {};
    if (doc.leagues[name] && doc.leagues[name].deleted !== true) {
      throw new Error('League already exists');
    }
    doc.leagues[name] = {
      standardName: name,
      enabled: enabled !== false,
      iconUrl: String(iconUrl || '').trim() || null,
      deleted: false,
      updatedAt: new Date().toISOString(),
    };
    this.store.write(doc);
    return this.list().find((l) => l.standardName === name);
  }

  update(standardName, patch = {}) {
    const name = String(standardName || '').trim();
    const doc = this.store.read();
    const row = doc.leagues?.[name];
    if (!row || row.deleted) throw new Error('League not found');
    doc.leagues[name] = {
      ...row,
      ...(patch.enabled != null ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.iconUrl !== undefined
        ? { iconUrl: String(patch.iconUrl || '').trim() || null }
        : {}),
      ...(patch.standardName && patch.standardName !== name
        ? { standardName: String(patch.standardName).trim() }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    // Rename key if standardName changed
    if (patch.standardName && patch.standardName !== name) {
      const newName = String(patch.standardName).trim();
      doc.leagues[newName] = { ...doc.leagues[name], standardName: newName };
      delete doc.leagues[name];
    }
    this.store.write(doc);
    const finalName = patch.standardName ? String(patch.standardName).trim() : name;
    return this.list().find((l) => l.standardName === finalName);
  }

  setEnabled(standardName, enabled) {
    return this.update(standardName, { enabled });
  }

  remove(standardName) {
    const name = String(standardName || '').trim();
    const doc = this.store.read();
    if (!doc.leagues?.[name] || doc.leagues[name].deleted) {
      throw new Error('League not found');
    }
    // Soft-delete so filter treats as disabled/gone; hard-remove custom
    if (DEFAULT_LEAGUES.includes(name)) {
      doc.leagues[name] = {
        ...doc.leagues[name],
        deleted: true,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
    } else {
      delete doc.leagues[name];
    }
    this.store.write(doc);
    return true;
  }

  getIcon(standardName) {
    const row = this.store.read().leagues?.[standardName];
    if (!row || row.deleted) return null;
    return row.iconUrl || null;
  }

  isEnabled(standardName) {
    const row = this.store.read().leagues?.[standardName];
    if (!row) return true; // unknown leagues from scraper still allowed unless deleted
    if (row.deleted) return false;
    return row.enabled !== false;
  }

  filterMatches(matches = []) {
    return matches.filter((m) => this.isEnabled(m.league));
  }

  filterAllowedLeagueDefs(allowedLeagues = []) {
    return (allowedLeagues || []).filter((l) => this.isEnabled(l.standardName));
  }
}

module.exports = { LeagueAdminService, DEFAULT_LEAGUES };
