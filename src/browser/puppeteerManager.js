const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { logger } = require('../utils/logger');

const DEFAULT_UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Production Ubuntu / snap Chromium (AWS EC2). */
const LINUX_CHROMIUM_DEFAULT = '/snap/bin/chromium';

/** Block heavy assets — huge RAM win on live-stream sites. Keep XHR/fetch/script for m3u8. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'texttrack', 'manifest']);

function isWindowsPath(p) {
  const s = String(p || '');
  return /^[a-zA-Z]:[\\/]/.test(s) || s.includes('\\');
}

function lowMemoryMode() {
  // Default ON for production 1GB hosts; set LOW_MEMORY_MODE=false to disable.
  if (process.env.LOW_MEMORY_MODE === 'false') return false;
  if (process.env.LOW_MEMORY_MODE === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolve a system Chrome/Chromium binary for puppeteer-core.
 * puppeteer-core does NOT download a browser — executablePath is required.
 */
function resolveChromePath() {
  const envCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
  ].filter((p) => p && String(p).trim());

  for (const candidate of envCandidates) {
    const p = String(candidate).trim();

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
  } else {
    // Prefer apt chromium over snap when both exist (lighter on 1GB).
    const linuxCandidates = [
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      LINUX_CHROMIUM_DEFAULT,
    ];
    for (const p of linuxCandidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // continue
      }
    }
  }

  return undefined;
}

function buildChromeArgs(lowMem) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,TranslateUI',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-blink-features=AutomationControlled',
  ];

  if (lowMem) {
    // Aggressive 1GB profile — fewer processes, smaller surface.
    args.push(
      '--no-zygote',
      '--single-process',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=64',
      '--window-size=800,600'
    );
  } else {
    args.push('--window-size=1280,720');
  }

  return args;
}

class PuppeteerManager {
  constructor(options = {}) {
    this.lowMemory = options.lowMemory ?? lowMemoryMode();
    this.headless = options.headless ?? process.env.PUPPETEER_HEADLESS !== 'false';
    this.timeout = Number(
      options.timeout ||
        process.env.PUPPETEER_TIMEOUT_MS ||
        (this.lowMemory ? 35000 : 45000)
    );
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.restartEvery = Number(
      options.restartEvery ||
        process.env.BROWSER_RESTART_EVERY_N_PAGES ||
        (this.lowMemory ? 8 : 25)
    );
    this.blockResources =
      options.blockResources ?? process.env.PUPPETEER_BLOCK_RESOURCES !== 'false';
    this.executablePath =
      options.executablePath !== undefined
        ? options.executablePath
        : resolveChromePath();
    this.browser = null;
    this.browserPid = null;
    this.pagesOpened = 0; // lifetime counter (for recycle)
    this.openPages = 0; // currently open pages
    this.launching = null;
    this.closing = null;
  }

  isConnected() {
    return Boolean(this.browser && this.browser.isConnected());
  }

  async launch() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      if (!this.executablePath) {
        const hint =
          process.platform === 'win32'
            ? 'Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH'
            : `Install Chromium (e.g. sudo apt install chromium-browser) or set PUPPETEER_EXECUTABLE_PATH`;
        throw new Error(
          `puppeteer-core requires a system browser executablePath. None found. ${hint}`
        );
      }

      // Kill leftovers before a new launch (orphans from previous OOM/crash).
      await this.killOrphanChromium();

      const viewport = this.lowMemory
        ? { width: 800, height: 600 }
        : { width: 1280, height: 720 };

      logger.info('Launching Puppeteer browser (puppeteer-core)', {
        headless: Boolean(this.headless),
        timeout: this.timeout,
        platform: process.platform,
        executablePath: this.executablePath,
        lowMemory: this.lowMemory,
        blockResources: this.blockResources,
      });

      const launchOpts = {
        executablePath: this.executablePath,
        headless: this.headless ? true : false,
        args: buildChromeArgs(this.lowMemory),
        defaultViewport: viewport,
        ignoreHTTPSErrors: true,
      };

      this.browser = await puppeteer.launch(launchOpts);

      try {
        const proc = this.browser.process();
        this.browserPid = proc && proc.pid ? proc.pid : null;
      } catch {
        this.browserPid = null;
      }

      this.browser.on('disconnected', () => {
        logger.warn('Puppeteer browser disconnected', { pid: this.browserPid });
        const pid = this.browserPid;
        this.browser = null;
        this.browserPid = null;
        this.pagesOpened = 0;
        this.openPages = 0;
        // Best-effort orphan cleanup after unexpected disconnect
        if (pid) this.forceKillPid(pid);
      });

      this.pagesOpened = 0;
      this.openPages = 0;
      return this.browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async restart({ force = false } = {}) {
    if (!force && this.openPages > 0) {
      logger.warn('Skip browser restart — pages still open', {
        openPages: this.openPages,
      });
      return this.browser;
    }
    logger.info('Restarting Puppeteer browser', {
      openPages: this.openPages,
      pagesOpened: this.pagesOpened,
    });
    await this.close();
    return this.launch();
  }

  async ensureBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      return this.launch();
    }
    // Recycle only when idle — never mid-scrape with open pages
    if (this.pagesOpened >= this.restartEvery && this.openPages === 0) {
      return this.restart({ force: true });
    }
    return this.browser;
  }

  async applyPageDefaults(page) {
    await page.setUserAgent(this.userAgent);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8,zh-CN;q=0.7',
    });
    await page.setDefaultNavigationTimeout(this.timeout);
    await page.setDefaultTimeout(this.timeout);
    await page.setCacheEnabled(false);

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    if (this.blockResources) {
      await this.enableResourceBlocking(page);
    }
  }

  async enableResourceBlocking(page) {
    if (page.__resourceBlockingEnabled) return;
    try {
      await page.setRequestInterception(true);
    } catch (err) {
      logger.debug('Request interception failed', { error: err.message });
      return;
    }

    page.on('request', (request) => {
      try {
        const type = request.resourceType();
        const url = request.url();
        // Always allow m3u8 / streaming manifests even if typed as media/other
        if (/\.m3u8(\?|$)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url)) {
          request.continue().catch(() => {});
          return;
        }
        if (BLOCKED_RESOURCE_TYPES.has(type)) {
          request.abort().catch(() => {});
          return;
        }
        request.continue().catch(() => {});
      } catch {
        // ignore
      }
    });

    page.__resourceBlockingEnabled = true;
  }

  async newPage() {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    this.pagesOpened += 1;
    this.openPages += 1;

    page.once('close', () => {
      this.openPages = Math.max(0, this.openPages - 1);
    });

    try {
      await this.applyPageDefaults(page);
    } catch (err) {
      await this.safeClosePage(page);
      throw err;
    }

    return page;
  }

  /**
   * Create a page with network interception for m3u8 capture.
   * Compatible with resource blocking (m3u8 URLs are always allowed).
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
      this.openPages = Math.max(0, this.openPages - 1);
    }
  }

  forceKillPid(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already dead
        }
        // Also try process group if Chromium was launched with its own group
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    } catch (err) {
      logger.debug('forceKillPid failed', { pid, error: err.message });
    }
  }

  /**
   * Kill stray Chromium left after OOM / crash when we believe we own none.
   * Only runs when this manager has no live browser handle.
   */
  async killOrphanChromium() {
    if (this.browser && this.browser.isConnected()) return;
    if (process.platform === 'win32') return;
    if (process.env.PUPPETEER_KILL_ORPHANS === 'false') return;

    try {
      // Narrow patterns — avoid killing unrelated user Chrome sessions when possible
      execSync(
        "pkill -f 'chromium.*(headless|type=renderer|puppeteer)' || true",
        { stdio: 'ignore', timeout: 5000 }
      );
      execSync("pkill -f 'chrome.*(headless|--no-sandbox)' || true", {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // pkill returns non-zero when nothing matched
    }
  }

  async close() {
    if (this.closing) return this.closing;
    if (!this.browser && !this.browserPid) {
      await this.killOrphanChromium();
      return;
    }

    this.closing = (async () => {
      const pid = this.browserPid;
      const browser = this.browser;
      this.browser = null;
      this.browserPid = null;
      this.pagesOpened = 0;
      this.openPages = 0;

      if (browser) {
        try {
          // Close leftover pages first to free renderer RAM faster
          const pages = await browser.pages().catch(() => []);
          await Promise.all(
            (pages || []).map((p) => p.close().catch(() => {}))
          );
        } catch {
          // ignore
        }
        try {
          await browser.close();
        } catch (err) {
          logger.warn('Browser close failed', { error: err.message });
        }
      }

      // Ensure process is gone (OOM / hung Chromium)
      if (pid) {
        await sleep(300);
        try {
          process.kill(pid, 0); // throws if dead
          logger.warn('Chromium still alive after close — SIGKILL', { pid });
          this.forceKillPid(pid);
        } catch {
          // process already dead — good
        }
      }

      await this.killOrphanChromium();
    })();

    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  PuppeteerManager,
  DEFAULT_UA,
  resolveChromePath,
  LINUX_CHROMIUM_DEFAULT,
  lowMemoryMode,
  buildChromeArgs,
};
