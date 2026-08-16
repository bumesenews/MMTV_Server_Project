const axios = require('axios');
const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA, runExclusivePuppeteerTask, gotoMatchPage } = require('../browser/puppeteerManager');
const { mergePlaybackHeaders, playbackHeadersForClient } = require('../utils/streamHeaders');
const { extractStreamsFromPage, dedupeStreams, IFRAME_SRC_ATTRS } = require('./streamExtractor');
const { sleep, DEFAULT_M3U8_PATTERNS, resolvePlayerWait } = require('./baseStreamingSource');
const { cleanText } = require('../utils/normalize');
const { isBrowserProtocolError } = require('../utils/streamExtractPolicy');

const AXIOS_TIMEOUT_MS = Number(process.env.HTTP_STREAM_TIMEOUT_MS || 20000);
const MAX_EMBEDS = Number(process.env.HTTP_STREAM_MAX_EMBEDS || 6);

/**
 * Shared axios HTML client for stream discovery.
 */
async function axiosGetHtml(url, { referer, timeout = AXIOS_TIMEOUT_MS } = {}) {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return referer || '';
    }
  })();
  const res = await axios.get(url, {
    timeout,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8,my;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
      'Sec-Fetch-User': '?1',
      ...(referer ? { Referer: referer } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
  });
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

function parseListStreamGroups(html) {
  const match = String(html || '').match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];
  try {
    // Prefer JSON; fall back to Function for lightly-escaped JS literals
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      const parsed = Function(`"use strict"; return (${match[1]});`)();
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    return [];
  }
}

function findStreamPatterns(text, baseUrl) {
  const found = new Set();
  const regexes = [
    /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi,
    /https?:\/\/[^\s"'<>]+?\/hls\/[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+?\.flv(?:\?[^\s"'<>]*)?/gi,
    /https?:\/\/[^\s"'<>]+?(?:livecdn|hlscdn|liveplay)[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
    /streamingurl\s*[:=]\s*["']([^"']+)["']/gi,
    /urlStream\s*=\s*["']([^"']+)["']/gi,
    /playurl\s*[:=]\s*["']([^"']+)["']/gi,
    /getM3u8\s*[:=]\s*["']([^"']+)["']/gi,
    /["']file["']\s*:\s*["']([^"']+\.(?:m3u8|flv)[^"']*)["']/gi,
    /["'](?:source|src|file_url|hls)["']\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/gi,
  ];
  for (const regex of regexes) {
    for (const patternMatch of String(text || '').matchAll(regex)) {
      const value = patternMatch[1] || patternMatch[0];
      if (!value || /localhost|tvc-wc-2026/i.test(value)) continue;
      try {
        found.add(new URL(value, baseUrl).href);
      } catch {
        if (value.startsWith('http')) found.add(value);
      }
    }
  }
  return [...found];
}

function flvToM3u8(url) {
  if (!/\.flv(?:\?|$)/i.test(url)) return null;
  return url.replace(/\.flv(\?.*)?$/i, '.m3u8$1');
}

function isAdStream(url) {
  return /vd\.apisportpulse\.com|tvc-wc-2026/i.test(url || '');
}

function normalizeStreamUrl(url) {
  if (!url || isAdStream(url)) return '';
  if (/\.m3u8(?:\?|$)/i.test(url)) return url;
  return flvToM3u8(url) || '';
}

function pickStreamUrl(urls) {
  const cleaned = [...new Set((urls || []).map(normalizeStreamUrl).filter(Boolean))];
  if (!cleaned.length) return '';
  return cleaned.sort((a, b) => {
    const score = (url) => {
      let s = /\.m3u8(?:\?|$)/i.test(url) ? 10 : 0;
      if (/master|index\.m3u8|manifest/i.test(url)) s += 5;
      if (/livefeedtextbox/i.test(url)) s += 8;
      if (/buzzscorelinez|apisportpulse/i.test(url)) s -= 4;
      if (/1080|720/i.test(url)) s += 2;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function parseStreamButtons(html, config = {}) {
  const $ = load(html);
  const buttons = [];
  const seen = new Set();
  const selectors = config.selectors || {};
  const attrs = config.attrs || {};
  const buttonSelector =
    asList(selectors.streamButtons || selectors.qualityButton).join(', ') ||
    '#tv_links a.player-link, a.player-link[data-link], [data-link]';
  const indexAttr = attrs.streamIndex || 'data-link';

  $(buttonSelector).each((_, el) => {
    const anchor = $(el);
    const rawIndex = anchor.attr(indexAttr);
    if (rawIndex == null || rawIndex === '') return;
    const index = Number(rawIndex);
    if (!Number.isFinite(index)) return;
    const name = cleanText(anchor.text()) || `Link ${index + 1}`;
    const key = `${index}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    buttons.push({ index, name });
  });
  return buttons;
}

function extractIframeSrcs(html, baseUrl) {
  const $ = load(html);
  const out = [];
  $('iframe, embed, object').each((_, el) => {
    const node = $(el);
    for (const attr of IFRAME_SRC_ATTRS) {
      const src = node.attr(attr) || '';
      if (!src || src.includes('${') || /about:blank|chatboxn\.com|javascript:/i.test(src)) {
        continue;
      }
      try {
        out.push(new URL(src, baseUrl).href);
      } catch {
        // ignore
      }
    }
  });
  return [...new Set(out)];
}

async function extractUrlFromEmbed(embedUrl, referer) {
  const html = await axiosGetHtml(embedUrl, { referer });
  const candidates = findStreamPatterns(html, embedUrl);
  const urlStream = html.match(/urlStream\s*=\s*["']([^"']+)["']/)?.[1];
  if (urlStream) candidates.push(urlStream);
  const streamingUrl = html.match(/streamingurl\s*[:=]\s*["']([^"']+)["']/i)?.[1];
  if (streamingUrl) candidates.push(streamingUrl);
  return pickStreamUrl(candidates);
}

/**
 * Axios-only stream discovery for Vietnamese-style match pages:
 * match HTML → list_stream / iframes / patterns → embed pages → m3u8 (incl. flv→m3u8).
 */
async function extractStreamsViaAxios({
  matchPageUrl,
  sourceName,
  config = {},
}) {
  const html = await axiosGetHtml(matchPageUrl, { referer: matchPageUrl });
  const streamGroups = parseListStreamGroups(html);
  const buttons = parseStreamButtons(html, config);
  const streams = [];
  const sourcePriority = Number(config.priority || 0);

  const push = (url, quality = 'HD', via = 'axios') => {
    const normalized = normalizeStreamUrl(url);
    if (!normalized) return;
    streams.push({
      source: sourceName,
      type: 'm3u8',
      quality: cleanText(quality) || 'HD',
      url: normalized,
      headers: playbackHeadersForClient(
        mergePlaybackHeaders({
          streamHeaders: { Referer: matchPageUrl },
          sourceConfig: config,
          matchPageUrl,
        })
      ),
      matchPageUrl,
      active: true,
      priority: sourcePriority,
      checkedAt: new Date().toISOString(),
      via,
    });
  };

  if (buttons.length && streamGroups.length) {
    for (const button of buttons.slice(0, MAX_EMBEDS)) {
      const embedUrl = Array.isArray(streamGroups[button.index])
        ? streamGroups[button.index][0]
        : '';
      if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) continue;
      try {
        const url = await extractUrlFromEmbed(embedUrl, matchPageUrl);
        if (url) push(url, button.name || 'HD', 'axios-list_stream');
      } catch (err) {
        logger.debug('axios embed failed', {
          source: sourceName,
          embedUrl,
          error: err.message,
        });
      }
    }
  }

  if (!streams.length && streamGroups.length) {
    const embeds = [
      ...new Set(
        streamGroups.flat().filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
      ),
    ].slice(0, MAX_EMBEDS);
    for (const [index, embedUrl] of embeds.entries()) {
      try {
        const url = await extractUrlFromEmbed(embedUrl, matchPageUrl);
        if (url) push(url, `Link ${index + 1}`, 'axios-list_stream');
      } catch (err) {
        logger.debug('axios embed failed', {
          source: sourceName,
          embedUrl,
          error: err.message,
        });
      }
    }
  }

  if (!streams.length) {
    for (const embedUrl of extractIframeSrcs(html, matchPageUrl).slice(0, MAX_EMBEDS)) {
      try {
        const url = await extractUrlFromEmbed(embedUrl, matchPageUrl);
        if (url) push(url, 'HD', 'axios-iframe');
      } catch {
        // ignore
      }
    }
  }

  if (!streams.length) {
    const direct = pickStreamUrl(findStreamPatterns(html, matchPageUrl));
    if (direct) push(direct, 'HD', 'axios-direct');
  }

  return dedupeStreams(streams);
}

function tagExtractionMethod(streams, method) {
  return (streams || []).map((s) => ({
    ...s,
    extractionMethod: method,
  }));
}

/**
 * Axios first, Puppeteer only if Axios produced no *validated* stream.
 * Do not launch Puppeteer when Axios already succeeded.
 */
async function runAxiosThenPuppeteer({
  axiosExtract,
  puppeteerExtract,
  validate,
  shouldAbort,
} = {}) {
  const applyValidate = async (streams) => {
    if (!streams?.length) return [];
    if (typeof validate !== 'function') {
      return (streams || []).filter((s) => s && s.url && s.active !== false);
    }
    const valid = await validate(streams);
    return (valid || []).filter(
      (s) => s && s.url && s.active !== false && (s.validation == null || s.validation.ok !== false)
    );
  };

  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return {
      streams: [],
      method: null,
      puppeteerLaunched: false,
      aborted: true,
    };
  }

  try {
    const raw = await axiosExtract();
    const axiosStreams = await applyValidate(raw);
    if (axiosStreams.length) {
      return {
        streams: tagExtractionMethod(axiosStreams, 'axios'),
        method: 'axios',
        puppeteerLaunched: false,
        aborted: false,
      };
    }
  } catch (err) {
    return puppeteerFallback({
      puppeteerExtract,
      applyValidate,
      shouldAbort,
      axiosError: err,
    });
  }

  return puppeteerFallback({
    puppeteerExtract,
    applyValidate,
    shouldAbort,
    axiosError: null,
  });
}

async function puppeteerFallback({
  puppeteerExtract,
  applyValidate,
  shouldAbort,
  axiosError,
}) {
  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return {
      streams: [],
      method: 'axios',
      puppeteerLaunched: false,
      aborted: true,
      axiosError,
    };
  }
  if (typeof puppeteerExtract !== 'function') {
    return {
      streams: [],
      method: 'axios',
      puppeteerLaunched: false,
      aborted: false,
      axiosError,
    };
  }
  const raw = await puppeteerExtract();
  const streams = await applyValidate(raw);
  return {
    streams: tagExtractionMethod(streams, 'puppeteer'),
    method: 'puppeteer',
    puppeteerLaunched: true,
    aborted: false,
    axiosError,
  };
}

/**
 * Prefer axios HTML scrape; fall back to puppeteer-core network interception.
 * If axios returns candidates that fail validateStreams, Puppeteer is used next.
 * Never launches Puppeteer when Axios already returned a validated stream.
 */
async function extractStreamsAxiosThenPuppeteer({
  matchPageUrl,
  sourceName,
  config,
  browser,
  waitUntil,
  puppeteerSettleMs = 0,
  getM3u8Patterns,
  validateStreams,
  shouldAbort,
}) {
  logEvent(events.SCRAPER_START, `${sourceName} stream extract start`, {
    source: sourceName,
    url: matchPageUrl,
  });

  const playerWait = resolvePlayerWait(config, browser?.timeout);
  const navWaitUntil = waitUntil || playerWait.waitUntil;

  const result = await runAxiosThenPuppeteer({
    shouldAbort,
    validate: validateStreams,
    axiosExtract: async () => {
      const axiosStreams = await extractStreamsViaAxios({
        matchPageUrl,
        sourceName,
        config,
      });
      if (!axiosStreams.length) {
        logger.info(`${sourceName} axios found no streams — falling back to puppeteer`, {
          source: sourceName,
          url: matchPageUrl,
        });
      }
      return axiosStreams;
    },
    puppeteerExtract: browser
      ? async () =>
          runExclusivePuppeteerTask(async () => {
          logger.info(`${sourceName} axios found no valid streams — falling back to puppeteer`, {
            source: sourceName,
            url: matchPageUrl,
          });
          const extraPatterns =
            typeof getM3u8Patterns === 'function'
              ? getM3u8Patterns()
              : (config.streamDetection?.m3u8Patterns || []).map((p) => new RegExp(p, 'i'));
          const patterns = [
            ...DEFAULT_M3U8_PATTERNS.map((p) => new RegExp(p, 'i')),
            ...extraPatterns,
          ];
          const extractConfig = {
            ...config,
            streamDetection: {
              ...(config.streamDetection || {}),
              waitAfterLoadMs: playerWait.waitAfterLoadMs,
              waitAfterClickMs: playerWait.waitAfterClickMs,
              iframeRetries: playerWait.iframeRetries,
              iframeRetryDelayMs: playerWait.iframeRetryDelayMs,
            },
          };
          let page = null;
          try {
            page = await browser.newInterceptPage(patterns);
            if (page.isClosed()) return [];
            await page.setDefaultNavigationTimeout(playerWait.navigationTimeoutMs);
            await gotoMatchPage(page, matchPageUrl, {
              waitUntil: navWaitUntil,
              timeout: playerWait.navigationTimeoutMs,
              playerWaitUntil: playerWait.playerWaitUntil,
              playerWaitTimeoutMs: playerWait.playerWaitTimeoutMs,
            });
            if (puppeteerSettleMs > 0) await sleep(puppeteerSettleMs);
            return extractStreamsFromPage({
              page,
              sourceName,
              config: extractConfig,
              matchPageUrl,
              browserManager: browser,
            });
          } catch (err) {
            const captured = streamsFromCapture(page, sourceName, config, matchPageUrl);
            if (isBrowserProtocolError(err)) {
              logger.warn(`${sourceName} puppeteer frame detached — using captured streams`, {
                source: sourceName,
                error: err.message,
              });
              if (captured.length) return captured;
              const retryErr = new Error('BROWSER_ERROR');
              retryErr.cause = err;
              throw retryErr;
            }
            if (captured.length) return captured;
            throw err;
          } finally {
            await browser.safeClosePage(page);
          }
          })
      : null,
  });

  if (result.aborted) {
    logger.info(`${sourceName} stream extract aborted (stop window)`, {
      source: sourceName,
      url: matchPageUrl,
    });
    return [];
  }

  if (result.method === 'axios' && result.streams.length) {
    logEvent(events.SCRAPER_SUCCESS, `${sourceName} stream extract success (axios)`, {
      source: sourceName,
      count: result.streams.length,
      method: 'axios',
      puppeteerLaunched: false,
    });
    return result.streams;
  }

  if (!browser && !result.puppeteerLaunched) {
    logEvent(events.SCRAPER_SUCCESS, `${sourceName} stream extract success`, {
      source: sourceName,
      count: 0,
      method: 'axios-empty-no-browser',
    });
    return result.streams || [];
  }

  if (result.puppeteerLaunched) {
    logEvent(events.SCRAPER_SUCCESS, `${sourceName} stream extract success (puppeteer)`, {
      source: sourceName,
      count: result.streams.length,
      method: 'puppeteer',
    });
  }

  return result.streams || [];
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function streamsFromCapture(page, sourceName, config, matchPageUrl) {
  const captured = page?.__streamCapture?.getUniqueStreams?.() || [];
  return captured
    .filter((item) => item?.url && (/\.m3u8/i.test(item.url) || /\/hls\//i.test(item.url)))
    .map((item) => ({
      source: sourceName,
      type: 'm3u8',
      quality: 'HD',
      url: item.url,
      headers: playbackHeadersForClient(
        mergePlaybackHeaders({
          streamHeaders: {
            Referer: matchPageUrl,
            ...(item.headers || {}),
          },
          sourceConfig: config,
          matchPageUrl,
        })
      ),
      matchPageUrl,
      active: true,
      via: 'puppeteer-capture',
    }));
}

module.exports = {
  axiosGetHtml,
  parseListStreamGroups,
  findStreamPatterns,
  flvToM3u8,
  normalizeStreamUrl,
  pickStreamUrl,
  extractUrlFromEmbed,
  extractStreamsViaAxios,
  extractStreamsAxiosThenPuppeteer,
  runAxiosThenPuppeteer,
  extractIframeSrcs,
};
