const { load } = require('cheerio');
const { DateTime } = require('luxon');
const { logger, logEvent, events } = require('../utils/logger');
const { nowYangon } = require('../utils/time');
const { axiosGetHtml } = require('./httpStreamExtractor');
const { runExclusivePuppeteerTask } = require('../browser/puppeteerManager');

const BASE_URL = 'https://www.predictz.com/';
const TODAY_URL = 'https://www.predictz.com/predictions/';
const TOMORROW_URL = 'https://www.predictz.com/predictions/tomorrow/';
const TIMEZONE = 'Asia/Yangon';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHeadingDate(text) {
  const cleaned = String(text || '').replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const match = cleaned.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!match) return null;
  const dt = DateTime.fromFormat(`${match[1]} ${match[2]} ${match[3]}`, 'MMMM d yyyy', {
    zone: 'utc',
  });
  return dt.isValid ? dt.toISODate() : null;
}

function yangonDateOffset(days) {
  return nowYangon().plus({ days }).toFormat('yyyy-MM-dd');
}

function tipIdFromUrl(url) {
  const match = String(url || '').match(/\/(\d+)\/?$/);
  return match ? match[1] : null;
}

function predictionSide(prediction) {
  const value = String(prediction || '').toLowerCase();
  if (value.startsWith('home')) return 'home';
  if (value.startsWith('away')) return 'away';
  if (value.startsWith('draw')) return 'draw';
  return 'other';
}

function formLetters($, box) {
  if (!box || !box.length) return [];
  return box
    .find('.ptneonboxsml2, .neonboxsml2')
    .toArray()
    .map((el) => clean($(el).text()))
    .filter(Boolean);
}

function parseOdds($, row) {
  const values = row
    .find('.pttd.ptodds')
    .toArray()
    .map((el) => clean($(el).text()))
    .filter((v) => v && /^\d+(\.\d+)?$/.test(v));
  if (values.length < 3) {
    return { home: null, draw: null, away: null };
  }
  return { home: values[0], draw: values[1], away: values[2] };
}

/**
 * Parse PredictZ predictions table HTML into tip rows.
 */
function parseTipsHtml(html, { day = 'today', date = null, pageUrl = '' } = {}) {
  const $ = load(html || '');
  const heading = clean($('h1').first().text());
  const resolvedDate = date || parseHeadingDate(heading) || yangonDateOffset(day === 'tomorrow' ? 1 : 0);

  let league = '';
  const tips = [];
  const seen = new Set();

  $('.pttrnh.ptttl, .pttr.ptcnt').each((_, el) => {
    const row = $(el);
    if (row.hasClass('ptttl')) {
      league = clean(row.find('.ptlg').first().text()).replace(/\s+Tips$/i, '');
      return;
    }

    const homeTeam = clean(row.find('.ptmobh').first().text());
    const awayTeam = clean(row.find('.ptmoba').first().text());
    const match =
      clean(row.find('.ptgame').first().text()) ||
      (homeTeam && awayTeam ? `${homeTeam} v ${awayTeam}` : '');
    const prediction = clean(row.find('.ptpredboxsml').first().text());
    const href =
      row.find('.ptgame a').first().attr('href') ||
      row.find('.ptclick a').first().attr('href') ||
      '';
    const url = href
      ? href.startsWith('http')
        ? href
        : new URL(href, BASE_URL).href
      : '';
    if (!homeTeam || !awayTeam || !prediction) return;

    const key = url || `${league}|${homeTeam}|${awayTeam}|${prediction}`;
    if (seen.has(key)) return;
    seen.add(key);

    tips.push({
      id: tipIdFromUrl(url) || key,
      day,
      date: resolvedDate,
      league: league || null,
      homeTeam,
      awayTeam,
      match,
      prediction,
      predictionSide: predictionSide(prediction),
      odds: parseOdds($, row),
      homeForm: formLetters($, row.find('.ptlast5boxh').first()),
      awayForm: formLetters($, row.find('.ptlast5boxa').first()),
      url: url || null,
    });
  });

  return {
    day,
    date: resolvedDate,
    label: heading || (day === 'tomorrow' ? "Tomorrow's Tips" : "Today's Tips"),
    pageUrl,
    count: tips.length,
    tips,
  };
}

class TipsSource {
  constructor({ config, browserManager } = {}) {
    this.name = 'tips';
    this.config = config || {};
    this.browser = browserManager;
    this.baseUrl = (this.config.domains && this.config.domains[0]) || BASE_URL;
    this.todayUrl = this.config.paths?.today || TODAY_URL;
    this.tomorrowUrl = this.config.paths?.tomorrow || TOMORROW_URL;
  }

  async fetchHtml(url) {
    try {
      const html = await axiosGetHtml(url, { referer: this.baseUrl, timeout: 25000, retries: 5 });
      if (html && html.includes('pttable')) return html;
      logger.debug('PredictZ axios HTML missing pttable, trying browser', { url });
    } catch (err) {
      logger.debug('PredictZ axios blocked, trying browser', { url, error: err.message });
    }

    if (!this.browser) {
      throw new Error('PredictZ HTML fetch failed and no browser is available');
    }

    return runExclusivePuppeteerTask(async () => {
      const page = await this.browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.browser.timeout || 25000 });
        await page.waitForSelector('.pttable', { timeout: 12000 }).catch(() => {});
        await sleep(800);
        return await page.content();
      } finally {
        await this.browser.safeClosePage(page);
      }
    });
  }

  async scrapeDay(day) {
    const pageUrl = day === 'tomorrow' ? this.tomorrowUrl : this.todayUrl;
    const date = yangonDateOffset(day === 'tomorrow' ? 1 : 0);
    const html = await this.fetchHtml(pageUrl);
    return parseTipsHtml(html, { day, date, pageUrl });
  }

  async collect() {
    logEvent(events.SCRAPER_START, 'PredictZ tips scrape start', { source: this.name });
    const today = await this.scrapeDay('today');
    const tomorrow = await this.scrapeDay('tomorrow');
    const payload = {
      source: this.baseUrl,
      scraped_at: new Date().toISOString(),
      timezone: TIMEZONE,
      today,
      tomorrow,
      count: (today.tips?.length || 0) + (tomorrow.tips?.length || 0),
    };
    logEvent(events.SCRAPER_SUCCESS, 'PredictZ tips scrape success', {
      source: this.name,
      today: today.count,
      tomorrow: tomorrow.count,
    });
    return payload;
  }
}

module.exports = {
  TipsSource,
  parseTipsHtml,
  parseHeadingDate,
  TODAY_URL,
  TOMORROW_URL,
  BASE_URL,
};
