const crypto = require('crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Compare Flutter-facing match payloads, ignoring volatile timestamps.
 */
function sanitizeForCompare(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.generatedAt) delete clone.generatedAt;
  if (clone.meta && typeof clone.meta === 'object') {
    delete clone.meta.generatedAt;
    delete clone.meta.checksum;
  }

  if (Array.isArray(clone.matches)) {
    for (const match of clone.matches) {
      if (!match || typeof match !== 'object') continue;
      delete match.updatedAt;
      if (Array.isArray(match.streams)) {
        for (const stream of match.streams) {
          if (stream && typeof stream === 'object') delete stream.checkedAt;
        }
      }
    }
  }

  return clone;
}

function hasDataChanged(previous, next) {
  if (!previous) return true;
  return hashPayload(sanitizeForCompare(previous)) !== hashPayload(sanitizeForCompare(next));
}

function normalizeStreamUrl(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    ['t', 'ts', '_', 'cache', 'v', 'timestamp'].forEach((k) => u.searchParams.delete(k));
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '')
      .trim()
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\/$/, '');
  }
}

function contentHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

module.exports = {
  stableStringify,
  hashPayload,
  sanitizeForCompare,
  hasDataChanged,
  normalizeStreamUrl,
  contentHash,
};
