const axios = require('axios');
const { logEvent, events } = require('../utils/logger');
const { normalizeStreamUrl, contentHash } = require('../utils/compare');
const {
  mergePlaybackHeaders,
  sourceOnlyPlaybackHeaders,
  playbackHeadersForClient,
  headerPresence,
  headersEqual,
  PLAYBACK_UA_MOBILE,
} = require('../utils/streamHeaders');

const VALIDATION_STATE = {
  VALIDATING: 'VALIDATING',
  AVAILABLE: 'AVAILABLE',
  INVALID: 'INVALID',
  TIMEOUT: 'TIMEOUT',
  HTTP_401: 'HTTP_401',
  HTTP_403: 'HTTP_403',
  HTTP_404: 'HTTP_404',
  NOT_HLS: 'NOT_HLS',
  EMPTY_PLAYLIST: 'EMPTY_PLAYLIST',
  NO_SEGMENTS: 'NO_SEGMENTS',
};

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

const PLAYLIST_MAX_BYTES = 512 * 1024;

function qualityScore(label) {
  const key = String(label || '')
    .toLowerCase()
    .trim();
  if (QUALITY_RANK[key] != null) return QUALITY_RANK[key];
  if (/1080/.test(key)) return 100;
  if (/full\s*hd|fhd/.test(key)) return 90;
  if (/720|hd/.test(key)) return 70;
  if (/sd|480/.test(key)) return 40;
  if (/server\s*\d+/i.test(key)) return 60;
  return 50;
}

function resolvePlaylistUrl(value, baseUrl) {
  try {
    return new URL(String(value || '').trim(), baseUrl).toString();
  } catch {
    return String(value || '').trim();
  }
}

function parseHlsPlaylist(body, baseUrl) {
  const text = String(body || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!text) {
    return { state: VALIDATION_STATE.EMPTY_PLAYLIST, kind: null, variants: [], segments: [] };
  }
  if (!/#EXTM3U/i.test(text)) {
    return { state: VALIDATION_STATE.NOT_HLS, kind: null, variants: [], segments: [] };
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const segments = [];
  let hasMap = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#EXT-X-STREAM-INF/i.test(line)) {
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) {
        variants.push(resolvePlaylistUrl(next, baseUrl));
      }
    }
    if (/^#EXTINF/i.test(line)) {
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) {
        segments.push(resolvePlaylistUrl(next, baseUrl));
      }
    }
    if (/^#EXT-X-MAP:/i.test(line) || /^#EXT-X-PRELOAD-HINT:/i.test(line)) {
      hasMap = true;
    }
  }

  const mentionsMaster = /#EXT-X-STREAM-INF/i.test(text);
  const mentionsMedia = /#EXTINF|#EXT-X-TARGETDURATION|#EXT-X-MEDIA-SEQUENCE/i.test(text);

  if (mentionsMaster) {
    if (!variants.length) {
      return { state: VALIDATION_STATE.EMPTY_PLAYLIST, kind: 'master', variants, segments };
    }
    return { state: null, kind: 'master', variants, segments };
  }

  if (mentionsMedia || hasMap) {
    if (!segments.length && !hasMap) {
      return { state: VALIDATION_STATE.NO_SEGMENTS, kind: 'media', variants, segments };
    }
    return { state: null, kind: 'media', variants, segments };
  }

  return { state: VALIDATION_STATE.EMPTY_PLAYLIST, kind: 'unknown', variants, segments };
}

function stateFromHttp(status) {
  if (status === 401) return VALIDATION_STATE.HTTP_401;
  if (status === 403) return VALIDATION_STATE.HTTP_403;
  if (status === 404) return VALIDATION_STATE.HTTP_404;
  return VALIDATION_STATE.INVALID;
}

function isAuthDenied(status) {
  return status === 401 || status === 403;
}

function isTimeoutError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /timeout/i.test(message)
  );
}

function isNetworkDead(err) {
  const code = String(err?.code || '');
  return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH'].includes(code);
}

class StreamValidator {
  constructor(options = {}) {
    this.timeout = Number(
      options.timeout || process.env.STREAM_VALIDATION_TIMEOUT_MS || 12000
    );
    this.fastTimeout = Number(
      options.fastTimeout || process.env.STREAM_FAST_HEALTH_TIMEOUT_MS || 2000
    );
    this.http = options.http || axios;
    this.sourceConfigs = options.sourceConfigs || {};
    this.resolveMasterVariant = options.resolveMasterVariant !== false;
  }

  resolveSourceConfig(stream, options = {}) {
    if (options.sourceConfig && typeof options.sourceConfig === 'object') {
      return options.sourceConfig;
    }
    const name = String(stream?.source || '');
    if (!name) return {};
    return (
      this.sourceConfigs[name] ||
      this.sourceConfigs[name.toLowerCase()] ||
      {}
    );
  }

  matchPageUrlOf(stream) {
    return (
      stream?.matchPageUrl ||
      stream?.pageUrl ||
      stream?.headers?.Referer ||
      stream?.headers?.referer ||
      ''
    );
  }

  /**
   * Some CDNs (livefeedtextbox) accept Socolive Referer but reject Xoilac's.
   * After 401/403, try other configured playback Referers, then a known CDN map.
   */
  authFallbackHeaders({ sourceConfig, matchPageUrl, retryHeaders, streamUrl } = {}) {
    const out = [];
    const push = (headers) => {
      if (!headers?.Referer) return;
      if (out.some((h) => headersEqual(h, headers))) return;
      out.push(headers);
    };
    push(retryHeaders);
    try {
      const host = new URL(streamUrl).hostname;
      if (/livefeedtextbox\.com$/i.test(host)) {
        push({
          Accept: '*/*',
          'User-Agent': PLAYBACK_UA_MOBILE,
          Referer: 'https://soco.textliveupdaterz.com/',
        });
      }
    } catch {
      // ignore bad stream URL
    }
    for (const cfg of Object.values(this.sourceConfigs || {})) {
      if (!cfg || cfg === sourceConfig) continue;
      if (cfg.type && cfg.type !== 'streaming') continue;
      push(sourceOnlyPlaybackHeaders(cfg, matchPageUrl));
    }
    return out.slice(0, 5);
  }

  async fetchPlaylist(url, headers) {
    try {
      const response = await this.http.get(url, {
        timeout: this.timeout,
        headers,
        responseType: 'text',
        maxRedirects: 5,
        validateStatus: () => true,
        maxContentLength: PLAYLIST_MAX_BYTES,
        maxBodyLength: PLAYLIST_MAX_BYTES,
      });
      return { response, error: null };
    } catch (err) {
      return { response: null, error: err };
    }
  }

  logValidation({
    source,
    url,
    headers,
    httpStatus,
    hls,
    playlist,
    result,
    retried = false,
  }) {
    const referer = headerPresence(headers, 'Referer');
    const userAgent = headerPresence(headers, 'User-Agent');
    const origin = headerPresence(headers, 'Origin');
    const parts = [
      '[STREAM VALIDATION]',
      `Source: ${source || 'unknown'}`,
      `URL: ${url || ''}`,
      `Referer: ${referer}`,
      `User-Agent: ${userAgent}`,
      `HTTP: ${httpStatus == null ? 'error' : httpStatus}`,
      `HLS: ${hls}`,
      `Playlist: ${playlist}`,
    ];
    if (retried) parts.push('Retry with source headers: YES');
    parts.push(`Result: ${result}`);
    logEvent(events.VALIDATION_RESULT, parts.join(' | '), {
      source: source || 'unknown',
      url,
      Referer: referer,
      'User-Agent': userAgent,
      Origin: origin,
      HTTP: httpStatus == null ? 'error' : httpStatus,
      HLS: hls,
      Playlist: playlist,
      ...(retried ? { 'Retry with source headers': 'YES' } : {}),
      Result: result,
    });
  }

  failResult(stream, state, extra = {}) {
    const validation = {
      ok: false,
      state,
      statusCode: extra.statusCode ?? null,
      contentType: extra.contentType ?? null,
      reason: extra.reason || String(state || '').toLowerCase(),
      playlistHash: extra.playlistHash || null,
      playlistType: extra.playlistType || null,
      retriedWithSourceHeaders: Boolean(extra.retried),
    };
    return {
      ...stream,
      active: false,
      validation,
      checkedAt: new Date().toISOString(),
    };
  }

  availableResult(stream, headers, extra = {}) {
    const clientHeaders = playbackHeadersForClient(headers);
    return {
      ...stream,
      active: true,
      headers: clientHeaders,
      streamHeaders: clientHeaders,
      validation: {
        ok: true,
        state: VALIDATION_STATE.AVAILABLE,
        statusCode: extra.statusCode ?? 200,
        contentType: extra.contentType ?? null,
        reason: 'ok',
        playlistHash: extra.playlistHash || null,
        playlistType: extra.playlistType || null,
        retriedWithSourceHeaders: Boolean(extra.retried),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Header-aware HLS validation. HTTP 200 alone is not sufficient.
   * On 401/403, retry once with configured source playback headers.
   */
  async validate(stream, options = {}) {
    if (!stream?.url) {
      const result = this.failResult(stream || {}, VALIDATION_STATE.INVALID, {
        reason: 'empty_url',
      });
      this.logValidation({
        source: stream?.source,
        url: '',
        headers: {},
        httpStatus: null,
        hls: 'invalid',
        playlist: 'unusable',
        result: VALIDATION_STATE.INVALID,
      });
      return result;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(stream.url);
    } catch {
      const result = this.failResult(stream, VALIDATION_STATE.INVALID, {
        reason: 'invalid_url',
      });
      this.logValidation({
        source: stream.source,
        url: stream.url,
        headers: {},
        httpStatus: null,
        hls: 'invalid',
        playlist: 'unusable',
        result: VALIDATION_STATE.INVALID,
      });
      return result;
    }

    if (!/^https?:$/i.test(parsedUrl.protocol)) {
      return this.failResult(stream, VALIDATION_STATE.INVALID, {
        reason: 'invalid_protocol',
      });
    }

    const sourceConfig = this.resolveSourceConfig(stream, options);
    const matchPageUrl = this.matchPageUrlOf(stream);
    const mergedHeaders = mergePlaybackHeaders({
      streamHeaders: stream.streamHeaders || stream.headers,
      sourceConfig,
      matchPageUrl,
    });
    const retryHeaders = sourceOnlyPlaybackHeaders(sourceConfig, matchPageUrl);

    let headers = mergedHeaders;
    let retried = false;
    let fetched = await this.fetchPlaylist(stream.url, headers);

    const tryAuthFallbacks = async () => {
      const tried = [headers];
      const fallbacks = this.authFallbackHeaders({
        sourceConfig,
        matchPageUrl,
        current: headers,
        retryHeaders,
        streamUrl: stream.url,
      });
      for (const next of fallbacks) {
        if (tried.some((h) => headersEqual(h, next))) continue;
        this.logValidation({
          source: stream.source,
          url: stream.url,
          headers,
          httpStatus: fetched.response?.status,
          hls: 'invalid',
          playlist: 'unusable',
          result: 'RETRY',
          retried: true,
        });
        retried = true;
        headers = next;
        tried.push(next);
        fetched = await this.fetchPlaylist(stream.url, headers);
        if (fetched.error) return;
        if (!isAuthDenied(fetched.response?.status)) return;
      }
    };

    if (!fetched.error && isAuthDenied(fetched.response?.status)) {
      await tryAuthFallbacks();
    }

    if (fetched.error) {
      const state = isTimeoutError(fetched.error) || isNetworkDead(fetched.error)
        ? VALIDATION_STATE.TIMEOUT
        : VALIDATION_STATE.INVALID;
      const result = this.failResult(stream, state, {
        reason: state === VALIDATION_STATE.TIMEOUT ? 'timeout' : 'fetch_failed',
        retried,
      });
      this.logValidation({
        source: stream.source,
        url: stream.url,
        headers,
        httpStatus: null,
        hls: 'invalid',
        playlist: 'unusable',
        result: state,
        retried,
      });
      return result;
    }

    const response = fetched.response;
    const status = Number(response.status);
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const body = String(response.data || '');

    if (status < 200 || status >= 400) {
      const state = stateFromHttp(status);
      const result = this.failResult(stream, state, {
        statusCode: status,
        contentType,
        reason: `http_${status}`,
        retried,
      });
      this.logValidation({
        source: stream.source,
        url: stream.url,
        headers,
        httpStatus: status,
        hls: 'invalid',
        playlist: 'unusable',
        result: state,
        retried,
      });
      return result;
    }

    const parsed = parseHlsPlaylist(body, stream.url);
    if (parsed.state) {
      const result = this.failResult(stream, parsed.state, {
        statusCode: status,
        contentType,
        playlistType: parsed.kind,
        retried,
      });
      this.logValidation({
        source: stream.source,
        url: stream.url,
        headers,
        httpStatus: status,
        hls: parsed.state === VALIDATION_STATE.NOT_HLS ? 'invalid' : 'present',
        playlist: 'unusable',
        result: parsed.state,
        retried,
      });
      return result;
    }

    let playlistType = parsed.kind;
    if (parsed.kind === 'master' && this.resolveMasterVariant && parsed.variants[0]) {
      const variant = await this.fetchPlaylist(parsed.variants[0], headers);
      if (!variant.error && variant.response && variant.response.status >= 200 && variant.response.status < 400) {
        const media = parseHlsPlaylist(String(variant.response.data || ''), parsed.variants[0]);
        if (media.state === VALIDATION_STATE.EMPTY_PLAYLIST || media.state === VALIDATION_STATE.NO_SEGMENTS) {
          const result = this.failResult(stream, media.state, {
            statusCode: status,
            contentType,
            playlistType: 'master',
            retried,
          });
          this.logValidation({
            source: stream.source,
            url: stream.url,
            headers,
            httpStatus: status,
            hls: 'valid',
            playlist: 'unusable',
            result: media.state,
            retried,
          });
          return result;
        }
        if (media.kind === 'media') playlistType = 'master';
      }
    }

    const usable =
      (parsed.kind === 'master' && parsed.variants.length > 0) ||
      (parsed.kind === 'media' && (parsed.segments.length > 0 || /#EXT-X-MAP:/i.test(body)));

    if (!usable) {
      const state = parsed.kind === 'media' ? VALIDATION_STATE.NO_SEGMENTS : VALIDATION_STATE.EMPTY_PLAYLIST;
      const result = this.failResult(stream, state, {
        statusCode: status,
        contentType,
        playlistType: parsed.kind,
        retried,
      });
      this.logValidation({
        source: stream.source,
        url: stream.url,
        headers,
        httpStatus: status,
        hls: 'valid',
        playlist: 'unusable',
        result: state,
        retried,
      });
      return result;
    }

    const result = this.availableResult(stream, headers, {
      statusCode: status,
      contentType,
      playlistHash: contentHash(body),
      playlistType,
      retried,
    });
    this.logValidation({
      source: stream.source,
      url: stream.url,
      headers,
      httpStatus: status,
      hls: 'valid',
      playlist: 'usable',
      result: VALIDATION_STATE.AVAILABLE,
      retried,
    });
    return result;
  }

  /**
   * Same as validate(). Fast HTTP-only 2xx checks caused false AVAILABLE.
   */
  async fastHealthCheck(stream, options = {}) {
    return this.validate(stream, options);
  }

  async fastHealthCheckMany(streams, options = {}) {
    return this.validateMany(streams, options);
  }

  async validateMany(streams, options = {}) {
    const results = [];
    for (const stream of streams || []) {
      // Sequential to avoid flooding CDNs
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.validate(stream, options));
    }
    return results;
  }

  /**
   * Dedupe within a source (same URL / playlist hash).
   * Keep one playable stream per source even when CDNs share the same URL.
   */
  dedupeAndRank(streams) {
    const byKey = new Map();

    for (const stream of streams || []) {
      if (!stream?.url) continue;
      const src = String(stream.source || 'unknown').trim().toLowerCase() || 'unknown';
      const norm = normalizeStreamUrl(stream.url);
      const label = String(stream.quality || stream.name || '')
        .toLowerCase()
        .trim();
      const hashKey = stream.validation?.playlistHash
        ? `${src}:hash:${stream.validation.playlistHash}:q:${label}`
        : null;
      const keys = [`${src}:url:${norm}`, `${src}:exact:${String(stream.url).toLowerCase()}`];
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
      const id = `${String(record.stream.source || 'unknown').trim().toLowerCase()}::${normalizeStreamUrl(record.stream.url)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(record.stream);
    }

    unique.sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
    return unique;
  }
}

module.exports = {
  StreamValidator,
  qualityScore,
  QUALITY_RANK,
  VALIDATION_STATE,
  parseHlsPlaylist,
};
