const { logger, logEvent, events } = require('../utils/logger');
const { mergePlaybackHeaders, playbackHeadersForClient } = require('../utils/streamHeaders');
const { sleep } = require('./baseStreamingSource');
const { cleanText } = require('../utils/normalize');
const { isBrowserProtocolError } = require('../utils/streamExtractPolicy');
const { maxPlayerStreams } = require('../utils/scraperConfig');

const IFRAME_SRC_ATTRS = [
  'src',
  'data-src',
  'data-lazy-src',
  'data-url',
  'data-src-player',
  'data-play',
  'data-link',
];

function isFrameUsable(frame) {
  if (!frame) return false;
  try {
    if (typeof frame.isDetached === 'function' && frame.isDetached()) return false;
    if (frame.detached === true) return false;
  } catch {
    return false;
  }
  try {
    const url = frame.url();
    if (!url || url === 'about:blank') return false;
  } catch {
    return false;
  }
  return true;
}

async function safeEvaluate(target, fn, arg) {
  if (!target) return null;
  try {
    if (typeof target.isClosed === 'function' && target.isClosed()) return null;
  } catch {
    return null;
  }
  if (typeof target.url === 'function' && typeof target.isDetached === 'function') {
    if (!isFrameUsable(target)) return null;
  }
  try {
    return arg === undefined ? await target.evaluate(fn) : await target.evaluate(fn, arg);
  } catch (err) {
    if (isBrowserProtocolError(err)) return null;
    throw err;
  }
}

/**
 * Shared stream extraction pipeline used by each source module:
 * 1) Network interception
 * 2) iframe detection
 * 3) video source detection
 * 4) quality/server button interaction
 */
async function extractStreamsFromPage({
  page,
  sourceName,
  config,
  matchPageUrl,
  browserManager,
}) {
  const selectors = config.selectors || {};
  const detection = config.streamDetection || {};
  const playerRules = config.playerRules || {};
  const waitAfterLoad = Number(detection.waitAfterLoadMs || 4000);
  const waitAfterClick = Number(detection.waitAfterClickMs || 2000);
  const iframeRetries = Number(detection.iframeRetries || 2);
  const iframeRetryDelayMs = Number(detection.iframeRetryDelayMs || 400);
  const streams = [];

  const sourcePriority = Number(config.priority || 0);

  const pushStream = (url, quality = 'HD', extra = {}) => {
    if (!url) return;
    if (!/\.m3u8/i.test(url) && !/\/hls\//i.test(url)) return;
    streams.push({
      source: sourceName,
      type: 'm3u8',
      quality: cleanText(quality) || 'HD',
      url,
      headers: playbackHeadersForClient(
        mergePlaybackHeaders({
          streamHeaders: {
            Referer: matchPageUrl,
            ...(extra.headers || {}),
          },
          sourceConfig: config,
          matchPageUrl,
        })
      ),
      matchPageUrl,
      active: true,
      priority: sourcePriority,
      checkedAt: new Date().toISOString(),
      ...extra.meta,
    });
    logEvent(events.STREAM_FOUND, 'Stream found', {
      source: sourceName,
      quality,
      url,
    });
  };

  try {
  await sleep(waitAfterLoad);
  collectFromCapture(page, pushStream, 'Auto', config);

  if (!streams.length && Array.isArray(playerRules.clickPlaySelectors) && !page.isClosed()) {
    for (const sel of playerRules.clickPlaySelectors) {
      try {
        const btn = await page.$(sel);
        if (!btn) continue;
        await btn.click({ delay: 40 });
        await sleep(waitAfterClick);
        collectFromCapture(page, pushStream, 'Auto', config);
        if (streams.length) break;
      } catch {
        // ignore
      }
    }
  }

  if (!hasUniqueUrl(streams) && !page.isClosed()) {
    await extractFromIframes(page, selectors.iframe || ['iframe'], pushStream, {
      retries: iframeRetries,
      retryDelayMs: iframeRetryDelayMs,
    });
  }

  if (!hasUniqueUrl(streams) && !page.isClosed()) {
    try {
    const videoUrls = await safeEvaluate(page, (videoSelectors) => {
      const out = [];
      const sels = videoSelectors || ['video', 'video source'];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((el) => {
          const src = el.currentSrc || el.src || el.getAttribute('src');
          if (src) out.push(src);
        });
      }
      return out;
    }, selectors.video || ['video', 'video source']);

    for (const url of videoUrls || []) pushStream(url, 'HD', { meta: { via: 'video' } });
    } catch (err) {
      logger.debug('video source extract failed', { source: sourceName, error: err.message });
    }
  }

  const qualitySelectors = selectors.qualityButton || [];
  const buttons = page.isClosed() ? [] : await discoverQualityButtons(page, qualitySelectors);
  const clickLimit = maxPlayerStreams();

  for (const button of buttons.slice(0, clickLimit)) {
    try {
      const before = new Set(
        (page.__streamCapture?.getUniqueStreams() || []).map((s) => s.url)
      );
      await button.handle.click({ delay: 30 });
      await sleep(waitAfterClick);

      await extractFromIframes(page, selectors.iframe || ['iframe'], (url, q, extra) => {
        pushStream(url, button.label || q, extra);
      }, { retries: 1, retryDelayMs: iframeRetryDelayMs });

      const after = page.__streamCapture?.getUniqueStreams() || [];
      for (const item of after) {
        if (before.has(item.url)) continue;
        pushStream(item.url, button.label || 'HD', {
          headers: buildHeaders(item, matchPageUrl, config),
        });
      }
    } catch (err) {
      logger.debug('Quality button click failed', {
        source: sourceName,
        label: button.label,
        error: err.message,
      });
    }
  }

  collectFromCapture(page, pushStream, 'HD', config);

  return dedupeStreams(streams);
  } catch (err) {
    logger.warn('Stream page extract interrupted', {
      source: sourceName,
      error: err.message,
    });
    collectFromCapture(page, pushStream, 'HD', config);
    return dedupeStreams(streams);
  }
}

function collectFromCapture(page, pushStream, defaultQuality, config) {
  try {
    const items = page.__streamCapture?.getUniqueStreams() || [];
    let referer = '';
    try {
      referer = page.isClosed() ? '' : page.url();
    } catch {
      referer = '';
    }
    for (const item of items) {
      pushStream(item.url, defaultQuality, {
        headers: buildHeaders(item, referer, config),
      });
    }
  } catch {
    // page/frame already gone
  }
}

function buildHeaders(item, referer, config = {}) {
  const h = item.headers || {};
  return mergePlaybackHeaders({
    streamHeaders: {
      'User-Agent': h['User-Agent'] || h['user-agent'],
      Referer: h.Referer || h.referer || referer,
      Origin: h.Origin || h.origin,
      ...(h.cookie || h.Cookie ? { Cookie: h.cookie || h.Cookie } : {}),
    },
    sourceConfig: config,
    matchPageUrl: referer,
  });
}

async function extractFromIframes(page, iframeSelectors, pushStream, options = {}) {
  const retries = Math.max(1, Number(options.retries || 2));
  const retryDelayMs = Number(options.retryDelayMs || 400);

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (page.isClosed()) return;
    const foundBefore = { n: 0 };
    const countedPush = (url, q, extra) => {
      foundBefore.n += 1;
      pushStream(url, q, extra);
    };

    const srcs = await collectIframeSrcsFromPage(page);
    for (const src of srcs) {
      if (/\.m3u8/i.test(src) || /\/hls\//i.test(src)) {
        countedPush(src, 'HD', { meta: { via: 'iframe-src' } });
      }
    }

    await extractFromChildFrames(page, countedPush);
    await extractFromIframeHandles(page, iframeSelectors, countedPush);

    if (foundBefore.n > 0) return;
    if (attempt < retries - 1) {
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  await extractM3u8FromMainDocument(page, pushStream);
}

async function collectIframeSrcsFromPage(page) {
  const srcs = await safeEvaluate(page, (attrs) => {
    const out = [];
    document.querySelectorAll('iframe, embed, object').forEach((el) => {
      for (const name of attrs) {
        const value = el.getAttribute(name);
        if (value && !/about:blank|chatboxn\.com|javascript:/i.test(value)) {
          out.push(value);
        }
      }
    });
    return out;
  }, IFRAME_SRC_ATTRS);
  return Array.isArray(srcs) ? [...new Set(srcs)] : [];
}

async function extractFromChildFrames(page, pushStream) {
  let frames = [];
  try {
    frames = page.frames() || [];
  } catch {
    return;
  }
  for (const frame of frames) {
    if (!isFrameUsable(frame)) continue;
    try {
      if (frame === page.mainFrame()) continue;
    } catch {
      continue;
    }
    const urls = await safeEvaluate(frame, collectPlayerUrlsInDocument);
    for (const url of urls || []) {
      if (/\.m3u8/i.test(url) || /\/hls\//i.test(url)) {
        pushStream(url, 'HD', { meta: { via: 'iframe' } });
      }
    }
  }
}

async function extractFromIframeHandles(page, iframeSelectors, pushStream) {
  const list = Array.isArray(iframeSelectors) ? iframeSelectors : [iframeSelectors];
  for (const selector of list.filter(Boolean)) {
    let frames = [];
    try {
      frames = await page.$$(selector);
    } catch {
      continue;
    }

    for (const frameEl of frames) {
      try {
        const src = await safeEvaluate(frameEl, (el) => {
          const attrs = ['src', 'data-src', 'data-lazy-src', 'data-url'];
          for (const name of attrs) {
            const value = el.getAttribute(name) || el[name];
            if (value) return value;
          }
          return '';
        });
        if (src && (/\.m3u8/i.test(src) || /\/hls\//i.test(src))) {
          pushStream(src, 'HD', { meta: { via: 'iframe-src' } });
        }

        let frame = null;
        try {
          frame = await frameEl.contentFrame();
        } catch {
          frame = null;
        }
        if (!isFrameUsable(frame)) continue;

        const urls = await safeEvaluate(frame, collectPlayerUrlsInDocument);
        for (const url of urls || []) {
          if (/\.m3u8/i.test(url) || /\/hls\//i.test(url)) {
            pushStream(url, 'HD', { meta: { via: 'iframe' } });
          }
        }
      } catch (err) {
        logger.debug('iframe extract failed', { error: err.message });
      }
    }
  }
}

function collectPlayerUrlsInDocument() {
  const found = [];
  document.querySelectorAll('video, video source, source').forEach((el) => {
    const s = el.currentSrc || el.src || el.getAttribute('src');
    if (s) found.push(s);
  });
  const html = document.documentElement?.innerHTML || '';
  const re = /https?:\/\/[^"'\s<>]+?(?:\.m3u8|\/hls\/)[^"'\s<>]*/gi;
  const matches = html.match(re) || [];
  return [...found, ...matches];
}

async function extractM3u8FromMainDocument(page, pushStream) {
  const urls = await safeEvaluate(page, collectPlayerUrlsInDocument);
  for (const url of urls || []) {
    if (/\.m3u8/i.test(url) || /\/hls\//i.test(url)) {
      pushStream(url, 'HD', { meta: { via: 'page-html' } });
    }
  }
}

async function discoverQualityButtons(page, selectorList) {
  const buttons = [];
  const list = Array.isArray(selectorList) ? selectorList : [selectorList];

  for (const selector of list.filter(Boolean)) {
    try {
      const nodes = await page.$$(selector);
      for (const handle of nodes) {
        const label = await handle.evaluate((el) =>
          (el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '')
            .trim()
        );
        const cleaned = cleanText(label);
        if (!cleaned) continue;
        // Skip obvious non-quality UI
        if (/login|sign|menu|home|share|chat/i.test(cleaned)) continue;
        buttons.push({ handle, label: cleaned, selector });
      }
      if (buttons.length) break;
    } catch {
      // try next selector
    }
  }

  // Deduplicate by label
  const seen = new Set();
  return buttons.filter((b) => {
    const key = b.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasUniqueUrl(streams) {
  return streams.some((s) => s.url);
}

function dedupeStreams(streams) {
  const seen = new Set();
  const out = [];
  for (const s of streams) {
    const src = String(s.source || '').toLowerCase();
    const url = String(s.url || '')
      .split('#')[0]
      .toLowerCase();
    const key = `${src}::${url}`;
    if (!url || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

module.exports = {
  extractStreamsFromPage,
  discoverQualityButtons,
  dedupeStreams,
  isFrameUsable,
  IFRAME_SRC_ATTRS,
};
