const crypto = require('crypto');
const { hashPayload, sanitizeForCompare } = require('./compare');
const { logger } = require('./logger');

/**
 * Authenticated stream-URL wrapping for public matches.json only.
 *
 * Format: ENC:v1:<base64(iv || ciphertext || gcmTag)>
 * - AES-256-GCM
 * - 12-byte IV = HMAC-SHA256(key, plaintext)[0:12] (deterministic → GitHub skip-if-unchanged)
 * - 16-byte GCM tag
 *
 * Key (STREAM_URL_ENCRYPTION_KEY): 64-char hex, or standard base64 of 32 bytes,
 * or any UTF-8 secret hashed with SHA-256. Never log the key or plaintext URL.
 */
const PREFIX = 'ENC:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let _missingKeyWarned = false;

function parseStreamUrlKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const asB64 = Buffer.from(s, 'base64');
  if (asB64.length === KEY_LEN) return asB64;
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

function loadStreamUrlKey(env = process.env) {
  return parseStreamUrlKey(env.STREAM_URL_ENCRYPTION_KEY);
}

function isEncryptedStreamUrl(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function deterministicIv(key, plaintext) {
  return crypto.createHmac('sha256', key).update(plaintext, 'utf8').digest().subarray(0, IV_LEN);
}

function encryptStreamUrl(url, key) {
  if (url == null) return url;
  if (typeof url !== 'string') return url;
  const plain = url.trim();
  if (!plain) return url;
  if (!key) return url;
  if (plain.startsWith(PREFIX)) return url;
  try {
    const iv = deterministicIv(key, plain);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, ciphertext, tag]).toString('base64');
  } catch {
    return url;
  }
}

function decryptStreamUrl(url, key) {
  if (url == null) return url;
  if (typeof url !== 'string') return url;
  const raw = url.trim();
  if (!raw) return url;
  if (!raw.startsWith(PREFIX)) return url;
  if (!key) return '';
  try {
    const buf = Buffer.from(raw.slice(PREFIX.length), 'base64');
    if (buf.length <= IV_LEN + TAG_LEN) return '';
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function encryptMatchStreamFields(match, key) {
  if (!match || !key) return match;
  const next = { ...match };
  if (next.streamUrl !== undefined) {
    next.streamUrl = encryptStreamUrl(next.streamUrl, key);
  }
  if (Array.isArray(next.streams)) {
    next.streams = next.streams.map((s) => {
      if (!s || typeof s !== 'object') return s;
      if (s.url === undefined) return s;
      return { ...s, url: encryptStreamUrl(s.url, key) };
    });
  }
  return next;
}

function decryptMatchStreamFields(match, key) {
  if (!match) return match;
  const next = { ...match };
  if (next.streamUrl !== undefined) {
    next.streamUrl = decryptStreamUrl(next.streamUrl, key);
  }
  if (Array.isArray(next.streams)) {
    next.streams = next.streams.map((s) => {
      if (!s || typeof s !== 'object') return s;
      if (s.url === undefined) return s;
      return { ...s, url: decryptStreamUrl(s.url, key) };
    });
  }
  return next;
}

function encryptPublicMatchesPayload(payload, key = loadStreamUrlKey()) {
  if (!payload || !Array.isArray(payload.matches)) return payload;
  if (!key) {
    const hasUrl = payload.matches.some(
      (m) =>
        String(m?.streamUrl || '').trim() ||
        (m?.streams || []).some((s) => String(s?.url || '').trim())
    );
    if (hasUrl && !_missingKeyWarned) {
      _missingKeyWarned = true;
      logger.warn(
        'STREAM_URL_ENCRYPTION_KEY is not set — public matches.json stream URLs stay plaintext'
      );
    }
    return payload;
  }
  const matches = payload.matches.map((m) => encryptMatchStreamFields(m, key));
  const next = { ...payload, matches };
  if (next.meta && typeof next.meta === 'object') {
    next.meta = { ...next.meta };
    next.meta.checksum = hashPayload(sanitizeForCompare(next));
  }
  return next;
}

function decryptMatchesList(matches, key = loadStreamUrlKey()) {
  if (!Array.isArray(matches)) return matches;
  if (!key) return matches;
  return matches.map((m) => decryptMatchStreamFields(m, key));
}

module.exports = {
  PREFIX,
  parseStreamUrlKey,
  loadStreamUrlKey,
  isEncryptedStreamUrl,
  encryptStreamUrl,
  decryptStreamUrl,
  encryptMatchStreamFields,
  decryptMatchStreamFields,
  encryptPublicMatchesPayload,
  decryptMatchesList,
};
