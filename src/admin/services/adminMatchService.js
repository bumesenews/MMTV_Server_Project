const {
  emptyAdminMatchDoc,
  toAdminMatchDoc,
  preserveDiscoveredFields,
  listOverrideEntries,
  upsertAdminEntry,
  removeAdminEntry,
  findAdminEntry,
  applyAdminMatchDocToMatches,
} = require('../../utils/adminMatch');

class AdminMatchService {
  constructor(configAdmin) {
    this.config = configAdmin;
    this._doc = null;
  }

  async load(force = false) {
    if (this._doc && !force) return this._doc;
    const remote = await this.config.getAdminMatchConfig();
    this._doc = remote?.content || emptyAdminMatchDoc();
    if (!Array.isArray(this._doc.matches)) this._doc = emptyAdminMatchDoc();
    return this._doc;
  }

  listSync() {
    return listOverrideEntries(this._doc || emptyAdminMatchDoc());
  }

  async list() {
    const doc = await this.load();
    return listOverrideEntries(doc);
  }

  async saveFullPayload(payload, { actor } = {}) {
    if (!this._doc) await this.load();
    const incoming = toAdminMatchDoc(payload);
    const doc = preserveDiscoveredFields(this._doc || emptyAdminMatchDoc(), incoming);
    const saved = await this.config.saveAdminMatchConfig(doc, {
      actor,
      message: 'chore: sync admin-match.json (full matches)',
    });
    this._doc = doc;
    return saved;
  }

  async get(matchId) {
    const doc = await this.load();
    return findAdminEntry(doc, matchId);
  }

  async upsert(input, { actor } = {}) {
    const doc = await this.load(true);
    const next = upsertAdminEntry(doc, input);
    const saved = await this.config.saveAdminMatchConfig(next, {
      actor,
      message: `chore: upsert admin-match ${input.matchId}`,
    });
    this._doc = next;
    return { entry: findAdminEntry(next, input.matchId), doc: next, saved };
  }

  async remove(matchId, { actor } = {}) {
    const doc = await this.load(true);
    const next = removeAdminEntry(doc, matchId);
    const saved = await this.config.saveAdminMatchConfig(next, {
      actor,
      message: `chore: remove admin-match ${matchId}`,
    });
    this._doc = next;
    return { doc: next, saved };
  }

  applyToMatches(matches) {
    return applyAdminMatchDocToMatches(matches, this._doc || emptyAdminMatchDoc());
  }

  async applyToMatchesAsync(matches) {
    const doc = await this.load();
    return applyAdminMatchDocToMatches(matches, doc);
  }
}

module.exports = { AdminMatchService };
