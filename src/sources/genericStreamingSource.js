const { BaseStreamingSource, sleep } = require('./baseStreamingSource');
const { extractStreamsAxiosThenPuppeteer } = require('./httpStreamExtractor');
const { MultiMatchScraper } = require('../services/multiMatchScraper');
const { logger, logEvent, events } = require('../utils/logger');
const { formatDate, nowYangon } = require('../utils/time');

/**
 * Config-driven streaming source.
 * List discovery: Axios once → extract truc-tiep URLs → match FotMob fixtures;
 * Puppeteer fallback for Cloudflare/empty HTML (memory-optimized browser).
 * Stream URLs: axios HTML first, puppeteer-core fallback.
 */
class GenericStreamingSource extends BaseStreamingSource {
  constructor(deps = {}) {
    const name = deps.name || deps.config?.name || 'streaming';
    super({ ...deps, name });
    this.multiMatch = new MultiMatchScraper({
      browser: this.browser,
      sourceName: name,
      linkPattern: /truc-tiep\/[^\s"'<>#?]+/gi,
      normalizer: this.normalizer,
    });
  }

  get attrs() {
    return this.config.attrs || {};
  }

  get discoverOptions() {
    return this.config.discover || {};
  }

  /**
   * Efficient path for 15–20 FotMob fixtures: one list fetch, URL extract, 3-layer match.
   */
  async discoverMatchesForFixtures(fixtures = []) {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, `${this.name} multi-match discover start`, {
        source: this.name,
        fixtures: (fixtures || []).length,
      });
      return this.multiMatch.discoverForFixtures({
        listUrls: this.scheduleUrls(),
        fixtures,
        config: this.config,
      });
    }, 'discoverMatchesForFixtures');
  }

  async discoverMatches() {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, `${this.name} discover start`, { source: this.name });

      // Axios-first list fetch (same multi-match extractor, no FotMob filter)
      try {
        const entries = await this.multiMatch.fetchListEntriesAxios(
          this.scheduleUrls(),
          this.config
        );
        if (entries.length) {
          const cards = entries
            .map((e) => this._entryToDiscoveredCard(e))
            .filter(Boolean);
          const unique = dedupeByMatchId(cards);
          logEvent(events.SCRAPER_SUCCESS, `${this.name} discover success (axios)`, {
            source: this.name,
            count: unique.length,
            method: 'axios',
          });
          return unique;
        }
        logger.info(`${this.name} axios list empty — Puppeteer fallback`, {
          source: this.name,
        });
      } catch (err) {
        logger.warn(`${this.name} axios list failed — Puppeteer fallback`, {
          source: this.name,
          error: err.message,
        });
      }

      const page = await this.browser.newPage();
      const discovered = [];
      const opts = this.discoverOptions;
      const waitUntil = opts.waitUntil || 'domcontentloaded';
      const waitMs = Number(opts.waitMs || 2500);

      try {
        for (const url of this.scheduleUrls()) {
          try {
            await page.goto(url, {
              waitUntil,
              timeout: this.browser.timeout,
            });
            await sleep(waitMs);

            if (opts.scroll) {
              const scrollY = Number(opts.scrollY || 1200);
              await page.evaluate((y) => window.scrollBy(0, y), scrollY);
              await sleep(Number(opts.scrollWaitMs || 1000));
            }

            const html = await page.content();
            const entries = this.multiMatch.extractMatchEntries(
              html,
              url,
              this.config
            );
            if (entries.length) {
              discovered.push(
                ...entries.map((e) => this._entryToDiscoveredCard(e)).filter(Boolean)
              );
            } else {
              const cards = await this.extractCardsFromPage(page, url);
              discovered.push(...cards);
            }
          } catch (err) {
            logger.warn(`${this.name} page failed`, { url, error: err.message });
          }
        }

        const unique = dedupeByMatchId(discovered);
        logEvent(events.SCRAPER_SUCCESS, `${this.name} discover success (puppeteer)`, {
          source: this.name,
          count: unique.length,
          method: 'puppeteer',
        });
        return unique;
      } finally {
        await this.browser.safeClosePage(page);
      }
    }, 'discoverMatches');
  }

  _entryToDiscoveredCard(entry) {
    if (!entry?.url || !entry.ok || !entry.league) return null;
    return this.buildMatchFromCard({
      league: entry.league,
      homeTeam: entry.homeTeam,
      awayTeam: entry.awayTeam,
      date: entry.date,
      time: entry.time,
      matchUrl: entry.url,
      raw: {
        league: entry.league,
        homeTeam: entry.homeTeam,
        awayTeam: entry.awayTeam,
      },
    });
  }

  async extractCardsFromPage(page, pageUrl) {
    const { nodes } = await this.queryAll(page, this.selectors.matchCard);
    const out = [];
    const today = formatDate(nowYangon());
    const tomorrow = formatDate(nowYangon().plus({ days: 1 }));
    const hrefAttrs = asList(this.attrs.href || ['href', 'data-href', 'data-url']);

    for (const node of nodes) {
      try {
        const league = await this.textOf(node, this.selectors.league);
        let homeTeam = await this.textOf(node, this.selectors.homeTeam);
        let awayTeam = await this.textOf(node, this.selectors.awayTeam);
        const time = await this.textOf(node, this.selectors.time);
        let href = await this.hrefOf(node, this.selectors.matchLink);
        if (!href) href = await this.attrOf(node, hrefAttrs);
        const matchUrl = this.absoluteUrl(href, pageUrl);

        if (!homeTeam || !awayTeam) {
          const alts = await node.evaluate((el) =>
            [...el.querySelectorAll('img[alt]')]
              .map((img) => (img.getAttribute('alt') || '').trim())
              .filter(Boolean)
          );
          if (alts.length >= 2) {
            homeTeam = homeTeam || alts[0];
            awayTeam = awayTeam || alts[1];
          } else {
            const text = await node.evaluate((el) =>
              (el.innerText || '').replace(/\s+/g, ' ').trim()
            );
            const guessed = guessTeamsFromText(text);
            homeTeam = homeTeam || guessed.home;
            awayTeam = awayTeam || guessed.away;
          }
        }

        const cardText = await node.evaluate((el) => (el.innerText || '').trim());
        let date = today;
        if (/tomorrow|ng[aà]y mai|ngày mai|翌日/i.test(cardText)) date = tomorrow;

        const match = this.buildMatchFromCard({
          league,
          homeTeam,
          awayTeam,
          date,
          time,
          matchUrl,
          raw: { league, homeTeam, awayTeam },
        });
        if (match) out.push(match);
      } catch (err) {
        logger.debug(`${this.name} card parse failed`, { error: err.message });
      }
    }

    return out;
  }

  async attrOf(elementHandle, attrList) {
    const list = asList(attrList);
    for (const attr of list) {
      try {
        const value = await elementHandle.evaluate(
          (node, name) =>
            node.getAttribute(name) ||
            node.closest?.('a')?.getAttribute(name) ||
            '',
          attr
        );
        if (value) return value;
      } catch {
        // try next
      }
    }
    return '';
  }

  async extractStreams(matchPageUrl, options = {}) {
    return this.withRetries(
      async () =>
        extractStreamsAxiosThenPuppeteer({
          matchPageUrl,
          sourceName: this.name,
          config: this.config,
          browser: this.browser,
          waitUntil: this.config.streamDetection?.waitUntil || 'domcontentloaded',
          getM3u8Patterns: () => this.getM3u8Patterns(),
          validateStreams: options.validateStreams,
          shouldAbort: options.shouldAbort,
        }),
      'extractStreams'
    );
  }
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function guessTeamsFromText(text) {
  const vs = text.split(/\bvs\.?\b|[-–—]|v\.s\./i);
  if (vs.length >= 2) {
    return {
      home: vs[0].split('\n').pop().trim(),
      away: vs[1].split('\n')[0].trim(),
    };
  }
  return { home: '', away: '' };
}

function dedupeByMatchId(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.matchId)) map.set(item.matchId, item);
  }
  return [...map.values()];
}

module.exports = { GenericStreamingSource };
