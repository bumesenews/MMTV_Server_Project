const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { cleanText } = require('../utils/normalize');
const {
  combineDateAndTime,
  formatDate,
  formatTime,
  isTodayOrTomorrow,
  toYangon,
  nowYangon,
} = require('../utils/time');

/**
 * Shared helpers for streaming sources. Each website still has its own module.
 */
class BaseStreamingSource {
  constructor({ name, config, browserManager, normalizer }) {
    this.name = name;
    this.config = config;
    this.browser = browserManager;
    this.normalizer = normalizer;
    this.maxRetries = Number(process.env.MAX_STREAM_RETRIES || 3);
  }

  get domains() {
    const primary = this.config.domains || [];
    const mirrors = this.config.mirrorDomains || [];
    return [...primary, ...mirrors].filter(Boolean);
  }

  get baseUrl() {
    return this.domains[0] || '';
  }

  get selectors() {
    return this.config.selectors || {};
  }

  get streamDetection() {
    return this.config.streamDetection || {};
  }

  getM3u8Patterns() {
    const patterns = this.streamDetection.m3u8Patterns || ['\\.m3u8'];
    return patterns.map((p) => new RegExp(p, 'i'));
  }

  async withRetries(fn, label = 'task') {
    let lastError;
    const maxRetries = Math.min(
      this.maxRetries,
      process.env.LOW_MEMORY_MODE === 'false' ? this.maxRetries : 2
    );
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        const msg = String(err.message || '');
        const hardCrash =
          /Target closed|Session closed|Browser disconnected|Protocol error|net::ERR/i.test(
            msg
          );
        logEvent(events.SCRAPER_ERROR, `${this.name} ${label} failed`, {
          source: this.name,
          attempt,
          error: err.message,
          hardCrash,
        });
        if (attempt < maxRetries) {
          // Full Chromium relaunch only after hard browser death (saves RAM thrash)
          if (
            hardCrash &&
            this.browser &&
            typeof this.browser.restart === 'function' &&
            (!this.browser.isConnected || !this.browser.isConnected())
          ) {
            try {
              await this.browser.restart({ force: true });
            } catch {
              // ignore
            }
          }
          await sleep(1500 * attempt);
        }
      }
    }
    throw lastError;
  }

  absoluteUrl(href, base = this.baseUrl) {
    if (!href) return null;
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }

  /**
   * Query first matching selector from a fallback list.
   */
  async queryFirst(page, selectorList, root = null) {
    const list = Array.isArray(selectorList) ? selectorList : [selectorList];
    for (const selector of list.filter(Boolean)) {
      try {
        const handle = root
          ? await root.$(selector)
          : await page.$(selector);
        if (handle) return { handle, selector };
      } catch {
        // invalid selector — try next
      }
    }
    return null;
  }

  async queryAll(page, selectorList) {
    const list = Array.isArray(selectorList) ? selectorList : [selectorList];
    for (const selector of list.filter(Boolean)) {
      try {
        const nodes = await page.$$(selector);
        if (nodes && nodes.length) return { nodes, selector };
      } catch {
        // try next
      }
    }
    return { nodes: [], selector: null };
  }

  async textOf(elementHandle, selectorList) {
    if (!elementHandle) return '';
    const list = Array.isArray(selectorList) ? selectorList : [selectorList];
    for (const selector of list.filter(Boolean)) {
      try {
        const el = await elementHandle.$(selector);
        if (!el) continue;
        const text = await el.evaluate((node) => (node.textContent || '').trim());
        if (text) return cleanText(text);
      } catch {
        // continue
      }
    }
    return '';
  }

  async hrefOf(elementHandle, selectorList) {
    const list = Array.isArray(selectorList) ? selectorList : [selectorList];
    for (const selector of list.filter(Boolean)) {
      try {
        const el = await elementHandle.$(selector);
        if (!el) continue;
        const href = await el.evaluate((node) => node.getAttribute('href') || node.href || '');
        if (href) return href;
      } catch {
        // continue
      }
    }
    try {
      const href = await elementHandle.evaluate(
        (node) => node.getAttribute('href') || (node.closest && node.closest('a')?.href) || ''
      );
      return href || '';
    } catch {
      return '';
    }
  }

  buildMatchFromCard({ league, homeTeam, awayTeam, date, time, matchUrl, raw = {} }) {
    const standardLeague = this.normalizer.filterAllowedLeague(league);
    if (!standardLeague) return null;

    const home = this.normalizer.normalizeTeam(homeTeam);
    const away = this.normalizer.normalizeTeam(awayTeam);
    if (!home || !away) return null;

    let kickoff = combineDateAndTime(date, time);
    if (!kickoff && time) {
      // Some sites only show HH:mm for today/tomorrow — assume today first.
      const today = formatDate(nowYangon());
      kickoff = combineDateAndTime(today, time);
      if (kickoff && !isTodayOrTomorrow(kickoff)) {
        const tomorrow = formatDate(nowYangon().plus({ days: 1 }));
        kickoff = combineDateAndTime(tomorrow, time);
      }
    }

    if (!kickoff || !isTodayOrTomorrow(kickoff)) return null;

    const matchId = generateMatchId(home, away, kickoff);

    return {
      matchId,
      league: standardLeague,
      homeTeam: home,
      awayTeam: away,
      date: formatDate(kickoff),
      time: formatTime(kickoff),
      kickoff: kickoff.toISO(),
      matchUrl,
      source: this.name,
      originalNames: {
        [this.name]: {
          league: cleanText(raw.league || league),
          homeTeam: cleanText(raw.homeTeam || homeTeam),
          awayTeam: cleanText(raw.awayTeam || awayTeam),
        },
      },
    };
  }

  matchFixture(discovered, fixture) {
    if (!discovered || !fixture) return false;
    if (discovered.matchId && fixture.matchId) {
      return discovered.matchId === fixture.matchId;
    }
    return (
      discovered.homeTeam === fixture.homeTeam &&
      discovered.awayTeam === fixture.awayTeam &&
      formatDate(discovered.kickoff) === formatDate(fixture.kickoff)
    );
  }

  async discoverMatches() {
    throw new Error(`${this.name}.discoverMatches() not implemented`);
  }

  async extractStreams(matchPageUrl) {
    throw new Error(`${this.name}.extractStreams() not implemented`);
  }

  async findMatchPage(fixture) {
    const discovered = await this.discoverMatches();
    const hit = discovered.find((m) => this.matchFixture(m, fixture));
    if (hit) {
      logger.info(`${this.name} match page found`, {
        matchId: fixture.matchId,
        url: hit.matchUrl,
      });
      return hit.matchUrl;
    }
    logger.debug(`${this.name} no match page for fixture`, {
      matchId: fixture.matchId,
    });
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { BaseStreamingSource, sleep };
