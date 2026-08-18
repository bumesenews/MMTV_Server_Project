const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { axiosGetHtml } = require('../sources/httpStreamExtractor');
const { sleep } = require('../sources/baseStreamingSource');
const { runExclusivePuppeteerTask } = require('../browser/puppeteerManager');
const {
  parseStreamUrl,
  scoreStreamMatch,
  MATCH_URL_STATUS,
} = require('../utils/streamUrlHelper');
const {
  STREAM_FIND_LEAD_MIN,
  isTodayOrTomorrow,
  toYangon,
  MATCH_TIME_TOLERANCE_MIN,
  resolveAnyMatchUrlSlot,
} = require('../utils/time');
const { cleanText } = require('../utils/normalize');
const { needsMatchUrlDiscovery } = require('../utils/matchUrlDiscovery');

/** Default match-detail path pattern (Vietnamese live sites). */
const DEFAULT_LINK_PATTERN = /truc-tiep\/[^\s"'<>#?]+/gi;

const CLOUDFLARE_MARKERS =
  /cloudflare|cf-browser-verification|attention required|just a moment|enable javascript and cookies|access denied|sorry, you have been blocked/i;

/**
 * Efficient multi-match discovery for 15–20 FotMob fixtures:
 * 1) One Axios GET of the live list HTML
 * 2) Extract all `truc-tiep/...` detail URLs
 * 3) Match only fixtures in Match URL slots (−60/−45/−30) via scoreStreamMatch
 * 4) Puppeteer fallback (memory-optimized browser) if Axios/Cloudflare/empty
 */
class MultiMatchScraper {
  constructor({
    browser = null,
    sourceName = 'streaming',
    linkPattern = DEFAULT_LINK_PATTERN,
    windowLeadMinutes = STREAM_FIND_LEAD_MIN,
    timeToleranceMinutes = MATCH_TIME_TOLERANCE_MIN,
    requireLeague = false,
    normalizer = null,
  } = {}) {
    this.browser = browser;
    this.sourceName = sourceName;
    this.linkPattern = linkPattern;
    this.windowLeadMinutes = windowLeadMinutes;
    this.timeToleranceMinutes = timeToleranceMinutes;
    this.requireLeague = requireLeague;
    this.normalizer = normalizer;
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
      logger.debug(`${this.sourceName} multi-match: no fixtures in Match URL window`);
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
        throw err;
      }
      method = 'puppeteer';
      entries = await this.fetchListEntriesPuppeteer(urls, config);
      if (!entries.length) {
        throw new Error(`${err.message}; puppeteer_empty`);
      }
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
   * Match URL discovery window: Today-page slots −60 / −45 / −30 only.
   */
  isFixtureDue(fixture) {
    if (!fixture?.kickoff) return false;
    const kickoff = toYangon(fixture.kickoff);
    if (!kickoff || !isTodayOrTomorrow(kickoff)) return false;
    if (!resolveAnyMatchUrlSlot(fixture.kickoff)) return false;
    const sources = fixture?.matchUrlSearch?.sources || {};
    const names = Object.keys(sources);
    if (!names.length) return true;
    return names.some((name) => needsMatchUrlDiscovery(fixture, name));
  }

  async fetchListEntriesAxios(listUrls, config) {
    const all = [];
    let lastError = null;
    for (const listUrl of listUrls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const siteOrigin = (config.domains && config.domains[0]) || listUrl;
        const html = unwrapListPayload(
          await axiosGetHtml(listUrl, { referer: siteOrigin }),
          siteOrigin
        );
        if (this.looksBlockedOrEmpty(html)) {
          logger.warn(`${this.sourceName} list page empty or blocked — skip`, {
            url: listUrl,
          });
          lastError = lastError || new Error('antibot_or_empty_html');
          continue;
        }
        all.push(...this.extractMatchEntries(html, siteOrigin, config));
      } catch (err) {
        lastError = err;
        logger.warn(`${this.sourceName} list Axios page failed — skip`, {
          url: listUrl,
          error: err.message,
        });
      }
    }
    if (!all.length) {
      throw lastError || new Error('empty_match_links');
    }
    return dedupeEntries(all);
  }

  async fetchListEntriesPuppeteer(listUrls, config) {
    if (!this.browser) return [];

    return runExclusivePuppeteerTask(async () => {
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
          const siteOrigin = (config.domains && config.domains[0]) || listUrl;
          const html = unwrapListPayload(await page.content(), siteOrigin);
          if (this.looksBlockedOrEmpty(html)) {
            logger.warn(`${this.sourceName} Puppeteer list still blocked/empty`, {
              url: listUrl,
            });
            continue;
          }
          all.push(...this.extractMatchEntries(html, siteOrigin, config));
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
    });
  }

  looksBlockedOrEmpty(html) {
    const text = String(html || '').trim();
    if (text.length < 400) return true;
    const hasMatchLinks = /truc-tiep\//i.test(text);
    // Real list pages often mention Cloudflare in scripts — do not discard
    // a large HTML document that already has match links.
    if (hasMatchLinks && text.length > 5000) return false;
    if (CLOUDFLARE_MARKERS.test(text)) return true;
    if (!hasMatchLinks) return true;
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
          $el.attr('data-href') ||
          $el.attr('data-url') ||
          $el.attr('data-link') ||
          $el.find('a[href*="truc-tiep"]').attr('href') ||
          $el.find('[data-href*="truc-tiep"]').attr('data-href') ||
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

    $('[data-href*="truc-tiep"], [data-url*="truc-tiep"], [data-link*="truc-tiep"]').each(
      (_, el) => {
        const $el = $(el);
        consider(
          $el.attr('data-href') || $el.attr('data-url') || $el.attr('data-link'),
          $el.parent()
        );
      }
    );

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
   * Map FotMob fixtures → stream list entries.
   * Identity: home + away + date + kickoff. Both teams required.
   * Ambiguous (two close scores, or one URL claimed by two fixtures) → reject.
   */
  matchFixturesToEntries(fixtures, entries) {
    const scoredRows = [];

    for (const fixture of fixtures || []) {
      const byUrl = new Map();
      for (const entry of entries || []) {
        if (!entry?.url) continue;
        const streamData = {
          ...entry,
          url: entry.url,
          slug: entry.slug,
          league: entry.league,
          country: entry.country || entry.ccode,
          utcTimestamp: entry.utcTimestamp,
          utcDate: entry.utcDate,
          utcIso: entry.utcIso,
          yangonDate: entry.yangonDate,
          homeTeam: entry.homeTeam,
          awayTeam: entry.awayTeam,
        };
        const scored = scoreStreamMatch(fixture, streamData, {
          normalizer: this.normalizer,
          timeToleranceMinutes: this.timeToleranceMinutes,
        });
        if (!scored.accepted) continue;
        const prev = byUrl.get(entry.url);
        if (!prev || scored.score > prev.scored.score) {
          byUrl.set(entry.url, { entry, scored });
        }
      }
      const candidates = [...byUrl.values()];

      candidates.sort((a, b) => b.scored.score - a.scored.score);
      if (!candidates.length) continue;
      if (
        candidates.length > 1 &&
        candidates[0].scored.score - candidates[1].scored.score < 5
      ) {
        logger.info(`${this.sourceName} ambiguous Match URL — skipped`, {
          matchId: fixture.matchId,
          candidates: candidates.slice(0, 3).map((c) => c.entry.url),
        });
        continue;
      }

      scoredRows.push({ fixture, hit: candidates[0] });
    }

    const byUrl = new Map();
    for (const row of scoredRows) {
      const url = row.hit.entry.url;
      const prev = byUrl.get(url);
      if (!prev) {
        byUrl.set(url, row);
        continue;
      }
      if (row.hit.scored.score > prev.hit.scored.score) {
        byUrl.set(url, row);
      } else if (row.hit.scored.score === prev.hit.scored.score) {
        byUrl.set(url, null);
      }
    }

    const out = [];
    const usedFixtures = new Set();
    for (const row of byUrl.values()) {
      if (!row) continue;
      const { fixture, hit } = row;
      if (usedFixtures.has(fixture.matchId)) continue;
      usedFixtures.add(fixture.matchId);

      const status =
        hit.scored.status === MATCH_URL_STATUS.CONFIRMED
          ? MATCH_URL_STATUS.CONFIRMED
          : MATCH_URL_STATUS.FOUND;

      out.push({
        matchId: fixture.matchId,
        league: fixture.league,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        date: fixture.date,
        time: fixture.time,
        kickoff: fixture.kickoff,
        matchUrl: hit.entry.url,
        source: this.sourceName,
        matchUrlStatus: status,
        confidence: hit.scored.score,
        accepted: true,
        originalNames: {
          ...(fixture.originalNames || {}),
          [this.sourceName]: {
            league: hit.entry.league || fixture.league,
            homeTeam: hit.entry.homeTeam || fixture.homeTeam,
            awayTeam: hit.entry.awayTeam || fixture.awayTeam,
            url: hit.entry.url,
          },
        },
      });
    }

    return out;
  }
}

/**
 * List APIs:
 * - Cakhia / Xoilac / Socolive: { success, data: { htmls: [...] } }
 * - ColaTV gvapi: { code, data: { "slug-id": { homeTeamName, ... } } }
 */
function unwrapListPayload(raw, siteOrigin = '') {
  const text = String(raw || '');
  const trimmed = text.trim();
  let jsonText = '';
  if (trimmed.startsWith('{')) {
    jsonText = trimmed;
  } else {
    const start = Math.max(trimmed.indexOf('{"success"'), trimmed.indexOf('{"code"'));
    if (start >= 0) {
      const end = trimmed.lastIndexOf('}');
      if (end > start) jsonText = trimmed.slice(start, end + 1);
    }
  }
  if (!jsonText) return text;
  try {
    const json = JSON.parse(jsonText);
    const htmls = json?.data?.htmls;
    if (Array.isArray(htmls) && htmls.length) {
      return htmls.filter(Boolean).join('\n');
    }
    const colaHtml = colaMatchesToHtml(json, siteOrigin);
    if (colaHtml) return colaHtml;
  } catch {
    // not a list JSON payload
  }
  return text;
}

function colaMatchesToHtml(json, siteOrigin) {
  const data = json?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.htmls) return '';
  const keys = Object.keys(data).filter((k) => /vs-.*-luc-.*-ngay-/i.test(k));
  if (!keys.length) return '';
  const origin = String(siteOrigin || '').replace(/\/$/, '');
  return keys
    .map((key) => {
      const m = data[key] || {};
      const href = origin ? `${origin}/truc-tiep/${key}/` : `/truc-tiep/${key}/`;
      const home = m.homeTeamName || m.home_team || '';
      const away = m.awayTeamName || m.away_team || '';
      const league = m.competitionName || m.competition || '';
      return `<a href="${href}" data-home="${home}" data-away="${away}" data-league="${league}">${home} vs ${away}</a>`;
    })
    .join('\n');
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
