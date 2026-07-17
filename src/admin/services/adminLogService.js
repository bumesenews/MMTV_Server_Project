const path = require('path');
const { JsonStore } = require('../store/jsonStore');

const MAX_ENTRIES = 2000;

class AdminLogService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    this.store = new JsonStore(path.join(dataDir, 'admin-logs.json'), { entries: [] });
  }

  list({ limit = 200, category = null } = {}) {
    let entries = this.store.read().entries || [];
    if (category) {
      entries = entries.filter((e) => e.category === category);
    }
    return entries.slice(0, Math.min(limit, MAX_ENTRIES));
  }

  add({ category, action, message, actor = 'system', meta = {} }) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      category,
      action,
      message,
      actor,
      meta,
    };
    this.store.update((doc) => {
      const entries = [entry, ...(doc.entries || [])].slice(0, MAX_ENTRIES);
      return { entries };
    });
    return entry;
  }
}

module.exports = { AdminLogService };
