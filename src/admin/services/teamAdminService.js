const fs = require('fs');
const path = require('path');
const { JsonStore } = require('../store/jsonStore');

/**
 * Admin-managed teams (standardName, aliases, logo).
 * Seeded from config/teams.json on first use.
 */
class TeamAdminService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin'), env = process.env) {
    this.configPath = path.resolve(
      process.cwd(),
      env.LOCAL_CONFIG_DIR || './config',
      'teams.json'
    );
    this.store = new JsonStore(path.join(dataDir, 'team-settings.json'), {
      teams: {},
      seeded: false,
    });
    this._ensureSeed();
  }

  _ensureSeed() {
    const doc = this.store.read();
    if (doc.seeded && Object.keys(doc.teams || {}).length) return;
    const seeded = {};
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        for (const t of raw.teams || []) {
          const name = t.standardName;
          if (!name) continue;
          seeded[name] = {
            standardName: name,
            aliases: Array.isArray(t.aliases) ? t.aliases : [name],
            logo: t.logo || null,
            enabled: true,
          };
        }
      }
    } catch {
      // ignore seed errors
    }
    this.store.write({
      teams: { ...(doc.teams || {}), ...seeded },
      seeded: true,
    });
  }

  list() {
    const doc = this.store.read();
    return Object.values(doc.teams || {})
      .filter((t) => t && t.enabled !== false)
      .sort((a, b) => String(a.standardName).localeCompare(String(b.standardName)));
  }

  listAll() {
    const doc = this.store.read();
    return Object.values(doc.teams || {}).sort((a, b) =>
      String(a.standardName).localeCompare(String(b.standardName))
    );
  }

  add({ standardName, aliases, logo } = {}) {
    const name = String(standardName || '').trim();
    if (!name) throw new Error('Team name is required');
    const doc = this.store.read();
    doc.teams = doc.teams || {};
    if (doc.teams[name] && doc.teams[name].enabled !== false) {
      throw new Error('Team already exists');
    }
    const aliasList = Array.isArray(aliases)
      ? aliases.map((a) => String(a).trim()).filter(Boolean)
      : String(aliases || '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
    doc.teams[name] = {
      standardName: name,
      aliases: aliasList.length ? aliasList : [name],
      logo: String(logo || '').trim() || null,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
    this.store.write(doc);
    return doc.teams[name];
  }

  remove(standardName) {
    const name = String(standardName || '').trim();
    const doc = this.store.read();
    if (!doc.teams?.[name]) throw new Error('Team not found');
    delete doc.teams[name];
    this.store.write(doc);
    return true;
  }

  findLogo(standardName) {
    const row = this.store.read().teams?.[standardName];
    return row?.logo || null;
  }
}

module.exports = { TeamAdminService };
