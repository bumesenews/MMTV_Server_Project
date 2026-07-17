const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

const BASE_URL = 'https://www.myanmartvchannels.com/';
const CHANNELS_URL = `${BASE_URL}tv-channels.html`;
const FETCH_CONCURRENCY = 6;
const FETCH_RETRIES = 3;
const FETCH_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 30000;

const ALLOWED_CHANNEL_PATHS = new Set([
  '5-plus-channel.html',
  'channel-7.html',
  'channel9.html',
  'channel-k.html',
  'mrtv-entertainment.html',
  'dvb.html',
  'farmer.html',
  'fortune.html',
  'hluttaw.html',
  'm-channel.html',
  'mahar.html',
  'mahar-bawdi.html',
  'mitv.html',
  'mrtv.html',
  'mrtv-news.html',
  'mrtv-sport.html',
  'mrtv4.html',
  'nrc.html',
]);

/**
 * Myanmar TV channels (from MM_TV.Pro myanmartv.js)
 */
class MyanmarTvSource {
  constructor({ config } = {}) {
    this.name = 'myanmartv';
    this.config = config || {};
    this.baseUrl = (this.config.domains && this.config.domains[0]) || BASE_URL;
    this.channelsUrl =
      this.config.paths?.channels ||
      `${this.baseUrl.replace(/\/$/, '')}/tv-channels.html`;
  }

  headers() {
    return {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  absUrl(url, base = this.baseUrl) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    try {
      return new URL(url, base).href;
    } catch {
      return '';
    }
  }

  channelPath(url) {
    try {
      return new URL(url).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  }

  async fetchHtml(url) {
    let lastError;
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: this.headers(),
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (error) {
        lastError = error;
        if (attempt < FETCH_RETRIES) await sleep(FETCH_DELAY_MS);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error(`Failed to fetch ${url}`);
  }

  parseChannels(html) {
    const $ = load(html);
    const fromList = this.parseListGroupChannels($);
    if (fromList.length) return fromList;
    return this.parseCardChannels($);
  }

  parseListGroupChannels($) {
    const items = [];
    const seen = new Set();
    $('.list-group a.list-group-item').each((_, el) => {
      const anchor = $(el);
      const url = this.absUrl(anchor.attr('href'));
      const path = this.channelPath(url);
      if (!url || seen.has(url)) return;
      if (ALLOWED_CHANNEL_PATHS.size && !ALLOWED_CHANNEL_PATHS.has(path)) return;

      const img = this.absUrl(anchor.find('img').first().attr('src'));
      const title = anchor
        .clone()
        .children('span')
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) return;
      seen.add(url);
      items.push({ title, img, url });
    });
    return items;
  }

  parseCardChannels($) {
    const items = [];
    const seen = new Set();
    $('.card').each((_, el) => {
      const card = $(el);
      const title = card.find('.card-title').first().text().trim();
      const href =
        card.find('a.btn-success').attr('href') || card.find('a').first().attr('href');
      const url = this.absUrl(href);
      const path = this.channelPath(url);
      const img = this.absUrl(card.find('img.card-img-top, img').first().attr('src'));
      if (!title || !url || seen.has(url)) return;
      if (ALLOWED_CHANNEL_PATHS.size && !ALLOWED_CHANNEL_PATHS.has(path)) return;
      seen.add(url);
      items.push({ title, img, url });
    });
    return items;
  }

  extractStreamUrl(html) {
    const direct =
      html.match(/streamingurl\s*[:=]\s*["']([^"']+)["']/i)?.[1] ||
      html.match(/https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i)?.[0];
    if (direct) return direct;

    const candidates = [];
    const sourceRegex = /source:\s*(\w+)\(\)/g;
    let sourceMatch;
    while ((sourceMatch = sourceRegex.exec(html)) !== null) {
      const funcName = sourceMatch[1];
      const funcRe = new RegExp(
        `function\\s+${funcName}\\s*\\(\\)\\s*\\{\\s*return\\((\\[[\\s\\S]*?\\])\\.join\\(""\\)\\s*\\+\\s*(\\w+)\\.join\\(""\\)\\s*\\+\\s*document\\.getElementById\\("([^"]+)"\\)\\.innerHTML\\)\\s*;\\s*\\}`
      );
      const returnMatch = html.match(funcRe);
      if (!returnMatch) continue;
      try {
        const url = buildObfuscatedUrl(html, returnMatch[1], returnMatch[2], returnMatch[3]);
        if (url) candidates.push(url);
      } catch {
        // ignore
      }
    }

    return (
      candidates.find((url) => url.includes('.m3u8')) ||
      candidates.find((url) => /^https?:\/\//.test(url)) ||
      ''
    );
  }

  async collect({ skipStream = false } = {}) {
    logEvent(events.SCRAPER_START, 'MyanmarTV scrape start', { source: this.name });
    const html = await this.fetchHtml(this.channelsUrl || CHANNELS_URL);
    const channels = this.parseChannels(html);
    logger.info('MyanmarTV channels found', { count: channels.length });

    let enriched;
    if (skipStream) {
      enriched = channels.map(({ title, img, url }) => ({
        title,
        img,
        pageUrl: url,
        streamUrl: '',
        source: this.name,
      }));
    } else {
      enriched = await mapWithConcurrency(channels, FETCH_CONCURRENCY, async (channel) => {
        try {
          const pageHtml = await this.fetchHtml(channel.url);
          const streamUrl = this.extractStreamUrl(pageHtml);
          return {
            title: channel.title,
            img: channel.img,
            pageUrl: channel.url,
            streamUrl,
            headers: streamUrl
              ? {
                  'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
                  Referer: channel.url,
                }
              : null,
            active: Boolean(streamUrl),
            source: this.name,
          };
        } catch (err) {
          logger.warn('MyanmarTV channel failed', {
            title: channel.title,
            error: err.message,
          });
          return {
            title: channel.title,
            img: channel.img,
            pageUrl: channel.url,
            streamUrl: '',
            source: this.name,
            active: false,
          };
        }
      });
    }

    logEvent(events.SCRAPER_SUCCESS, 'MyanmarTV scrape success', {
      source: this.name,
      count: enriched.length,
      withStream: enriched.filter((c) => c.streamUrl).length,
    });
    return enriched;
  }
}

function parseJsArray(text) {
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${text})`)();
}

function buildObfuscatedUrl(html, charArrayText, arrayVar, spanId) {
  const prefix = parseJsArray(charArrayText).join('');
  const arrayMatch = html.match(new RegExp(`var\\s+${arrayVar}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;?`));
  const middle = arrayMatch ? parseJsArray(arrayMatch[1]).join('') : '';
  const spanMatch = html.match(new RegExp(`id=["']?${spanId}["']?[^>]*>([^<]+)<`, 'i'));
  const token = spanMatch?.[1] || '';
  return `${prefix}${middle}${token}`;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function runNext() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { MyanmarTvSource };
