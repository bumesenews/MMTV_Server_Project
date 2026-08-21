const http = require('http');
const https = require('https');
const axios = require('axios');
const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA, runExclusivePuppeteerTask, gotoMatchPage } = require('../browser/puppeteerManager');
const { mergePlaybackHeaders, playbackHeadersForClient } = require('../utils/streamHeaders');
const { extractStreamsFromPage, dedupeStreams, IFRAME_SRC_ATTRS } = require('./streamExtractor');
const { sleep, DEFAULT_M3U8_PATTERNS, resolvePlayerWait } = require('./baseStreamingSource');
const { cleanText } = require('../utils/normalize');
const { isBrowserProtocolError } = require('../utils/streamExtractPolicy');
const { maxPlayerStreams } = require('../utils/scraperConfig');

const AXIOS_TIMEOUT_MS = Number(process.env.HTTP_STREAM_TIMEOUT_MS || 25000);
const HTML_FETCH_RETRIES = Math.max(1, Number(process.env.HTTP_HTML_RETRIES || 5));

// Dead keep-alive + broken IPv6 on EC2 → "socket hang up". Prefer IPv4, no reuse.
function createScraperAgents() {
  const opts = {
    keepAlive: false,
    maxSockets: 8,
    timeout: AXIOS_TIMEOUT_MS,
    family: 4,
  };
  return {
    httpAgent: new http.Agent(opts),
    httpsAgent: new https.Agent(opts),
  };
}

const { httpAgent: scraperHttpAgent, httpsAgent: scraperHttpsAgent } = createScraperAgents();

function isTransientHttpError(err) {
  const code = String(err?.code || err?.cause?.code || err?.cause?.cause?.code || '');
  const msg = String(err?.message || err?.cause?.message || err || '');
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|socket hang up|soket hang up|socket closed|network socket disconnected|aborted|timeout|502|503|504/i.test(
    `${code} ${msg}`
  );
}

/**
 * Shared axios HTML client for stream discovery.
 */
async function axiosGetHtml(url, { referer, timeout = AXIOS_TIMEOUT_MS, retries = HTML_FETCH_RETRIES } = {}) {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return referer || '';
    }
  })();
  const maxTries = Math.max(1, Number(retries) || 1);
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    try {
      const res = await axios.get(url, {
        timeout,
        maxRedirects: 5,
        family: 4,
        responseType: 'text',
        validateStatus: (s) => s >= 200 && s < 400,
        httpAgent: scraperHttpAgent,
        httpsAgent: scraperHttpsAgent,
        headers: {
          'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8,my;q=0.7',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Connection: 'close',
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
    } catch (err) {
      lastErr = err;
      if (!isTransientHttpError(err) || attempt >= maxTries) throw err;
      logger.warn('HTML fetch retry after transient error', {
        url,
        attempt,
        error: err.message,
        code: err.code || err.cause?.code,
      });
      await sleep(700 * attempt);
    }
  }
  throw lastErr;
}

function parseListStreamGroups(html) {
  const text = String(html || '');
  const marker = text.match(/var\s+list_stream\s*=\s*/);
  if (!marker) return [];
  const start = text.indexOf('[', marker.index + marker[0].length - 1);
  if (start < 0) return [];
  const literal = extractJsArrayLiteral(text, start);
  if (!literal) return [];
  try {
    try {
      const parsed = JSON.parse(literal);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      const parsed = Function(`"use strict"; return (${literal});`)();
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    return [];
  }
}

function extractJsArrayLiteral(text, startIdx) {
  if (text[startIdx] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
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

const PLAYER_TAB_SELECTORS =
  '#tv_links a.player-link, #tv_links a, a.player-link[data-link], a.player-link, a[href*="/link/"]';

function parseStreamButtons(html, config = {}) {
  const $ = load(html);
  const buttons = [];
  const seen = new Set();
  const attrs = config.attrs || {};
  const buttonSelector =
    asList(config.selectors?.streamButtons).join(', ') || PLAYER_TAB_SELECTORS;
  const indexAttr = attrs.streamIndex || 'data-link';

  $(buttonSelector).each((_, el) => {
    const anchor = $(el);
    const rawIndex = anchor.attr(indexAttr);
    const href = String(anchor.attr('href') || '');
    const linkNum = href.match(/\/link\/(\d+)/i);
    let index = rawIndex != null && rawIndex !== '' ? Number(rawIndex) : NaN;
    if (!Number.isFinite(index) && linkNum) index = Number(linkNum[1]) - 1;
    if (!Number.isFinite(index)) return;
    const name = cleanText(anchor.text()) || `Link ${index + 1}`;
    const key = `${index}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    buttons.push({ index, name, href: href || null });
  });
  return buttons;
}

function parsePlayerTabs(html, matchPageUrl, config = {}) {
  const $ = load(html);
  const tabs = [];
  const seen = new Set();
  const add = (rawUrl, name) => {
    if (!rawUrl) return;
    const raw = String(rawUrl).trim();
    if (!raw || /^\d+$/.test(raw)) return;
    let href;
    try {
      href = new URL(rawUrl, matchPageUrl).href.split('#')[0];
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(href)) return;
    const key = href.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tabs.push({ url: href, name: cleanText(name) || 'HD' });
  };

  const extra = [PLAYER_TAB_SELECTORS, ...asList(config.selectors?.streamButtons)]
    .filter(Boolean)
    .join(', ');
  $(extra).each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr('href') || anchor.attr('data-href') || anchor.attr('data-url');
    add(href, anchor.text());
  });
  if (!tabs.length) add(matchPageUrl, 'HD');
  return tabs;
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

function isJsShellHtml(html) {
  const text = String(html || '');
  if (/list_stream|urlStream|\.m3u8/i.test(text)) return false;
  return /<div id="root"><\/div>/i.test(text) || /type="module" crossorigin src="\/assets\//i.test(text);
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
  const maxEmbeds = maxPlayerStreams();
  const firstHtml = await axiosGetHtml(matchPageUrl, { referer: matchPageUrl });
  if (isJsShellHtml(firstHtml)) {
    logger.info(`${sourceName} match page is a JS shell — skip axios extract`, {
      source: sourceName,
      url: matchPageUrl,
    });
    return [];
  }
  const tabs = parsePlayerTabs(firstHtml, matchPageUrl, config);
  const firstTabName =
    tabs.find(
      (t) => String(t.url).replace(/\/$/, '').toLowerCase() === String(matchPageUrl).replace(/\/$/, '').toLowerCase()
    )?.name ||
    tabs[0]?.name ||
    'HD';
  const streams = [];
  const sourcePriority = Number(config.priority || 0);
  const htmlByUrl = new Map([[matchPageUrl, firstHtml]]);

  const push = (url, quality = 'HD', via = 'axios', pageUrl = matchPageUrl) => {
    const normalized = normalizeStreamUrl(url);
    if (!normalized) return;
    streams.push({
      source: sourceName,
      type: 'm3u8',
      quality: cleanText(quality) || 'HD',
      url: normalized,
      headers: playbackHeadersForClient(
        mergePlaybackHeaders({
          streamHeaders: { Referer: pageUrl },
          sourceConfig: config,
          matchPageUrl: pageUrl,
        })
      ),
      matchPageUrl: pageUrl,
      active: true,
      priority: sourcePriority,
      checkedAt: new Date().toISOString(),
      via,
    });
  };

  const extractFromHtml = async (html, pageUrl, tabName) => {
    const before = streams.length;
    const streamGroups = parseListStreamGroups(html);
    const buttons = parseStreamButtons(html, config);

    const tryEmbed = async (embedUrl, name, via = 'axios-list_stream') => {
      if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) return;
      try {
        const url = await extractUrlFromEmbed(embedUrl, pageUrl);
        if (url) push(url, name || tabName || 'HD', via, pageUrl);
      } catch (err) {
        logger.debug('axios embed failed', {
          source: sourceName,
          embedUrl,
          error: err.message,
        });
      }
    };

    const groupCount = Array.isArray(streamGroups) ? streamGroups.length : 0;
    for (let i = 0; i < Math.min(groupCount, maxEmbeds); i += 1) {
      const group = Array.isArray(streamGroups[i]) ? streamGroups[i] : [];
      const embed = group.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
      const button = buttons.find((b) => b.index === i);
      await tryEmbed(embed, button?.name || tabName || `Link ${i + 1}`);
    }

    if (streams.length === before && streamGroups.length) {
      const embeds = [
        ...new Set(
          streamGroups.flat().filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
        ),
      ].slice(0, maxEmbeds);
      for (const [i, embedUrl] of embeds.entries()) {
        await tryEmbed(embedUrl, buttons[i]?.name || tabName || `Link ${i + 1}`);
      }
    }

    if (streams.length === before) {
      for (const embedUrl of extractIframeSrcs(html, pageUrl).slice(0, maxEmbeds)) {
        await tryEmbed(embedUrl, tabName, 'axios-iframe');
      }
    }

    if (streams.length === before) {
      const direct = pickStreamUrl(findStreamPatterns(html, pageUrl));
      if (direct) push(direct, tabName || 'HD', 'axios-direct', pageUrl);
    }
  };

  const matchKey = String(matchPageUrl).replace(/\/$/, '').toLowerCase();
  const extraTabs = tabs.filter(
    (t) => String(t.url).replace(/\/$/, '').toLowerCase() !== matchKey
  );

  await extractFromHtml(firstHtml, matchPageUrl, firstTabName);

  for (const tab of extraTabs.slice(0, maxEmbeds)) {
    const unique = new Set(streams.map((s) => s.url)).size;
    if (unique >= maxEmbeds) break;
    let html = htmlByUrl.get(tab.url);
    if (!html) {
      try {
        html = await axiosGetHtml(tab.url, { referer: matchPageUrl });
        htmlByUrl.set(tab.url, html);
      } catch (err) {
        logger.debug('player tab fetch failed', {
          source: sourceName,
          url: tab.url,
          error: err.message,
        });
        continue;
      }
    }
    await extractFromHtml(html, tab.url, tab.name);
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
  isJsShellHtml,
  isTransientHttpError,
  scraperHttpAgent,
  scraperHttpsAgent,
  createScraperAgents,
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
  parsePlayerTabs,
  parseStreamButtons,
};
