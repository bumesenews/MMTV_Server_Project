const path = require('path');
const { JsonStore } = require('../store/jsonStore');

const SOURCE_NAMES = ['luongson', 'socolive', 'xoilac', 'soco', 'highlight', 'myanmartv'];

class SourceAdminService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    const sources = {};
    for (const name of SOURCE_NAMES) {
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

  list() {
    const doc = this.store.read();
    return SOURCE_NAMES.map((name) => {
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
    if (!SOURCE_NAMES.includes(name)) throw new Error('Unknown source');
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
    if (!SOURCE_NAMES.includes(name)) return;
    this.store.update((doc) => {
      const cur = doc.sources?.[name] || { name, enabled: true, totalStreamsCollected: 0 };
      doc.sources = doc.sources || {};
      doc.sources[name] = {
        ...cur,
        lastSuccessAt: new Date().toISOString(),
        lastStreamCount: streamCount,
        totalStreamsCollected: (cur.totalStreamsCollected || 0) + streamCount,
        lastError: null,
      };
      return doc;
    });
  }

  recordError(name, error) {
    if (!SOURCE_NAMES.includes(name)) return;
    this.store.update((doc) => {
      const cur = doc.sources?.[name] || { name, enabled: true };
      doc.sources = doc.sources || {};
      doc.sources[name] = {
        ...cur,
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
      sources: list.map((s) => {
        if (!SOURCE_NAMES.includes(s.name)) return s;
        return { ...s, enabled: this.isEnabled(s.name) && s.enabled !== false };
      }),
    };
  }
}

module.exports = { SourceAdminService, SOURCE_NAMES };
