const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { axiosGetHtml } = require('../sources/httpStreamExtractor');
const { sleep } = require('../sources/baseStreamingSource');
const {
  parseStreamUrl,
  matchStreamToFotmob,
} = require('../utils/streamUrlHelper');
const {
  minutesUntilKickoff,
  STREAM_FIND_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  isTodayOrTomorrow,
  toYangon,
} = require('../utils/time');
const { cleanText } = require('../utils/normalize');

/** Default match-detail path pattern (Vietnamese live sites). */
const DEFAULT_LINK_PATTERN = /truc-tiep\/[^\s"'<>#?]+/gi;

const CLOUDFLARE_MARKERS =
  /cloudflare|cf-browser-verification|attention required|just a moment|enable javascript and cookies|access denied|sorry, you have been blocked/i;

/**
 * Efficient multi-match discovery for 15–20 FotMob fixtures:
 * 1) One Axios GET of the live list HTML
 * 2) Extract all `truc-tiep/...` detail URLs
 * 3) Match only fixtures in the kickoff−30m window via matchStreamToFotmob
 * 4) Puppeteer fallback (memory-optimized browser) if Axios/Cloudflare/empty
 */
class MultiMatchScraper {
  constructor({
    browser = null,
    sourceName = 'streaming',
    linkPattern = DEFAULT_LINK_PATTERN,
    windowLeadMinutes = STREAM_FIND_LEAD_MIN,
    windowStopMinutes = STREAM_SEARCH_STOP_AFTER_MIN,
    requireLeague = true,
  } = {}) {
    this.browser = browser;
    this.sourceName = sourceName;
    this.linkPattern = linkPattern;
    this.windowLeadMinutes = windowLeadMinutes;
    this.windowStopMinutes = windowStopMinutes;
    this.requireLeague = requireLeague;
  }

  /**
   * Discover match pages for FotMob fixtures (today/tomorrow targets).
   *
   * @param {object} opts
   * @param {string[]} opts.listUrls - Live list / schedule page URLs
   * @param {object[]} opts.fixtures - FotMob matches
   * @param {object} [opts.config] - source config (selectors for league context)
   * @returns {Promise<object[]>} discovered rows keyed to fotmob matchId + matchUrl
   */
  async discoverForFixtures({ listUrls = [], fixtures = [], config = {} } = {}) {
    const due = (fixtures || []).filter((f) => this.isFixtureDue(f));
    if (!due.length) {
      logger.debug(`${this.sourceName} multi-match: no fixtures in −30m window`);
      return [];
    }

    const urls = [...new Set((listUrls || []).filter(Boolean))];
    if (!urls.length) return [];

    let entries = [];
    let method = 'axios';

    try {
      entries = await this.fetchListEntriesAxios(urls, config);
      if (!entries.length) {
        throw new Error('empty_match_links');
      }
    } catch (err) {
      logger.warn(`${this.sourceName} list Axios failed — Puppeteer fallback`, {
        source: this.sourceName,
        error: err.message,
      });
      if (!this.browser) {
        logEvent(events.SCRAPER_ERROR, `${this.sourceName} list scrape failed`, {
          source: this.sourceName,
          error: err.message,
        });
        return [];
      }
      method = 'puppeteer';
      entries = await this.fetchListEntriesPuppeteer(urls, config);
    }

    const matched = this.matchFixturesToEntries(due, entries);
    logEvent(events.SCRAPER_SUCCESS, `${this.sourceName} multi-match discover`, {
      source: this.sourceName,
      method,
      listUrls: urls.length,
      linkCount: entries.length,
      dueFixtures: due.length,
      matched: matched.length,
    });
    return matched;
  }

  /**
   * currentTime >= kickoff − 30m, and still inside search window (before +15m).
   */
  isFixtureDue(fixture) {
    if (!fixture?.kickoff) return false;
    const kickoff = toYangon(fixture.kickoff);
    if (!kickoff || !isTodayOrTomorrow(kickoff)) return false;

    const mins = minutesUntilKickoff(fixture.kickoff);
    if (mins == null) return false;
    if (mins > this.windowLeadMinutes) return false; // too early
    if (mins <= -this.windowStopMinutes) return false; // past stop
    return true;
  }

  async fetchListEntriesAxios(listUrls, config) {
    const all = [];
    for (const listUrl of listUrls) {
      // eslint-disable-next-line no-await-in-loop
      const html = await axiosGetHtml(listUrl, { referer: listUrl });
      if (this.looksBlockedOrEmpty(html)) {
        throw new Error('antibot_or_empty_html');
      }
      all.push(...this.extractMatchEntries(html, listUrl, config));
    }
    return dedupeEntries(all);
  }

  async fetchListEntriesPuppeteer(listUrls, config) {
    if (!this.browser) return [];

    const page = await this.browser.newPage();
    const all = [];
    const waitUntil = config.discover?.waitUntil || 'domcontentloaded';
    const waitMs = Number(config.discover?.waitMs || 2500);

    try {
      for (const listUrl of listUrls) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await page.goto(listUrl, {
            waitUntil,
            timeout: this.browser.timeout,
          });
          // eslint-disable-next-line no-await-in-loop
          await sleep(waitMs);

          if (config.discover?.scroll) {
            const scrollY = Number(config.discover.scrollY || 1400);
            // eslint-disable-next-line no-await-in-loop
            await page.evaluate((y) => window.scrollBy(0, y), scrollY);
            // eslint-disable-next-line no-await-in-loop
            await sleep(Number(config.discover.scrollWaitMs || 800));
          }

          // eslint-disable-next-line no-await-in-loop
          const html = await page.content();
          if (this.looksBlockedOrEmpty(html)) {
            logger.warn(`${this.sourceName} Puppeteer list still blocked/empty`, {
              url: listUrl,
            });
            continue;
          }
          all.push(...this.extractMatchEntries(html, listUrl, config));
        } catch (err) {
          logger.warn(`${this.sourceName} Puppeteer list page failed`, {
            url: listUrl,
            error: err.message,
          });
        }
      }
    } finally {
      await this.browser.safeClosePage(page);
    }

    return dedupeEntries(all);
  }

  looksBlockedOrEmpty(html) {
    const text = String(html || '').trim();
    if (text.length < 400) return true;
    if (CLOUDFLARE_MARKERS.test(text)) return true;
    if (!/truc-tiep\//i.test(text)) return true;
    return false;
  }

  /**
   * Extract detail URLs (+ optional league/country context) from list HTML.
   */
  extractMatchEntries(html, baseUrl, config = {}) {
    const fromCheerio = this.extractViaCheerio(html, baseUrl, config);
    const fromRegex = this.extractViaRegex(html, baseUrl);

    const byUrl = new Map();
    for (const row of [...fromCheerio, ...fromRegex]) {
      if (!row?.url) continue;
      const prev = byUrl.get(row.url);
      if (!prev) {
        byUrl.set(row.url, row);
        continue;
      }
      // Prefer row with league/country context
      byUrl.set(row.url, {
        ...prev,
        ...row,
        league: row.league || prev.league,
        country: row.country || prev.country,
      });
    }

    // Attach parseStreamUrl fields for matching
    const out = [];
    for (const row of byUrl.values()) {
      const parsed = parseStreamUrl(row.url);
      out.push({
        ...parsed,
        ...row,
        url: row.url,
        matchUrl: row.url,
        slug: parsed.slug || row.slug,
        league: row.league || parsed.league,
        country: row.country || parsed.country,
        homeTeam: parsed.homeTeam || row.homeTeam,
        awayTeam: parsed.awayTeam || row.awayTeam,
      });
    }
    return out;
  }

  extractViaCheerio(html, baseUrl, config) {
    const $ = load(html || '');
    const leagueSelectors = asList(
      config.selectors?.league || [
        '.league-name',
        '.competition',
        '.tour-title',
        '.league',
        '.tour-name',
      ]
    );
    const cardSelectors = asList(
      config.selectors?.matchCard || [
        '.match-item',
        '.match-card',
        '.fixture-item',
        '.event-card',
        'a[href*="truc-tiep"]',
      ]
    );

    const out = [];
    const seen = new Set();

    const consider = (href, contextEl) => {
      const abs = absoluteUrl(href, baseUrl);
      if (!abs || !/truc-tiep\//i.test(abs) || seen.has(abs)) return;
      seen.add(abs);

      let league = '';
      let country = '';
      if (contextEl && contextEl.length) {
        for (const sel of leagueSelectors) {
          const t = cleanText(contextEl.find(sel).first().text());
          if (t) {
            league = t;
            break;
          }
        }
        if (!league) {
          const heading = cleanText(
            contextEl
              .closest('section, .league-block, .match-list, .list-match, .box')
              .find('h2, h3, .title, .league-name, .competition')
              .first()
              .text()
          );
          league = heading;
        }
        const ccode = cleanText(
          contextEl.attr('data-country') ||
            contextEl.attr('data-ccode') ||
            contextEl.find('[data-ccode]').attr('data-ccode') ||
            ''
        );
        country = ccode;
      }

      out.push({ url: abs, league, country });
    };

    // Prefer structured cards
    for (const cardSel of cardSelectors) {
      $(cardSel).each((_, el) => {
        const $el = $(el);
        const href =
          $el.attr('href') ||
          $el.find('a[href*="truc-tiep"]').attr('href') ||
          $el.closest('a[href*="truc-tiep"]').attr('href') ||
          '';
        consider(href, $el);
      });
    }

    // All remaining truc-tiep anchors
    $('a[href*="truc-tiep"]').each((_, el) => {
      const $el = $(el);
      consider($el.attr('href'), $el.parent());
    });

    return out;
  }

  extractViaRegex(html, baseUrl) {
    const pattern = this.linkPattern instanceof RegExp
      ? new RegExp(
          this.linkPattern.source,
          this.linkPattern.flags.includes('g')
            ? this.linkPattern.flags
            : `${this.linkPattern.flags}g`
        )
      : DEFAULT_LINK_PATTERN;

    const out = [];
    const seen = new Set();
    for (const match of String(html || '').matchAll(pattern)) {
      const raw = match[0];
      if (!raw) continue;
      let path = raw.replace(/^https?:\/\/[^/]+/i, '');
      if (!path.startsWith('/')) path = `/${path}`;
      // strip trailing junk
      path = path.replace(/["'<>].*$/, '').replace(/\/+$/, '/');
      const abs = absoluteUrl(path, baseUrl);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      out.push({ url: abs, league: '', country: '' });
    }
    return out;
  }

  /**
   * Map due FotMob fixtures → stream list entries via 3-layer matcher.
   */
  matchFixturesToEntries(fixtures, entries) {
    const usedUrls = new Set();
    const out = [];

    for (const fixture of fixtures || []) {
      let hit = null;
      for (const entry of entries || []) {
        if (!entry?.url || usedUrls.has(entry.url)) continue;

        const streamData = {
          ...entry,
          url: entry.url,
          slug: entry.slug,
          league: entry.league,
          country: entry.country || entry.ccode,
          utcTimestamp: entry.utcTimestamp,
          utcDate: entry.utcDate,
          utcIso: entry.utcIso,
        };

        const ok = matchStreamToFotmob(fixture, streamData, {
          windowMinutes: this.windowLeadMinutes,
          skipLeagueCheck: !this.requireLeague && !streamData.league && !streamData.country,
        });

        if (ok) {
          hit = entry;
          break;
        }
      }

      // Soft retry: if league context missing on all entries, allow layers 1+3 only
      if (!hit && this.requireLeague) {
        for (const entry of entries || []) {
          if (!entry?.url || usedUrls.has(entry.url)) continue;
          if (entry.league || entry.country) continue; // already tried with league
          const ok = matchStreamToFotmob(
            fixture,
            { ...entry, url: entry.url },
            { windowMinutes: this.windowLeadMinutes, skipLeagueCheck: true }
          );
          if (ok) {
            hit = entry;
            break;
          }
        }
      }

      if (!hit) continue;

      usedUrls.add(hit.url);
      out.push({
        matchId: fixture.matchId,
        league: fixture.league,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        date: fixture.date,
        time: fixture.time,
        kickoff: fixture.kickoff,
        matchUrl: hit.url,
        source: this.sourceName,
        originalNames: {
          ...(fixture.originalNames || {}),
          [this.sourceName]: {
            league: hit.league || fixture.league,
            homeTeam: hit.homeTeam || fixture.homeTeam,
            awayTeam: hit.awayTeam || fixture.awayTeam,
            url: hit.url,
          },
        },
      });
    }

    return out;
  }
}

function absoluteUrl(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return '';
  }
}

function dedupeEntries(entries) {
  const map = new Map();
  for (const e of entries || []) {
    if (!e?.url) continue;
    if (!map.has(e.url)) map.set(e.url, e);
  }
  return [...map.values()];
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  MultiMatchScraper,
  DEFAULT_LINK_PATTERN,
};
