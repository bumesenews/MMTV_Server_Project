const { BaseStreamingSource, sleep } = require('./baseStreamingSource');
const { extractStreamsFromPage } = require('./streamExtractor');
const { logger, logEvent, events } = require('../utils/logger');
const { formatDate, nowYangon } = require('../utils/time');

/**
 * Source C — https://xoilacxyy.io/
 * Independent scraper module.
 */
class XoilacSource extends BaseStreamingSource {
  constructor(deps) {
    super({ name: 'xoilac', ...deps });
  }

  scheduleUrls() {
    const paths = this.config.paths || {};
    const urls = [];
    for (const domain of this.domains) {
      urls.push(new URL(paths.home || '/', domain).toString());
      if (paths.schedule) urls.push(new URL(paths.schedule, domain).toString());
    }
    return [...new Set(urls)];
  }

  async discoverMatches() {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, 'Xoilac discover start', { source: this.name });
      const page = await this.browser.newPage();
      const discovered = [];

      try {
        for (const url of this.scheduleUrls()) {
          try {
            await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: this.browser.timeout,
            });
            await sleep(2800);

            // Xoilac may lazy-load schedule — scroll once
            await page.evaluate(() => window.scrollBy(0, 1200));
            await sleep(1000);

            const cards = await this.extractCardsFromPage(page, url);
            discovered.push(...cards);
          } catch (err) {
            logger.warn('Xoilac page failed', { url, error: err.message });
          }
        }

        const unique = dedupeByMatchId(discovered);
        logEvent(events.SCRAPER_SUCCESS, 'Xoilac discover success', {
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

    for (const node of nodes) {
      try {
        const league = await this.textOf(node, this.selectors.league);
        let homeTeam = await this.textOf(node, this.selectors.homeTeam);
        let awayTeam = await this.textOf(node, this.selectors.awayTeam);
        const time = await this.textOf(node, this.selectors.time);
        const href = await this.hrefOf(node, this.selectors.matchLink);
        const matchUrl = this.absoluteUrl(href, pageUrl);

        if (!homeTeam || !awayTeam) {
          // Xoilac sometimes puts both teams in one node with logos/alt text
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
        if (/tomorrow|ng[aà]y mai|ngày mai/i.test(cardText)) date = tomorrow;

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
        logger.debug('Xoilac card parse failed', { error: err.message });
      }
    }

    return out;
  }

  async extractStreams(matchPageUrl) {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, 'Xoilac stream extract start', {
        source: this.name,
        url: matchPageUrl,
      });

      const page = await this.browser.newInterceptPage(this.getM3u8Patterns());
      try {
        await page.goto(matchPageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.browser.timeout,
        });

        const streams = await extractStreamsFromPage({
          page,
          sourceName: this.name,
          config: this.config,
          matchPageUrl,
          browserManager: this.browser,
        });

        logEvent(events.SCRAPER_SUCCESS, 'Xoilac stream extract success', {
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

module.exports = { XoilacSource };
