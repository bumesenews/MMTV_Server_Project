const { load } = require('cheerio');
const { DateTime } = require('luxon');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA, runExclusivePuppeteerTask } = require('../browser/puppeteerManager');
const { HighlightManager } = require('../services/highlightManager');
const {
  axiosGetHtml,
  findStreamPatterns,
  flvToM3u8,
  pickStreamUrl,
  isTransientHttpError,
} = require('./httpStreamExtractor');

const HOOFOOT_URL = 'https://hoofoot.com/';
const SOCOLIVE_LIST_URL = 'https://socolivepp.tv/video-highlight/';
const MATCH_DATE_RE = /_(\d{4})_(\d{2})_(\d{2})(?:[/?]|$)/;
const RECENT_DAYS = 7;
const TIMEZONE = 'Asia/Yangon';
/** 1GB host: never enrich more than this many videos per source per run. */
const MAX_ITEMS_CAP = Number(process.env.HIGHLIGHT_MAX_ITEMS_CAP || 8);

function asSelectorList(value, fallback = []) {
  if (Array.isArray(value) && value.length) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function cssBackgroundUrl(style) {
  const m = String(style || '').match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
  return m ? m[1] : '';
}

function parseDayMonthDate(day, month, yearHint) {
  const d = Number(day);
  const m = Number(month);
  if (!d || !m || d > 31 || m > 12) return null;
  const now = DateTime.now().setZone(TIMEZONE);
  let year = Number(yearHint) || now.year;
  let dt = DateTime.fromObject({ year, month: m, day: d }, { zone: TIMEZONE });
  if (!dt.isValid) return null;
  if (!yearHint && dt > now.plus({ days: 1 })) dt = dt.minus({ years: 1 });
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * Hoofoot (highlight1) + config-driven Socolive (highlight2).
 * Axios first; Puppeteer only when HTML is blocked. One page at a time (1GB).
 */
class HighlightSource {
  constructor({ config, browserManager } = {}) {
    this.config = config || {};
    this.name = this.config.name || 'highlight1';
    this.parser = String(this.config.parser || this.name || '')
      .toLowerCase()
      .replace(/highlight/, '');
    if (this.name === 'highlight2' || this.config.parser === 'socolive') {
      this.parser = 'socolive';
    } else {
      this.parser = this.parser === 'socolive' ? 'socolive' : 'hoofoot';
    }
    this.browser = browserManager;
    this.baseUrl =
      (this.config.domains && this.config.domains[0]) ||
      (this.parser === 'socolive' ? 'https://socolivepp.tv/' : HOOFOOT_URL);
    const listPath = this.config.paths?.list || this.config.paths?.home || '';
    this.listUrl = listPath ? this.absUrl(listPath, this.baseUrl) : this.baseUrl;
    if (this.parser === 'socolive' && !listPath) {
      this.listUrl = SOCOLIVE_LIST_URL;
    }
    this.recentDays = Number(this.config.recentDays ?? RECENT_DAYS);
    const defaultMax = this.parser === 'socolive' ? 40 : 8;
    const requested = Number(this.config.maxItems || process.env.HIGHLIGHT_LIMIT || defaultMax);
    const cap =
      this.parser === 'socolive'
        ? Number(this.config.maxItemsCap || process.env.HIGHLIGHT2_MAX_ITEMS_CAP || 40)
        : MAX_ITEMS_CAP;
    this.maxItems = Math.max(1, Math.min(requested, cap));
    this.maxPages = Math.max(
      1,
      Number(this.config.maxPages || (this.parser === 'socolive' ? 10 : 1))
    );
    this.pagePath = this.config.paths?.page || '';
    this.dateHelper = new HighlightManager({ retentionDays: this.recentDays });
    this.selectors = this.config.selectors || {};
    this.attrs = {
      href: asSelectorList(this.config.attrs?.href, ['href', 'data-href', 'data-url']),
      src: asSelectorList(this.config.attrs?.src, ['src', 'data-src', 'data-lazy-src']),
    };
  }

  absUrl(url, base = this.baseUrl) {
    if (!url) return '';
    url = String(url).replace(/&amp;/g, '&').trim();
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
    const today = DateTime.now().setZone(TIMEZONE).startOf('day');
    const dates = [];
    // Last N calendar days including today (highlight2: 5 → today .. today-4)
    for (let i = 0; i < this.recentDays; i += 1) {
      dates.push(today.minus({ days: i }).toFormat('yyyy-MM-dd'));
    }
    return new Set(dates);
  }

  listPageUrl(page) {
    const n = Number(page) || 1;
    if (n <= 1) return this.listUrl;
    if (this.pagePath && this.pagePath.includes('{page}')) {
      return this.absUrl(this.pagePath.replace('{page}', String(n)), this.baseUrl);
    }
    const base = this.listUrl.replace(/\/$/, '');
    return `${base}/page/${n}/`;
  }

  extractMatchDateKey(url) {
    const match = String(url || '').match(MATCH_DATE_RE);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  parseHighlights(html) {
    if (this.parser === 'socolive') return this.parseConfigDrivenHighlights(html);
    return this.parseHoofootHighlights(html);
  }

  parseHoofootHighlights(html) {
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

  attrFrom($el, names) {
    for (const name of names || []) {
      const v = $el.attr(name);
      if (v) return v;
    }
    return '';
  }

  parseSocoliveDate(title, url, img) {
    const yearFromImg = String(img || '').match(/\/(20\d{2})\//);
    const slug = String(url || '').match(/-(\d{2})-(\d{2})\/?$/);
    if (slug) return parseDayMonthDate(slug[1], slug[2], yearFromImg?.[1]);
    const titled = String(title || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (titled) return parseDayMonthDate(titled[1], titled[2], yearFromImg?.[1]);
    return this.dateHelper.normalizeDate(title) || this.dateHelper.normalizeDate(url);
  }

  parseConfigDrivenHighlights(html) {
    const $ = load(html);
    const cardSels = asSelectorList(this.selectors.card, [
      '.highlight__item',
      '.splide__slide',
    ]);
    const linkSels = asSelectorList(this.selectors.link, [
      "a[href*='video-highlight']",
      'a',
    ]);
    const titleSels = asSelectorList(this.selectors.title, [
      'p',
      '.highlight__item__content p',
      'img[alt]',
    ]);
    const imageSels = asSelectorList(this.selectors.image, [
      'img',
      '[style*="background-image"]',
    ]);

    const items = [];
    const seen = new Set();
    const listNorm = this.listUrl.replace(/\/$/, '');

    const cards = $(cardSels.join(', '));
    cards.each((_, element) => {
      const card = $(element);
      let link = null;
      for (const sel of linkSels) {
        const n = card.is(sel) ? card : card.find(sel).first();
        if (n.length) {
          link = n;
          break;
        }
      }
      if (!link || !link.length) return;

      const href = this.attrFrom(link, this.attrs.href) || link.attr('href') || '';
      const url = this.absUrl(href, this.listUrl);
      if (!url || seen.has(url)) return;
      if (/\/page\/\d+\/?$/i.test(url) || /\/feed\/?$/i.test(url)) return;
      if (url.replace(/\/$/, '') === listNorm) return;

      let img = '';
      for (const sel of imageSels) {
        const node = card.is(sel) ? card : card.find(sel).first();
        if (!node.length) continue;
        img =
          this.absUrl(cssBackgroundUrl(node.attr('style')), this.listUrl) ||
          this.absUrl(this.attrFrom(node, this.attrs.src), this.listUrl);
        if (img) break;
      }
      if (!img) {
        img = this.absUrl(cssBackgroundUrl(card.attr('style')), this.listUrl);
      }

      let title = '';
      for (const sel of titleSels) {
        const node = card.find(sel).first();
        if (sel.includes('[alt]')) title = node.attr('alt') || '';
        else title = node.text().replace(/\s+/g, ' ').trim();
        if (title) break;
      }
      if (!title) {
        title = (link.attr('title') || link.find('img').attr('alt') || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      const matchDate = this.parseSocoliveDate(title, url, img);
      const slug = url.split('/').filter(Boolean).pop() || url;
      seen.add(url);
      items.push({
        id: `${this.name}:${slug}`,
        title,
        img,
        url,
        matchDate,
      });
    });

    return items;
  }

  async fetchListHtml(url = this.listUrl, { allowPuppeteer = true } = {}) {
    const tries = [
      { referer: url },
      { referer: this.listUrl },
      { referer: this.baseUrl },
      { referer: 'https://www.google.com/' },
    ];
    let lastListError = null;
    for (const attempt of tries) {
      try {
        const html = await axiosGetHtml(url, {
          referer: attempt.referer,
          timeout: 20000,
          retries: 3,
        });
        if (html && html.length > 500 && !/just a moment|cf-browser-verification|access denied/i.test(html)) {
          logger.debug('Highlight list fetched via axios', { url, referer: attempt.referer });
          return html;
        }
      } catch (err) {
        lastListError = err;
        logger.warn('Highlight list axios failed — trying next strategy', {
          error: err.message,
          url,
          referer: attempt.referer,
        });
        // Hang-ups will not be fixed by a different Referer — fall through to Chromium.
        if (isTransientHttpError(err)) break;
      }
    }

    if (!allowPuppeteer || !this.browser) {
      throw lastListError || new Error(`Failed to fetch highlight list ${url}`);
    }
    logger.warn('Highlight list axios failed — falling back to puppeteer', { url });
    return runExclusivePuppeteerTask(async () => {
      const listPage = await this.browser.newPage();
      try {
        await listPage.setUserAgent(process.env.USER_AGENT || DEFAULT_UA);
        await listPage.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(Number(this.browser.timeout) || 45000, 25000),
        });
        await sleep(2000);
        return await listPage.content();
      } finally {
        await this.browser.safeClosePage(listPage);
      }
    });
  }

  extractEmbedFromHtml(html, pageUrl) {
    const $ = load(html);
    const playerSels = asSelectorList(this.selectors.player, [
      '#player iframe',
      '#player a',
      "iframe[src*='embed']",
      'iframe',
    ]);
    for (const sel of playerSels) {
      const node = $(sel).first();
      if (!node.length) continue;
      const src =
        this.attrFrom(node, this.attrs.src) ||
        node.attr('src') ||
        node.attr('href') ||
        '';
      const abs = this.absUrl(src, pageUrl);
      if (abs) return abs;
    }
    const jq = String(html || '').match(
      /jQuery\(['"]#player['"]\)\.html\(['"]([\s\S]*?)['"]\)/i
    );
    if (jq) {
      const iframeSrc = jq[1].match(/src=["']([^"']+)["']/i)?.[1];
      if (iframeSrc) return this.absUrl(iframeSrc.replace(/\\+/g, ''), pageUrl);
    }
    return (
      this.absUrl($('#player a').attr('href'), pageUrl) ||
      this.absUrl($('#player iframe').attr('src'), pageUrl) ||
      this.absUrl($("iframe[src*='embed']").first().attr('src'), pageUrl) ||
      this.extractJwplayerFile(html, pageUrl) ||
      null
    );
  }

  extractJwplayerFile(html, pageUrl) {
    const text = String(html || '');
    const match =
      text.match(/playerInstance\.setup\([\s\S]*?file\s*:\s*['"]([^'"]+)['"]/i) ||
      text.match(/jwplayer\([^)]*\)[\s\S]*?file\s*:\s*['"]([^'"]+)['"]/i) ||
      text.match(/file\s*:\s*['"](https?:[^'"]+\.m3u8[^'"]*)['"]/i);
    return match ? this.absUrl(match[1], pageUrl) : '';
  }

  extractPageM3u8(html, pageUrl) {
    const fromJw = this.extractJwplayerFile(html, pageUrl);
    const htmlUrls = findStreamPatterns(html, pageUrl).flatMap((url) => {
      const hls = flvToM3u8(url);
      return hls ? [hls, url] : [url];
    });
    if (fromJw) htmlUrls.unshift(fromJw);
    return pickBestM3u8(htmlUrls) || pickStreamUrl(htmlUrls.filter((u) => /\.m3u8/i.test(u || ''))) || fromJw || null;
  }

  async collect({ extractM3u8 = true, skipEnrichIds = null, knownIds = null } = {}) {
    logEvent(events.SCRAPER_START, 'Highlight scrape start', { source: this.name });
    const allowed = this.getAllowedDates();
    const skipIds = new Set(
      [...(skipEnrichIds instanceof Set ? skipEnrichIds : skipEnrichIds || [])].map(String)
    );
    void knownIds;

    let highlights = [];
    if (this.parser === 'socolive' && this.maxPages > 1) {
      highlights = await this.collectPagedList(allowed);
    } else {
      const html = await this.fetchListHtml(this.listUrl, { allowPuppeteer: true });
      highlights = this.parseHighlights(html)
        .map((h) => ({
          ...h,
          matchDate: this.dateHelper.normalizeDate(h.matchDate || h.url) || h.matchDate,
        }))
        .filter((h) => h.matchDate && allowed.has(h.matchDate));
      if (this.maxItems > 0) highlights = highlights.slice(0, this.maxItems);
    }

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

  async collectPagedList(allowed) {
    const highlights = [];
    const seen = new Set();
    let pagesUsed = 0;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const url = this.listPageUrl(page);
      let html;
      try {
        html = await this.fetchListHtml(url, { allowPuppeteer: page === 1 });
      } catch (err) {
        logger.warn('Highlight2 list page failed — stop paging', {
          page,
          url,
          error: err.message,
        });
        break;
      }
      pagesUsed += 1;
      const parsed = this.parseHighlights(html).map((h) => ({
        ...h,
        matchDate: this.dateHelper.normalizeDate(h.matchDate || h.url) || h.matchDate,
      }));
      if (!parsed.length) break;

      let inWindow = 0;
      let older = 0;
      for (const item of parsed) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        if (item.matchDate && allowed.has(item.matchDate)) {
          inWindow += 1;
          highlights.push(item);
          if (this.maxItems > 0 && highlights.length >= this.maxItems) break;
        } else if (item.matchDate && item.matchDate < [...allowed].sort()[0]) {
          older += 1;
        }
      }

      logger.info('Highlight2 list page', {
        page,
        parsed: parsed.length,
        inWindow,
        older,
        kept: highlights.length,
      });

      if (this.maxItems > 0 && highlights.length >= this.maxItems) break;
      // Newest-first listing: a full page older than the window means we are done.
      if (parsed.length && older === parsed.length) break;
    }

    logger.info('Highlight2 list complete', {
      pagesUsed,
      count: highlights.length,
      recentDays: this.recentDays,
    });
    return highlights;
  }

  async enrichHighlight(item) {
    let embedUrl = null;
    let m3u8 = null;
    let pageHtml = '';

    try {
      pageHtml = await axiosGetHtml(item.url, { referer: this.listUrl || this.baseUrl });
      embedUrl = this.extractEmbedFromHtml(pageHtml, item.url);
      m3u8 = this.extractPageM3u8(pageHtml, item.url);
      if (m3u8 && (!embedUrl || embedUrl === m3u8)) {
        embedUrl = embedUrl || item.url;
      }
    } catch (err) {
      logger.debug('Highlight match axios failed', {
        title: item.title,
        error: err.message,
      });
    }

    if (!embedUrl && this.browser && this.parser !== 'socolive') {
      await runExclusivePuppeteerTask(async () => {
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
      });
    }

    if (!m3u8 && embedUrl && embedUrl !== item.url) {
      m3u8 = await this.findM3u8FromEmbed(embedUrl);
    }
    if (m3u8 && !embedUrl) embedUrl = item.url;
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

    // 2) puppeteer-core fallback (skip for highlight2 — too heavy on 1GB when paging 5 days)
    if (!this.browser || this.parser === 'socolive') return null;

    return runExclusivePuppeteerTask(async () => {
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
    });
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

module.exports = {
  HighlightSource,
  parseDayMonthDate,
  MAX_ITEMS_CAP,
};
