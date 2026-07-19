const path = require('path');
const { JsonStore } = require('../store/jsonStore');
const { listManageableSourceNames } = require('../../sources/registry');

/** Fallback names when sources.json is unavailable. */
const DEFAULT_SOURCE_NAMES = listManageableSourceNames(null);

class SourceAdminService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    const sources = {};
    for (const name of DEFAULT_SOURCE_NAMES) {
      sources[name] = {
        name,
        enabled: true,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        totalStreamsCollected: 0,
        lastStreamCount: 0,
      };
    }
    this.store = new JsonStore(path.join(dataDir, 'source-settings.json'), { sources });
  }

  knownNames(sourcesDoc = null) {
    const fromStore = Object.keys(this.store.read().sources || {});
    return [...new Set([...listManageableSourceNames(sourcesDoc), ...fromStore])];
  }

  list(sourcesDoc = null) {
    const doc = this.store.read();
    return this.knownNames(sourcesDoc).map((name) => {
      const row = doc.sources?.[name] || { name, enabled: true };
      return {
        name,
        enabled: row.enabled !== false,
        lastSuccessAt: row.lastSuccessAt || null,
        lastErrorAt: row.lastErrorAt || null,
        lastError: row.lastError || null,
        totalStreamsCollected: row.totalStreamsCollected || 0,
        lastStreamCount: row.lastStreamCount || 0,
      };
    });
  }

  isEnabled(name) {
    const row = this.store.read().sources?.[name];
    if (!row) return true;
    return row.enabled !== false;
  }

  setEnabled(name, enabled) {
    // Allow any source name (config-driven expansion); unknown names get created.
    this.store.update((doc) => {
      doc.sources = doc.sources || {};
      doc.sources[name] = {
        ...(doc.sources[name] || { name }),
        name,
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
      };
      return doc;
    });
    return this.list().find((s) => s.name === name);
  }

  recordSuccess(name, streamCount = 0) {
    this.store.update((doc) => {
      const cur = doc.sources?.[name] || { name, enabled: true, totalStreamsCollected: 0 };
      doc.sources = doc.sources || {};
      doc.sources[name] = {
        ...cur,
        name,
        lastSuccessAt: new Date().toISOString(),
        lastStreamCount: streamCount,
        totalStreamsCollected: (cur.totalStreamsCollected || 0) + streamCount,
        lastError: null,
      };
      return doc;
    });
  }

  recordError(name, error) {
    this.store.update((doc) => {
      const cur = doc.sources?.[name] || { name, enabled: true };
      doc.sources = doc.sources || {};
      doc.sources[name] = {
        ...cur,
        name,
        lastErrorAt: new Date().toISOString(),
        lastError: String(error || 'unknown'),
      };
      return doc;
    });
  }

  /**
   * Apply local enable flags onto sources.json document before scraper run.
   */
  applyToSourcesDoc(sourcesDoc) {
    const list = sourcesDoc?.sources || [];
    return {
      ...sourcesDoc,
      sources: list.map((s) => ({
        ...s,
        enabled: this.isEnabled(s.name) && s.enabled !== false,
      })),
    };
  }
}

module.exports = {
  SourceAdminService,
  SOURCE_NAMES: DEFAULT_SOURCE_NAMES,
};
