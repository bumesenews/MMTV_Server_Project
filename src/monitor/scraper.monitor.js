const { getTelegramService } = require('../services/telegram.service');

function isTimeoutError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /timeout/i.test(msg) ||
    (/exceeded/i.test(msg) && /time/i.test(msg))
  );
}

/**
 * Scraper failure / timeout / all-sources-failed helpers.
 * Pipeline records per-cycle results then evaluates "all failed".
 */
class ScraperMonitor {
  constructor({ telegram, env = process.env } = {}) {
    this.telegram = telegram || getTelegramService(env);
    this.env = env;
    this.defaultTimeoutSec = Number(
      env.PUPPETEER_TIMEOUT_MS || env.HTTP_STREAM_TIMEOUT_MS || 30000
    ) / 1000;
    /** @type {Map<string, { ok: boolean, error?: string, url?: string }>} */
    this.cycle = new Map();
  }

  beginCycle() {
    this.cycle = new Map();
  }

  recordSourceResult(source, { ok, error, url } = {}) {
    if (!source) return;
    this.cycle.set(String(source), {
      ok: Boolean(ok),
      error: error ? String(error.message || error) : undefined,
      url: url || undefined,
    });
  }

  async notifySourceFailed(source, error, { url } = {}) {
    this.recordSourceResult(source, { ok: false, error, url });

    if (isTimeoutError(error)) {
      await this.telegram.websiteTimeout({
        website: url || source,
        timeoutSec: Math.round(this.defaultTimeoutSec) || 30,
      });
    }

    await this.telegram.scraperFailed(source, error);
  }

  async notifyTimeout(website, error) {
    await this.telegram.websiteTimeout({
      website,
      timeoutSec: Math.round(this.defaultTimeoutSec) || 30,
    });
    if (error) {
      await this.telegram.scraperFailed(website, error);
    }
  }

  /**
   * Call at end of pipeline scrape cycle.
   * @param {string[]} [enabledSources] - if provided, only these names count
   */
  async evaluateCycle({ enabledSources } = {}) {
    const names =
      Array.isArray(enabledSources) && enabledSources.length
        ? enabledSources
        : [...this.cycle.keys()];

    if (!names.length) return { allFailed: false };

    const failed = [];
    let anyOk = false;
    for (const name of names) {
      const row = this.cycle.get(name);
      if (!row) {
        // Not attempted this cycle — ignore for "all failed"
        continue;
      }
      if (row.ok) anyOk = true;
      else failed.push(name);
    }

    const attempted = names.filter((n) => this.cycle.has(n));
    if (attempted.length >= 2 && failed.length === attempted.length && !anyOk) {
      await this.telegram.allSourcesFailed({
        sources: failed,
        error: failed.map((n) => `${n}: ${this.cycle.get(n)?.error || 'failed'}`).join('; '),
      });
      return { allFailed: true, failed };
    }

    return { allFailed: false, failed };
  }
}

let sharedScraperMonitor = null;

function getScraperMonitor(opts) {
  if (!sharedScraperMonitor) sharedScraperMonitor = new ScraperMonitor(opts);
  return sharedScraperMonitor;
}

module.exports = {
  ScraperMonitor,
  getScraperMonitor,
  isTimeoutError,
};
