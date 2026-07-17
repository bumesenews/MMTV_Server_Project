const axios = require('axios');
const { logger, logEvent, events } = require('../utils/logger');
const { normalizeStreamUrl, contentHash } = require('../utils/compare');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

const QUALITY_RANK = {
  '1080p': 100,
  '1080': 100,
  'full hd': 90,
  fullhd: 90,
  fhd: 90,
  hd: 70,
  '720p': 70,
  '720': 70,
  sd: 40,
  '480p': 40,
  '360p': 20,
};

function qualityScore(label) {
  const key = String(label || '')
    .toLowerCase()
    .trim();
  if (QUALITY_RANK[key] != null) return QUALITY_RANK[key];
  if (/1080/.test(key)) return 100;
  if (/full\s*hd|fhd/.test(key)) return 90;
  if (/720|hd/.test(key)) return 70;
  if (/sd|480/.test(key)) return 40;
  // Server N — neutral mid score
  if (/server\s*\d+/i.test(key)) return 60;
  return 50;
}

class StreamValidator {
  constructor(options = {}) {
    this.timeout = Number(
      options.timeout || process.env.STREAM_VALIDATION_TIMEOUT_MS || 12000
    );
  }

  async validate(stream) {
    const result = {
      ...stream,
      active: false,
      validation: {
        ok: false,
        statusCode: null,
        contentType: null,
        reason: null,
        playlistHash: null,
      },
      checkedAt: new Date().toISOString(),
    };

    if (!stream?.url) {
      result.validation.reason = 'empty_url';
      logEvent(events.VALIDATION_RESULT, 'Stream invalid', {
        reason: 'empty_url',
      });
      return result;
    }

    let parsed;
    try {
      parsed = new URL(stream.url);
    } catch {
      result.validation.reason = 'invalid_url';
      logEvent(events.VALIDATION_RESULT, 'Stream invalid', {
        reason: 'invalid_url',
        url: stream.url,
      });
      return result;
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      result.validation.reason = 'invalid_protocol';
      return result;
    }

    try {
      const headers = {
        'User-Agent': stream.headers?.['User-Agent'] || process.env.USER_AGENT || DEFAULT_UA,
        Referer: stream.headers?.Referer || '',
        ...(stream.headers?.Cookie ? { Cookie: stream.headers.Cookie } : {}),
        Accept: '*/*',
      };

      const response = await axios.get(stream.url, {
        timeout: this.timeout,
        headers,
        responseType: 'text',
        maxRedirects: 5,
        validateStatus: () => true,
      });

      result.validation.statusCode = response.status;
      result.validation.contentType = String(
        response.headers['content-type'] || ''
      ).toLowerCase();

      if (response.status < 200 || response.status >= 400) {
        result.validation.reason = `http_${response.status}`;
        logEvent(events.VALIDATION_RESULT, 'Stream HTTP failed', {
          status: response.status,
          url: stream.url,
        });
        return result;
      }

      const body = String(response.data || '');
      const looksLikeM3u8 =
        body.includes('#EXTM3U') ||
        /\.m3u8/i.test(stream.url) ||
        result.validation.contentType.includes('mpegurl') ||
        result.validation.contentType.includes('m3u8');

      if (!looksLikeM3u8) {
        result.validation.reason = 'not_m3u8';
        logEvent(events.VALIDATION_RESULT, 'Stream not m3u8', {
          url: stream.url,
        });
        return result;
      }

      const hasSegments =
        /#EXTINF/i.test(body) ||
        /#EXT-X-STREAM-INF/i.test(body) ||
        /\.ts\b/i.test(body) ||
        /\.m3u8/i.test(body);

      if (!hasSegments && body.length < 20) {
        result.validation.reason = 'empty_playlist';
        return result;
      }

      result.active = true;
      result.validation.ok = true;
      result.validation.reason = 'ok';
      result.validation.playlistHash = contentHash(body);

      logEvent(events.VALIDATION_RESULT, 'Stream valid', {
        source: stream.source,
        quality: stream.quality,
        url: stream.url,
      });
      return result;
    } catch (err) {
      result.validation.reason = err.code || err.message;
      logger.debug('Stream validation error', {
        url: stream.url,
        error: err.message,
      });
      logEvent(events.VALIDATION_RESULT, 'Stream validation error', {
        url: stream.url,
        error: err.message,
      });
      return result;
    }
  }

  async validateMany(streams) {
    const results = [];
    for (const stream of streams || []) {
      // Sequential to avoid flooding CDNs
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.validate(stream));
    }
    return results;
  }

  /**
   * Remove duplicates by exact URL, normalized URL, and playlist hash.
   * Keep highest quality.
   */
  dedupeAndRank(streams) {
    const byKey = new Map();

    for (const stream of streams || []) {
      if (!stream?.url) continue;
      const norm = normalizeStreamUrl(stream.url);
      const hashKey = stream.validation?.playlistHash
        ? `hash:${stream.validation.playlistHash}`
        : null;
      const keys = [`url:${norm}`, `exact:${String(stream.url).toLowerCase()}`];
      if (hashKey) keys.push(hashKey);

      let existingKey = null;
      for (const key of keys) {
        if (byKey.has(key)) {
          existingKey = key;
          break;
        }
      }

      const score =
        qualityScore(stream.quality) + (stream.active || stream.validation?.ok ? 5 : 0);

      if (!existingKey) {
        const record = { stream, score, keys };
        for (const key of keys) byKey.set(key, record);
        continue;
      }

      const current = byKey.get(existingKey);
      if (score > current.score) {
        for (const key of current.keys) byKey.delete(key);
        const record = { stream, score, keys };
        for (const key of keys) byKey.set(key, record);
      }
    }

    const unique = [];
    const seen = new Set();
    for (const record of byKey.values()) {
      const id = normalizeStreamUrl(record.stream.url);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(record.stream);
    }

    unique.sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
    return unique;
  }
}

module.exports = { StreamValidator, qualityScore, QUALITY_RANK };
