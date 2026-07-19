const { BaseStreamingSource, sleep } = require('./baseStreamingSource');
const { extractStreamsFromPage } = require('./streamExtractor');
const { logger, logEvent, events } = require('../utils/logger');
const { formatDate, nowYangon } = require('../utils/time');

/**
 * Config-driven Puppeteer streaming source.
 * Uses sources.json domains/paths/selectors/attrs/streamDetection/playerRules.
 * Site-specific parsers can extend this when discovery quirks differ.
 */
class GenericStreamingSource extends BaseStreamingSource {
  constructor(deps = {}) {
    const name = deps.name || deps.config?.name || 'streaming';
    super({ ...deps, name });
  }

  get attrs() {
    return this.config.attrs || {};
  }

  get discoverOptions() {
    return this.config.discover || {};
  }

  scheduleUrls() {
    const paths = this.config.paths || {};
    const urls = [];
    for (const domain of this.domains) {
      urls.push(new URL(paths.home || '/', domain).toString());
      if (paths.schedule) {
        urls.push(new URL(paths.schedule, domain).toString());
      }
    }
    return [...new Set(urls)];
  }

  async discoverMatches() {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, `${this.name} discover start`, { source: this.name });
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

            const cards = await this.extractCardsFromPage(page, url);
            discovered.push(...cards);
          } catch (err) {
            logger.warn(`${this.name} page failed`, { url, error: err.message });
          }
        }

        const unique = dedupeByMatchId(discovered);
        logEvent(events.SCRAPER_SUCCESS, `${this.name} discover success`, {
          source: this.name,
          count: unique.length,
        });
        return unique;
      } finally {
        await this.browser.safeClosePage(page);
      }
    }, 'discoverMatches');
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

  async extractStreams(matchPageUrl) {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, `${this.name} stream extract start`, {
        source: this.name,
        url: matchPageUrl,
      });

      const page = await this.browser.newInterceptPage(this.getM3u8Patterns());
      try {
        await page.goto(matchPageUrl, {
          waitUntil: this.discoverOptions.waitUntil || 'domcontentloaded',
          timeout: this.browser.timeout,
        });

        const streams = await extractStreamsFromPage({
          page,
          sourceName: this.name,
          config: this.config,
          matchPageUrl,
          browserManager: this.browser,
        });

        logEvent(events.SCRAPER_SUCCESS, `${this.name} stream extract success`, {
          source: this.name,
          count: streams.length,
        });
        return streams;
      } finally {
        await this.browser.safeClosePage(page);
      }
    }, 'extractStreams');
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
