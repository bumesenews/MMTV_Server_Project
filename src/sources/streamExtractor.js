const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA } = require('../browser/puppeteerManager');
const { sleep } = require('./baseStreamingSource');
const { cleanText } = require('../utils/normalize');

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
  const waitAfterLoad = Number(detection.waitAfterLoadMs || 8000);
  const waitAfterClick = Number(detection.waitAfterClickMs || 4000);
  const streams = [];

  const sourcePriority = Number(config.priority || 0);

  const pushStream = (url, quality = 'HD', extra = {}) => {
    if (!url || !/\.m3u8/i.test(url)) return;
    streams.push({
      source: sourceName,
      type: 'm3u8',
      quality: cleanText(quality) || 'HD',
      url,
      headers: {
        'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
        Referer: matchPageUrl,
        ...(extra.headers || {}),
      },
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

  // 1) Auto-play / network interception after load
  await sleep(waitAfterLoad);
  collectFromCapture(page, pushStream, 'Auto');

  // Optional play button if nothing yet
  if (!streams.length && Array.isArray(playerRules.clickPlaySelectors)) {
    for (const sel of playerRules.clickPlaySelectors) {
      try {
        const btn = await page.$(sel);
        if (!btn) continue;
        await btn.click({ delay: 40 });
        await sleep(waitAfterClick);
        collectFromCapture(page, pushStream, 'Auto');
        if (streams.length) break;
      } catch {
        // ignore
      }
    }
  }

  // 2) iframe detection
  if (!hasUniqueUrl(streams)) {
    await extractFromIframes(page, selectors.iframe || ['iframe'], pushStream);
  }

  // 3) video source detection
  if (!hasUniqueUrl(streams)) {
    const videoUrls = await page.evaluate((videoSelectors) => {
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

    for (const url of videoUrls) pushStream(url, 'HD', { meta: { via: 'video' } });
  }

  // 4) quality / server buttons
  const qualitySelectors = selectors.qualityButton || [];
  const buttons = await discoverQualityButtons(page, qualitySelectors);

  for (const button of buttons) {
    try {
      const before = new Set(
        (page.__streamCapture?.getUniqueStreams() || []).map((s) => s.url)
      );
      await button.handle.click({ delay: 30 });
      await sleep(waitAfterClick);

      // iframe refresh after quality change
      await extractFromIframes(page, selectors.iframe || ['iframe'], (url, q, extra) => {
        pushStream(url, button.label || q, extra);
      });

      const after = page.__streamCapture?.getUniqueStreams() || [];
      for (const item of after) {
        if (before.has(item.url)) continue;
        pushStream(item.url, button.label || 'HD', {
          headers: buildHeaders(item, matchPageUrl),
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

  // Final sweep of capture buffer
  collectFromCapture(page, pushStream, 'HD');

  return dedupeStreams(streams);
}

function collectFromCapture(page, pushStream, defaultQuality) {
  const items = page.__streamCapture?.getUniqueStreams() || [];
  for (const item of items) {
    pushStream(item.url, defaultQuality, {
      headers: buildHeaders(item, page.url()),
    });
  }
}

function buildHeaders(item, referer) {
  const h = item.headers || {};
  return {
    'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
    Referer: referer || h.referer || h.Referer || '',
    ...(h.cookie || h.Cookie ? { Cookie: h.cookie || h.Cookie } : {}),
  };
}

async function extractFromIframes(page, iframeSelectors, pushStream) {
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
        const src = await frameEl.evaluate((el) => el.src || el.getAttribute('src') || '');
        if (src && /\.m3u8/i.test(src)) {
          pushStream(src, 'HD', { meta: { via: 'iframe-src' } });
        }

        const frame = await frameEl.contentFrame();
        if (!frame) continue;

        const urls = await frame.evaluate(() => {
          const found = [];
          document.querySelectorAll('video, video source, source').forEach((el) => {
            const s = el.currentSrc || el.src || el.getAttribute('src');
            if (s) found.push(s);
          });
          // common player config blobs
          const html = document.documentElement?.innerHTML || '';
          const re = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/gi;
          const matches = html.match(re) || [];
          return [...found, ...matches];
        });

        for (const url of urls) {
          if (/\.m3u8/i.test(url)) pushStream(url, 'HD', { meta: { via: 'iframe' } });
        }
      } catch (err) {
        logger.debug('iframe extract failed', { error: err.message });
      }
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
    const key = String(s.url || '')
      .split('?')[0]
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

module.exports = {
  extractStreamsFromPage,
  discoverQualityButtons,
  dedupeStreams,
};
