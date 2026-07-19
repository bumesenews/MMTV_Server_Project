const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const { logger } = require('../utils/logger');

const DEFAULT_UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isWindowsPath(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || s.includes('\\');
}

/**
 * Resolve a Chrome/Chromium binary when explicitly configured or on Windows.
 * On Linux: return undefined so Puppeteer uses its bundled Chromium
 * (unless PUPPETEER_EXECUTABLE_PATH / CHROME_PATH / GOOGLE_CHROME_BIN points to a real file).
 */
function resolveChromePath() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
  ].filter((p) => p && String(p).trim());

  for (const candidate of envCandidates) {
    const p = String(candidate).trim();

    // Common mistake: copying a Windows .env onto Ubuntu
    if (process.platform !== 'win32' && isWindowsPath(p)) {
      logger.warn('Ignoring Windows Chrome path on non-Windows host', {
        path: p,
        platform: process.platform,
      });
      continue;
    }

    try {
      if (fs.existsSync(p)) return p;
      logger.warn('Configured Chrome path not found — ignoring', { path: p });
    } catch {
      // continue
    }
  }

  // Windows fallback: system Chrome installs only
  if (process.platform === 'win32') {
    const winCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of winCandidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // continue
      }
    }
  }

  // Linux / macOS / no valid env path → let Puppeteer use bundled Chromium
  return undefined;
}

class PuppeteerManager {
  constructor(options = {}) {
    this.headless = options.headless ?? process.env.PUPPETEER_HEADLESS !== 'false';
    this.timeout = Number(options.timeout || process.env.PUPPETEER_TIMEOUT_MS || 45000);
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.restartEvery = Number(
      options.restartEvery || process.env.BROWSER_RESTART_EVERY_N_PAGES || 25
    );
    this.executablePath =
      options.executablePath !== undefined
        ? options.executablePath
        : resolveChromePath();
    this.browser = null;
    this.pagesOpened = 0;
    this.launching = null;
  }

  async launch() {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      logger.info('Launching Puppeteer browser', {
        headless: Boolean(this.headless),
        timeout: this.timeout,
        platform: process.platform,
        executablePath: this.executablePath || 'puppeteer-bundled',
      });

      const launchOpts = {
        headless: this.headless ? true : false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1366,768',
        ],
        defaultViewport: { width: 1366, height: 768 },
      };

      // Only set executablePath when we resolved a real binary
      if (this.executablePath) {
        launchOpts.executablePath = this.executablePath;
      }

      this.browser = await puppeteer.launch(launchOpts);

      this.browser.on('disconnected', () => {
        logger.warn('Puppeteer browser disconnected');
        this.browser = null;
        this.pagesOpened = 0;
      });

      this.pagesOpened = 0;
      return this.browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async restart() {
    logger.info('Restarting Puppeteer browser');
    await this.close();
    return this.launch();
  }

  async ensureBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      return this.launch();
    }
    if (this.pagesOpened >= this.restartEvery) {
      return this.restart();
    }
    return this.browser;
  }

  async newPage() {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    this.pagesOpened += 1;

    await page.setUserAgent(this.userAgent);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8,zh-CN;q=0.7',
    });
    await page.setDefaultNavigationTimeout(this.timeout);
    await page.setDefaultTimeout(this.timeout);

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return page;
  }

  /**
   * Create a page with network interception for m3u8 capture.
   */
  async newInterceptPage(m3u8Patterns = [/\.m3u8/i]) {
    const page = await this.newPage();
    const captured = [];

    const patterns = m3u8Patterns.map((p) =>
      p instanceof RegExp ? p : new RegExp(String(p), 'i')
    );

    const onRequest = (request) => {
      const url = request.url();
      if (patterns.some((re) => re.test(url))) {
        captured.push({
          url,
          type: 'm3u8',
          method: request.method(),
          headers: request.headers(),
          resourceType: request.resourceType(),
          at: new Date().toISOString(),
        });
      }
    };

    const onResponse = async (response) => {
      try {
        const url = response.url();
        if (!patterns.some((re) => re.test(url))) return;
        const headers = response.headers();
        captured.push({
          url,
          type: 'm3u8',
          status: response.status(),
          headers: {
            'User-Agent': this.userAgent,
            Referer: page.url(),
            ...(headers['set-cookie'] ? { Cookie: headers['set-cookie'] } : {}),
          },
          contentType: headers['content-type'] || '',
          at: new Date().toISOString(),
        });
      } catch {
        // ignore response parse errors
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    page.__streamCapture = {
      captured,
      patterns,
      cleanup: () => {
        try {
          page.off('request', onRequest);
          page.off('response', onResponse);
        } catch {
          // page may already be closed
        }
      },
      getUniqueStreams() {
        const seen = new Set();
        const out = [];
        for (const item of captured) {
          const key = String(item.url || '').split('?')[0].toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
        return out;
      },
    };

    return page;
  }

  async safeClosePage(page) {
    if (!page) return;
    try {
      if (page.__streamCapture?.cleanup) page.__streamCapture.cleanup();
    } catch {
      // ignore
    }
    try {
      if (!page.isClosed()) await page.close();
    } catch (err) {
      logger.debug('Page close failed', { error: err.message });
    }
  }

  async close() {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch (err) {
      logger.warn('Browser close failed', { error: err.message });
    } finally {
      this.browser = null;
      this.pagesOpened = 0;
    }
  }
}

module.exports = { PuppeteerManager, DEFAULT_UA, resolveChromePath };
