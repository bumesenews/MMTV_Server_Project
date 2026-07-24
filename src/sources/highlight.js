const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA } = require('../browser/puppeteerManager');
const { HighlightManager } = require('../services/highlightManager');
const {
  axiosGetHtml,
  findStreamPatterns,
  flvToM3u8,
  pickStreamUrl,
} = require('./httpStreamExtractor');

const BASE_URL = 'https://hoofoot.com/';
const MATCH_DATE_RE = /_(\d{4})_(\d{2})_(\d{2})(?:[/?]|$)/;
const RECENT_DAYS = 7;
const TIMEZONE = 'Asia/Yangon';

/**
 * Hoofoot match highlights (from MM_TV.Pro highlight.js)
 * Stream/m3u8: axios HTML first, puppeteer-core fallback.
 * Retention & merge live in HighlightManager.
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

  async fetchListHtml() {
    try {
      const html = await axiosGetHtml(this.baseUrl, { referer: this.baseUrl });
      if (html && html.length > 500) {
        logger.debug('Highlight list fetched via axios');
        return html;
      }
    } catch (err) {
      logger.warn('Highlight list axios failed — falling back to puppeteer', {
        error: err.message,
      });
    }

    if (!this.browser) throw new Error('HighlightSource requires browserManager for list fallback');
    const listPage = await this.browser.newPage();
    try {
      await listPage.setUserAgent(process.env.USER_AGENT || DEFAULT_UA);
      await listPage.goto(this.baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.browser.timeout,
      });
      await sleep(2000);
      return await listPage.content();
    } finally {
      await this.browser.safeClosePage(listPage);
    }
  }

  extractEmbedFromHtml(html, pageUrl) {
    const $ = load(html);
    return (
      this.absUrl($('#player a').attr('href'), pageUrl) ||
      this.absUrl($('#player iframe').attr('src'), pageUrl) ||
      this.absUrl($("iframe[src*='embed']").first().attr('src'), pageUrl) ||
      null
    );
  }

  async collect({ extractM3u8 = true, skipEnrichIds = null, knownIds = null } = {}) {
    logEvent(events.SCRAPER_START, 'Highlight scrape start', { source: this.name });
    const allowed = this.getAllowedDates();
    const skipIds = new Set(
      [...(skipEnrichIds instanceof Set ? skipEnrichIds : skipEnrichIds || [])].map(String)
    );
    void knownIds;

    let highlights = [];
    const html = await this.fetchListHtml();
    highlights = this.parseHighlights(html)
      .map((h) => ({
        ...h,
        matchDate: this.dateHelper.normalizeDate(h.matchDate || h.url),
      }))
      .filter((h) => h.matchDate && allowed.has(h.matchDate));

    if (this.maxItems > 0) highlights = highlights.slice(0, this.maxItems);

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

    try {
      const html = await axiosGetHtml(item.url, { referer: this.baseUrl });
      embedUrl = this.extractEmbedFromHtml(html, item.url);
      if (embedUrl) {
        logger.debug('Highlight embed found via axios', { title: item.title });
      }
    } catch (err) {
      logger.debug('Highlight match axios failed', {
        title: item.title,
        error: err.message,
      });
    }

    if (!embedUrl && this.browser) {
      const page = await this.browser.newPage();
      try {
        await page.goto(item.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.browser.timeout,
        });
        await sleep(1200);
        const html = await page.content();
        embedUrl = this.extractEmbedFromHtml(html, item.url);
      } finally {
        await this.browser.safeClosePage(page);
      }
    }

    let m3u8 = null;
    if (embedUrl) m3u8 = await this.findM3u8FromEmbed(embedUrl);
    return { ...item, embedUrl, m3u8 };
  }

  async findM3u8FromEmbed(embedUrl) {
    // 1) axios first
    try {
      const html = await axiosGetHtml(embedUrl, { referer: this.baseUrl });
      const htmlUrls = findStreamPatterns(html, embedUrl).flatMap((url) => {
        const hls = flvToM3u8(url);
        return hls ? [hls, url] : [url];
      });
      const picked = pickBestM3u8(htmlUrls) || pickStreamUrl(htmlUrls);
      if (picked) {
        logger.debug('Highlight m3u8 found via axios', { embedUrl });
        return picked;
      }
    } catch (err) {
      logger.debug('Highlight embed axios failed — trying puppeteer', {
        embedUrl,
        error: err.message,
      });
    }

    // 2) puppeteer-core fallback
    if (!this.browser) return null;

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
      const htmlUrls = findStreamPatterns(html, embedUrl).flatMap((url) => {
        const hls = flvToM3u8(url);
        return hls ? [hls, url] : [url];
      });
      return pickBestM3u8([...network, ...htmlUrls]);
    } finally {
      await this.browser.safeClosePage(page);
    }
  }
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
