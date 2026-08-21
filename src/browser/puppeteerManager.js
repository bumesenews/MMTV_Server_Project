const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { logger } = require('../utils/logger');

const DEFAULT_UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Last-resort Ubuntu snap wrapper — fails under PM2 ("not a snap cgroup"). */
const LINUX_CHROMIUM_SNAP_WRAPPER = '/snap/bin/chromium';

/** Real Chromium ELF inside the snap (bypasses /snap/bin confinement). */
const LINUX_SNAP_CHROME_ELFS = [
  '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  '/snap/chromium/current/usr/lib/chromium/chrome',
  '/snap/chromium/current/usr/lib/chromium-browser/chromium-browser',
];

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

function fileExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isSnapChromeElf(p) {
  const real = String(realpathOrSelf(p) || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return (
    real.includes('/snap/chromium/') &&
    (real.endsWith('/chrome') || real.endsWith('/chromium') || real.endsWith('/chromium-browser'))
  );
}

/** Shebang scripts (Ubuntu chromium-browser) exec /snap/bin and fail under PM2. */
function isShellWrapper(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  }
}

/**
 * /snap/bin/chromium and apt shims fail from PM2:
 * "session-*.scope is not a snap cgroup for tag snap.chromium.chromium"
 */
function isSnapLauncher(p) {
  if (!p) return false;
  const raw = String(p).replace(/\\/g, '/').toLowerCase();
  const real = String(realpathOrSelf(p) || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (raw.includes('/snap/bin/') || real.includes('/snap/bin/')) return true;
  if (isSnapChromeElf(p)) return false;
  if (real.includes('/snap/')) return true;
  if (process.platform !== 'win32' && isShellWrapper(p)) return true;
  return false;
}

function isTargetClosedError(err) {
  const m = String(err?.message || err || '');
  return /target closed|session closed|createTarget|Target\.createTarget|connection closed/i.test(
    m
  );
}

function isBrowserLaunchError(err) {
  const m = String(err?.message || err || '');
  return (
    /failed to launch the browser process|snap cgroup|not a snap cgroup|launch timeout/i.test(m) ||
    isTargetClosedError(err)
  );
}

/** Alias — older builds called this name and crashed with "is not defined". */
function isBrowserLauncherError(err) {
  return isBrowserLaunchError(err);
}

function linuxChromeCandidates() {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    ...LINUX_SNAP_CHROME_ELFS,
    LINUX_CHROMIUM_SNAP_WRAPPER,
  ]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean);
}

function winChromeCandidates() {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean);
}

function existingChromeCandidates() {
  const list = process.platform === 'win32' ? winChromeCandidates() : linuxChromeCandidates();
  const seen = new Set();
  const out = [];
  for (const candidate of list) {
    if (process.platform !== 'win32' && isWindowsPath(candidate)) {
      logger.warn('Ignoring Windows Chrome path on non-Windows host', {
        path: candidate,
        platform: process.platform,
      });
      continue;
    }
    if (!fileExists(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

function rankChromePath(p) {
  if (!p) return 99;
  if (process.platform === 'win32') return 0;
  const envPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (envPath && p === envPath && !isSnapLauncher(p)) return -1;
  if (isSnapLauncher(p) && !isSnapChromeElf(p)) return 80;
  if (isSnapChromeElf(p)) return 50;
  const n = String(p).toLowerCase();
  if (n.includes('google-chrome')) return 0;
  if (n.includes('chromium')) return 10;
  return 20;
}

/**
 * Resolve a system Chrome/Chromium binary for puppeteer-core.
 * Never prefer /snap/bin/chromium under PM2 — it cannot start in a user slice cgroup.
 */
function resolveChromePath() {
  const existing = existingChromeCandidates();
  if (!existing.length) return undefined;
  const ranked = [...existing].sort((a, b) => rankChromePath(a) - rankChromePath(b));
  const best = ranked[0];
  const envPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (envPath && isSnapLauncher(envPath) && best !== envPath) {
    logger.warn('Ignoring snap Chromium wrapper (PM2 cgroup incompatible)', {
      configured: envPath,
      using: best,
    });
  }
  return best;
}

function buildChromeArgs(lowMem) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-images',
    '--memory-pressure-off',
    '--js-flags=--max-old-space-size=128',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
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
    // 1GB: small window only. Do not cap renderer count or use --single-process —
    // Chrome already has about:blank, so newPage() then fails with Target.createTarget.
    args.push('--window-size=800,600');
  } else {
    args.push('--window-size=1280,720');
  }

  return args;
}

function resolveHeadlessMode(raw = process.env.PUPPETEER_HEADLESS) {
  const value = String(raw ?? 'true').trim().toLowerCase();
  if (value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'new' || value === 'shell') return 'new';
  return true;
}

class PuppeteerManager {
  constructor(options = {}) {
    this.lowMemory = options.lowMemory ?? lowMemoryMode();
    this.headless =
      options.headless !== undefined ? options.headless : resolveHeadlessMode();
    this.timeout = Number(options.timeout || process.env.PUPPETEER_TIMEOUT_MS || 45000);
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.restartEvery = Number(
      options.restartEvery ||
        process.env.BROWSER_RESTART_EVERY_N_PAGES ||
        (this.lowMemory ? 5 : 25)
    );
    this.blockResources =
      options.blockResources ?? process.env.PUPPETEER_BLOCK_RESOURCES !== 'false';
    this.maxConcurrentPages = Math.max(
      1,
      Number(
        options.maxConcurrentPages ||
          process.env.PUPPETEER_MAX_PAGES ||
          process.env.SCRAPER_CONCURRENCY ||
          2
      )
    );
    // --single-process Chromium cannot host two pages; overlapping extracts
    // produce "detached Frame" and kill stream URL discovery.
    const exclusive = Math.max(1, Number(process.env.PUPPETEER_CONCURRENCY || 1));
    if (this.lowMemory) {
      this.maxConcurrentPages = Math.min(this.maxConcurrentPages, exclusive);
    }
    this.executablePath =
      options.executablePath !== undefined && !isSnapLauncher(options.executablePath)
        ? options.executablePath
        : resolveChromePath();
    this.chromeCandidates = existingChromeCandidates();
    this.browser = null;
    this.browserPid = null;
    this.pagesOpened = 0; // lifetime counter (for recycle)
    this.openPages = 0; // currently open pages
    this.launching = null;
    this.closing = null;
    this._pageWaitQueue = [];
  }

  /**
   * Cap concurrent Puppeteer pages (default 2 on 1GB hosts).
   * Reserves a slot before the page is created to avoid races.
   */
  async acquirePageSlot() {
    for (;;) {
      if (this.openPages < this.maxConcurrentPages) {
        this.openPages += 1;
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        this._pageWaitQueue.push(resolve);
      });
    }
  }

  releasePageSlot() {
    this.openPages = Math.max(0, this.openPages - 1);
    const next = this._pageWaitQueue.shift();
    if (next) next();
  }

  /** Wake waiters after browser crash/disconnect so queues do not hang. */
  drainPageWaitQueue() {
    this.openPages = 0;
    const waiters = this._pageWaitQueue.splice(0);
    for (const resolve of waiters) resolve();
  }

  isConnected() {
    return Boolean(this.browser && this.browser.isConnected());
  }

  async launch() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      if (this.closing) {
        await this.closing.catch(() => {});
      }

      const candidates = [];
      const seen = new Set();
      for (const p of [this.executablePath, ...(this.chromeCandidates || [])]) {
        if (!p || seen.has(p) || !fileExists(p)) continue;
        seen.add(p);
        candidates.push(p);
      }
      candidates.sort((a, b) => rankChromePath(a) - rankChromePath(b));

      if (!candidates.length) {
        const hint =
          process.platform === 'win32'
            ? 'Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH'
            : 'Install Google Chrome (not snap Chromium): wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install ./google-chrome-stable_current_amd64.deb then set PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable';
        throw new Error(
          `puppeteer-core requires a system browser executablePath. None found. ${hint}`
        );
      }

      // Kill leftovers before a new launch (orphans from previous OOM/crash).
      await this.killOrphanChromium();

      const viewport = this.lowMemory
        ? { width: 800, height: 600 }
        : { width: 1280, height: 720 };

      // 1GB-oriented Chromium flags (merged with buildChromeArgs baseline)
      const lowMemArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--memory-pressure-off',
        '--js-flags=--max-old-space-size=128',
      ];
      const args = [
        ...new Set([...buildChromeArgs(this.lowMemory), ...(this.lowMemory ? lowMemArgs : [])]),
      ];

      let lastErr = null;
      for (const exe of candidates) {
        this.executablePath = exe;
        logger.info('Launching Puppeteer browser (puppeteer-core)', {
          headless: this.headless,
          timeout: this.timeout,
          platform: process.platform,
          executablePath: exe,
          lowMemory: this.lowMemory,
          blockResources: this.blockResources,
          maxConcurrentPages: this.maxConcurrentPages,
          argCount: args.length,
        });

        const launchOpts = {
          executablePath: exe,
          headless: this.headless,
          args,
          defaultViewport: viewport,
          ignoreHTTPSErrors: true,
          timeout: Math.min(this.timeout, 20000),
          protocolTimeout: Math.min(this.timeout, 30000),
        };

        try {
          const launchMs = Number(process.env.PUPPETEER_LAUNCH_TIMEOUT_MS || 20000);
          this.browser = await Promise.race([
            puppeteer.launch(launchOpts),
            new Promise((_, reject) => {
              setTimeout(
                () =>
                  reject(new Error('Failed to launch the browser process: launch timeout')),
                launchMs
              );
            }),
          ]);
          if (!this.browser?.isConnected()) {
            throw new Error('Failed to launch the browser process: disconnected immediately');
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = String(err?.message || err || '');
          if (!isBrowserLaunchError(err) && !isBrowserLauncherError(err)) throw err;
          logger.warn('Chromium launch failed — trying next binary', {
            executablePath: exe,
            error: msg.split('\n')[0],
          });
        }
      }

      if (!this.browser) {
        throw lastErr || new Error('Failed to launch Chromium');
      }

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
        this.drainPageWaitQueue();
        // Best-effort orphan cleanup after unexpected disconnect
        if (pid) this.forceKillPid(pid);
      });

      this.pagesOpened = 0;
      // Do not reset openPages — newPage() may already hold a slot.
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
    await this.acquirePageSlot();
    try {
      return await this._createConfiguredPage();
    } catch (err) {
      if (!isTargetClosedError(err)) {
        this.releasePageSlot();
        throw err;
      }
      logger.warn('Chromium target closed on newPage — relaunching once', {
        error: String(err.message || err).split('\n')[0],
      });
      try {
        await this.close();
        return await this._createConfiguredPage();
      } catch (err2) {
        this.releasePageSlot();
        throw err2;
      }
    }
  }

  async _createConfiguredPage() {
    let page = null;
    try {
      const browser = await this.ensureBrowser();
      if (!browser?.isConnected()) {
        throw new Error('Protocol error (Target.createTarget): Target closed');
      }
      page = await browser.newPage();
      this.pagesOpened += 1;
      page.__slotHeld = true;

      page.once('close', () => {
        if (page.__slotHeld) {
          page.__slotHeld = false;
          this.releasePageSlot();
        }
      });

      await this.applyPageDefaults(page);
      return page;
    } catch (err) {
      if (page) {
        await this.safeClosePage(page);
      }
      throw err;
    }
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
        const headers = response.headers() || {};
        const contentType = String(headers['content-type'] || '');
        const looksHls =
          patterns.some((re) => re.test(url)) ||
          /mpegurl|x-mpegURL|vnd\.apple\.mpegurl/i.test(contentType);
        if (!looksHls) return;
        if (/vd\.apisportpulse\.com|tvc-wc-2026/i.test(url)) return;
        captured.push({
          url,
          type: 'm3u8',
          status: response.status(),
          headers: {
            'User-Agent': this.userAgent,
            Referer: page.url(),
            ...(headers['set-cookie'] ? { Cookie: headers['set-cookie'] } : {}),
          },
          contentType,
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
      if (!page.isClosed()) {
        await page.close(); // close event releases the slot
      } else if (page.__slotHeld) {
        page.__slotHeld = false;
        this.releasePageSlot();
      }
    } catch (err) {
      logger.debug('Page close failed', { error: err.message });
      if (page.__slotHeld) {
        page.__slotHeld = false;
        this.releasePageSlot();
      }
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
   * Kill only the PID we launched. Never pkill google-chrome --no-sandbox:
   * that matches the live Puppeteer browser and causes Target.createTarget: Target closed.
   */
  async killOrphanChromium() {
    if (this.browser && this.browser.isConnected()) return;
    if (this.browserPid) {
      this.forceKillPid(this.browserPid);
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
      this.drainPageWaitQueue();

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

/**
 * Load the match page quickly, then wait briefly for player network idle.
 * networkidle0 is never used — ads keep sockets open and would burn the 1GB timeout.
 * A player-wait timeout is not a failure; extraction continues on the loaded DOM.
 */
async function gotoMatchPage(page, url, options = {}) {
  if (!page || page.isClosed()) {
    throw new Error('BROWSER_ERROR');
  }
  const waitUntil = options.waitUntil || 'domcontentloaded';
  const timeout = Number(options.timeout || 25000);
  const playerWaitUntil = options.playerWaitUntil || 'networkidle2';
  const playerWaitTimeoutMs = Number(options.playerWaitTimeoutMs || 8000);

  await page.goto(url, { waitUntil, timeout });

  if (page.isClosed()) throw new Error('BROWSER_ERROR');

  if (playerWaitUntil === 'networkidle2' || playerWaitUntil === 'networkidle0') {
    const concurrency = playerWaitUntil === 'networkidle0' ? 0 : 2;
    try {
      if (typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({
          idleTime: 500,
          timeout: playerWaitTimeoutMs,
          concurrency,
        });
      }
    } catch {
      // Player ads / websocket keep the page "busy" — DOM is still usable.
    }
  }

  try {
    await page.waitForSelector('iframe, video, #player, .player', {
      timeout: Math.min(4000, playerWaitTimeoutMs),
    });
  } catch {
    // Some pages inject the player after a click; continue to extract.
  }
}

/**
 * Process-wide Puppeteer task queue. Match URL discovery must never open
 * four browsers at once; default PUPPETEER_CONCURRENCY=1.
 */
class PuppeteerTaskQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.active = 0;
    this.maxActiveSeen = 0;
    this.pending = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.active += 1;
      this.maxActiveSeen = Math.max(this.maxActiveSeen, this.active);
      Promise.resolve()
        .then(() => job.fn())
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

let globalPuppeteerQueue = null;

function puppeteerConcurrency() {
  const fromEnv = Number(process.env.PUPPETEER_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  try {
    const { PUPPETEER_CONCURRENCY } = require('../utils/scraperConfig');
    return Math.max(1, Number(PUPPETEER_CONCURRENCY) || 1);
  } catch {
    return 1;
  }
}

function getGlobalPuppeteerQueue() {
  if (!globalPuppeteerQueue) {
    globalPuppeteerQueue = new PuppeteerTaskQueue(puppeteerConcurrency());
  }
  return globalPuppeteerQueue;
}

function runExclusivePuppeteerTask(fn) {
  return getGlobalPuppeteerQueue().run(fn);
}

module.exports = {
  PuppeteerManager,
  DEFAULT_UA,
  resolveChromePath,
  isBrowserLaunchError,
  isBrowserLauncherError,
  isTargetClosedError,
  isSnapLauncher,
  LINUX_CHROMIUM_DEFAULT: LINUX_CHROMIUM_SNAP_WRAPPER,
  LINUX_CHROMIUM_SNAP_WRAPPER,
  lowMemoryMode,
  buildChromeArgs,
  puppeteerConcurrency,
  getGlobalPuppeteerQueue,
  runExclusivePuppeteerTask,
  PuppeteerTaskQueue,
  gotoMatchPage,
};
