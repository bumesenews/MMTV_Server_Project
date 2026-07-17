const { BaseStreamingSource, sleep } = require('./baseStreamingSource');
const { extractStreamsFromPage } = require('./streamExtractor');
const { logger, logEvent, events } = require('../utils/logger');
const { formatDate, nowYangon } = require('../utils/time');

/**
 * Source B — https://socoliveku.cc/
 * Independent scraper module.
 */
class SocoliveSource extends BaseStreamingSource {
  constructor(deps) {
    super({ name: 'socolive', ...deps });
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
      logEvent(events.SCRAPER_START, 'Socolive discover start', { source: this.name });
      const page = await this.browser.newPage();
      const discovered = [];

      try {
        for (const url of this.scheduleUrls()) {
          try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: this.browser.timeout });
            await sleep(3000);
            const cards = await this.extractCardsFromPage(page, url);
            discovered.push(...cards);
          } catch (err) {
            logger.warn('Socolive page failed', { url, error: err.message });
          }
        }

        const unique = dedupeByMatchId(discovered);
        logEvent(events.SCRAPER_SUCCESS, 'Socolive discover success', {
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

    // Socolive often nests team names differently — also try data attributes.
    for (const node of nodes) {
      try {
        const attrHome = await node.evaluate(
          (el) =>
            el.getAttribute('data-home') ||
            el.getAttribute('data-home-name') ||
            el.querySelector('[data-home]')?.getAttribute('data-home') ||
            ''
        );
        const attrAway = await node.evaluate(
          (el) =>
            el.getAttribute('data-away') ||
            el.getAttribute('data-away-name') ||
            el.querySelector('[data-away]')?.getAttribute('data-away') ||
            ''
        );

        const league = await this.textOf(node, this.selectors.league);
        let homeTeam = (await this.textOf(node, this.selectors.homeTeam)) || attrHome;
        let awayTeam = (await this.textOf(node, this.selectors.awayTeam)) || attrAway;
        const time = await this.textOf(node, this.selectors.time);
        const href = await this.hrefOf(node, this.selectors.matchLink);
        const matchUrl = this.absoluteUrl(href, pageUrl);

        if (!homeTeam || !awayTeam) {
          const text = await node.evaluate((el) =>
            (el.innerText || '').replace(/\s+/g, ' ').trim()
          );
          const guessed = guessTeamsFromText(text);
          homeTeam = homeTeam || guessed.home;
          awayTeam = awayTeam || guessed.away;
        }

        const cardText = await node.evaluate((el) => (el.innerText || '').trim());
        let date = today;
        if (/tomorrow|ng[aà]y mai/i.test(cardText)) date = tomorrow;

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
        logger.debug('Socolive card parse failed', { error: err.message });
      }
    }

    return out;
  }

  async extractStreams(matchPageUrl) {
    return this.withRetries(async () => {
      logEvent(events.SCRAPER_START, 'Socolive stream extract start', {
        source: this.name,
        url: matchPageUrl,
      });

      const page = await this.browser.newInterceptPage(this.getM3u8Patterns());
      try {
        await page.goto(matchPageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.browser.timeout,
        });

        // Socolive players sometimes need an extra settle after SPA route
        await sleep(1500);

        const streams = await extractStreamsFromPage({
          page,
          sourceName: this.name,
          config: this.config,
          matchPageUrl,
          browserManager: this.browser,
        });

        logEvent(events.SCRAPER_SUCCESS, 'Socolive stream extract success', {
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

module.exports = { SocoliveSource };
