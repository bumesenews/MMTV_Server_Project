const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA } = require('../browser/puppeteerManager');
const { HighlightManager } = require('../services/highlightManager');

const BASE_URL = 'https://hoofoot.com/';
const MATCH_DATE_RE = /_(\d{4})_(\d{2})_(\d{2})(?:[/?]|$)/;
const RECENT_DAYS = 7;
const TIMEZONE = 'Asia/Yangon';

/**
 * Hoofoot match highlights (from MM_TV.Pro highlight.js)
 * Parsing / enrich logic kept intact — retention & merge live in HighlightManager.
 */
class HighlightSource {
  constructor({ config, browserManager } = {}) {
    this.name = 'highlight';
    this.config = config || {};
    this.browser = browserManager;
    this.baseUrl = (this.config.domains && this.config.domains[0]) || BASE_URL;
    this.recentDays = Number(this.config.recentDays ?? RECENT_DAYS);
    this.maxItems = Number(this.config.maxItems || process.env.HIGHLIGHT_LIMIT || 50);
    this.dateHelper = new HighlightManager({ retentionDays: this.recentDays });
  }

  absUrl(url, base = this.baseUrl) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('./')) return `${this.baseUrl}${url.slice(2)}`;
    if (url.startsWith('/')) return `${this.baseUrl.replace(/\/$/, '')}${url}`;
    try {
      return new URL(url, base).href;
    } catch {
      return '';
    }
  }

  getAllowedDates() {
    const { DateTime } = require('luxon');
    const today = DateTime.now().setZone(TIMEZONE).startOf('day');
    const dates = [];
    // Keep N calendar days including today (aligned with HighlightManager retention)
    for (let i = 0; i < this.recentDays; i += 1) {
      dates.push(today.minus({ days: i }).toFormat('yyyy-MM-dd'));
    }
    return new Set(dates);
  }

  extractMatchDateKey(url) {
    const match = String(url || '').match(MATCH_DATE_RE);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  parseHighlights(html) {
    const $ = load(html);
    const items = [];
    const seen = new Set();

    $('#gallery > .box > #port').each((_, element) => {
      const anchor = $(element).find('a[id^="rut"]').first();
      if (!anchor.length) return;

      const rutId = anchor.attr('id') || '';
      const id = rutId.replace(/^rut/, '');
      const href = anchor.attr('href') || '';
      const url = this.absUrl(href);
      if (!url || seen.has(url)) return;
      seen.add(url);

      const img = this.absUrl(anchor.find('img').attr('src'));
      const title =
        $(element).find(`#d${id}`).text().trim() ||
        anchor.attr('title')?.trim() ||
        anchor.find('img').attr('alt')?.trim() ||
        '';

      const cardText = $(element).text().replace(/\s+/g, ' ').trim();
      const matchDate =
        this.extractMatchDateKey(url) ||
        this.dateHelper.normalizeDate(cardText) ||
        this.dateHelper.normalizeDate(title);

      items.push({
        id: id || url,
        title,
        img,
        url,
        matchDate,
      });
    });

    return items;
  }

  async collect({ extractM3u8 = true, skipEnrichIds = null, knownIds = null } = {}) {
    if (!this.browser) throw new Error('HighlightSource requires browserManager');

    logEvent(events.SCRAPER_START, 'Highlight scrape start', { source: this.name });
    const allowed = this.getAllowedDates();
    const skipIds = new Set(
      [...(skipEnrichIds instanceof Set ? skipEnrichIds : skipEnrichIds || [])].map(String)
    );
    void knownIds;

    // 1) List page only — close before any embed work (never hold 2 Chromium pages)
    let highlights = [];
    const listPage = await this.browser.newPage();
    try {
      await listPage.setUserAgent(process.env.USER_AGENT || DEFAULT_UA);
      await listPage.goto(this.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.browser.timeout,
      });
      await sleep(2000);
      const html = await listPage.content();
      highlights = this.parseHighlights(html)
        .map((h) => ({
          ...h,
          matchDate: this.dateHelper.normalizeDate(h.matchDate || h.url),
        }))
        .filter((h) => h.matchDate && allowed.has(h.matchDate));

      if (this.maxItems > 0) highlights = highlights.slice(0, this.maxItems);
    } finally {
      await this.browser.safeClosePage(listPage);
    }

    // 2) Enrich one highlight at a time (match page → close → embed page → close)
    if (extractM3u8) {
      let enriched = 0;
      let skipped = 0;
      for (let i = 0; i < highlights.length; i += 1) {
        const key = String(highlights[i].id || '');
        if (key && skipIds.has(key)) {
          skipped += 1;
          logger.debug('Highlight enrich skipped — m3u8 already cached', {
            id: key,
            title: highlights[i].title,
          });
          continue;
        }
        try {
          highlights[i] = await this.enrichHighlight(highlights[i]);
          enriched += 1;
        } catch (err) {
          logger.warn('Highlight enrich failed', {
            title: highlights[i].title,
            error: err.message,
          });
          highlights[i] = {
            ...highlights[i],
            embedUrl: null,
            m3u8: null,
            error: err.message,
          };
        }
      }
      logger.info('Highlight enrich pass', {
        total: highlights.length,
        enriched,
        skippedCached: skipped,
      });
    }

    const result = highlights.map((h) => ({
      id: h.id,
      title: h.title,
      img: h.img,
      url: h.url,
      matchDate: h.matchDate,
      embedUrl: h.embedUrl || null,
      m3u8: h.m3u8 || null,
      headers: h.m3u8
        ? {
            'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
            Referer: h.embedUrl || h.url || this.baseUrl,
          }
        : null,
      source: this.name,
    }));

    logEvent(events.SCRAPER_SUCCESS, 'Highlight scrape success', {
      source: this.name,
      count: result.length,
      withM3u8: result.filter((r) => r.m3u8).length,
    });

    return result;
  }

  async enrichHighlight(item) {
    let embedUrl = null;
    const page = await this.browser.newPage();
    try {
      await page.goto(item.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.browser.timeout,
      });
      await sleep(1200);
      const html = await page.content();
      const $ = load(html);
      embedUrl =
        this.absUrl($('#player a').attr('href'), item.url) ||
        this.absUrl($('#player iframe').attr('src'), item.url) ||
        this.absUrl($("iframe[src*='embed']").first().attr('src'), item.url) ||
        null;
    } finally {
      await this.browser.safeClosePage(page);
    }

    let m3u8 = null;
    if (embedUrl) m3u8 = await this.findM3u8FromEmbed(embedUrl);
    return { ...item, embedUrl, m3u8 };
  }

  async findM3u8FromEmbed(embedUrl) {
    const page = await this.browser.newInterceptPage([/\.m3u8/i]);
    try {
      await page.goto(embedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.browser.timeout,
      });
      await sleep(3000);
      await page.click('video, .vjs-big-play-button, .play-button, button').catch(() => {});
      await sleep(3500);

      const network = (page.__streamCapture?.getUniqueStreams() || []).map((s) => s.url);
      const html = await page.content();
      const htmlUrls = findPatterns(html, embedUrl).flatMap((url) => {
        const hls = flvToM3u8(url);
        return hls ? [hls, url] : [url];
      });
      return pickBestM3u8([...network, ...htmlUrls]);
    } finally {
      await this.browser.safeClosePage(page);
    }
  }
}

function findPatterns(text, baseUrl) {
  const found = new Set();
  const regexes = [
    /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi,
    /streamingurl\s*[:=]\s*["']([^"']+)["']/gi,
    /urlStream\s*=\s*["']([^"']+)["']/gi,
    /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
  ];
  for (const regex of regexes) {
    for (const match of text.matchAll(regex)) {
      const value = match[1] || match[0];
      if (!value || /localhost/i.test(value)) continue;
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

function pickBestM3u8(urls) {
  const cleaned = [...new Set(urls)].filter(
    (url) => url && !/localhost/i.test(url) && /\.m3u8/i.test(url)
  );
  if (!cleaned.length) return null;
  return cleaned.sort((a, b) => {
    const score = (url) => {
      let s = 0;
      if (/\/manifest\/0\.m3u8/i.test(url)) s += 50;
      if (/master/i.test(url)) s += 40;
      if (/index\.m3u8/i.test(url)) s += 30;
      if (/1080|720/i.test(url)) s += 20;
      return s;
    };
    return score(b) - score(a);
  })[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { HighlightSource };
