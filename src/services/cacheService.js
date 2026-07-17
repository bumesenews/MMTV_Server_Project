const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { hasDataChanged, hashPayload, sanitizeForCompare } = require('../utils/compare');

class CacheService {
  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    this.dataDir = dataDir;
    this.currentPath = path.join(dataDir, 'current.json');
    this.previousPath = path.join(dataDir, 'previous.json');
    this.deliveryDir = path.join(dataDir, 'delivery');
    this.deliveryFiles = {
      matches: path.join(this.deliveryDir, 'matches.json'),
      soco: path.join(this.deliveryDir, 'soco.json'),
      highlight: path.join(this.deliveryDir, 'highlight.json'),
      myanmartv: path.join(this.deliveryDir, 'myanmartv.json'),
    };
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.deliveryDir)) {
      fs.mkdirSync(this.deliveryDir, { recursive: true });
    }
  }

  readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      logger.warn('Failed reading cache file', { filePath, error: err.message });
      return null;
    }
  }

  writeJson(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  getCurrent() {
    return this.readJson(this.currentPath);
  }

  getPrevious() {
    return this.readJson(this.previousPath);
  }

  getDeliveryBundle() {
    return {
      matches: this.readJson(this.deliveryFiles.matches),
      soco: this.readJson(this.deliveryFiles.soco),
      highlight: this.readJson(this.deliveryFiles.highlight),
      myanmartv: this.readJson(this.deliveryFiles.myanmartv),
    };
  }

  getDelivery(feed) {
    const file = this.deliveryFiles[feed];
    if (!file) return null;
    return this.readJson(file);
  }

  /**
   * Persist delivery feeds under data/delivery/ for local Flutter endpoints + GitHub compare.
   */
  saveDeliveryBundle(bundle) {
    this.ensureDir();
    const previous = this.getDeliveryBundle();
    const changed = {};

    for (const key of ['matches', 'soco', 'highlight', 'myanmartv']) {
      if (bundle[key] == null) {
        changed[key] = false;
        continue;
      }
      const before = previous[key];
      const after = bundle[key];
      const didChange =
        !before ||
        hashPayload(JSON.parse(JSON.stringify(before))) !==
          hashPayload(JSON.parse(JSON.stringify(after)));
      // Always write latest so endpoints stay fresh even if only timestamps differ
      this.writeJson(this.deliveryFiles[key], after);
      changed[key] = didChange || !before;
    }

    logger.info('Delivery cache updated', {
      matches: Array.isArray(bundle.matches?.matches) ? bundle.matches.matches.length : 0,
      socoLeagues: Array.isArray(bundle.soco?.leagues) ? bundle.soco.leagues.length : 0,
      highlights: Array.isArray(bundle.highlight?.highlights)
        ? bundle.highlight.highlights.length
        : 0,
      channels: Array.isArray(bundle.myanmartv) ? bundle.myanmartv.length : 0,
    });

    return { previous, changed };
  }

  /**
   * Persist new payload:
   * - move current -> previous
   * - write new current
   * Returns whether Flutter-facing data changed vs previous current.
   */
  saveGenerated(payload) {
    const existing = this.getCurrent();
    const changed = hasDataChanged(existing, payload);

    if (existing) {
      this.writeJson(this.previousPath, existing);
    }

    const withMeta = {
      ...payload,
      meta: {
        ...(payload.meta || {}),
        checksum: hashPayload(sanitizeForCompare(payload)),
        cachedAt: new Date().toISOString(),
      },
    };

    this.writeJson(this.currentPath, withMeta);
    logger.info('Local cache updated', {
      changed,
      matches: Array.isArray(withMeta.matches) ? withMeta.matches.length : 0,
    });

    return { changed, payload: withMeta, previous: existing };
  }

  /**
   * Keep last valid data when scraper fails — never promote empty JSON.
   */
  keepPreviousOnFailure() {
    const current = this.getCurrent();
    if (current) {
      logger.warn('Keeping previous valid cache after scraper failure');
    }
    return current;
  }

  isEmptyPayload(payload) {
    if (!payload) return true;
    if (!Array.isArray(payload.matches)) return true;
    return payload.matches.length === 0 && payload.meta?.allowEmpty !== true;
  }
}

module.exports = { CacheService };
