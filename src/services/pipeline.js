const { logger, logEvent, events } = require('../utils/logger');
const { Normalizer } = require('../utils/normalize');
const { todayYangon, isTodayOrTomorrow } = require('../utils/time');
const {
  isFootballPeakWindow,
  mayRunLowPriorityHeavyJob,
} = require('../utils/jobSchedule');
const { PuppeteerManager } = require('../browser/puppeteerManager');
const { ConfigLoader } = require('./configLoader');
const { FixtureService } = require('./fixtureService');
const { StreamEngine } = require('./streamEngine');
const { CacheService } = require('./cacheService');
const { GitHubService } = require('./githubService');
const { generateFlutterJson } = require('./jsonGenerator');
const { buildDeliveryBundle, formatChannelsDelivery, formatTipsDelivery } = require('./deliveryFormats');
const { enrichMatchState } = require('./statusService');
const { hasDataChanged } = require('../utils/compare');
const { HighlightSource } = require('../sources/highlight');
const { MyanmarTvSource } = require('../sources/myanmartv');
const { TipsSource } = require('../sources/tips');
const { buildEngineStreamingSources } = require('../sources/registry');
const { HighlightManager } = require('./highlightManager');
const { getScraperMonitor, isTimeoutError } = require('../monitor/scraper.monitor');
const { getGithubMonitor } = require('../monitor/github.monitor');
const { getTelegramService } = require('./telegram.service');
const {
  syncMatchesForDelivery,
  readExistingMatches,
} = require('./matchesSyncService');
const { adminMatchFileName } = require('../utils/adminMatch');

/**
 * Main AWS processing pipeline (matches.json):
 * Load config → FotMob fixtures every run (today+tomorrow, Asia/Yangon) →
 * kickoff-relative Match URL discovery (−60/−45/−30) then stream extract
 * starting at kickoff−30m; LIVE until +120m, then END + drop streams →
 * sync matches.json (expire kickoff+2h, merge streams) → GitHub PUT if changed
 *
 * Separate jobs (non-peak, once daily by default — see jobSchedule.DEFAULT_CRONS):
 * - Highlights (runHighlights)
 * - Myanmar TV channels (runMyanmarTv)
 * - Tips (runTips)
 * Peak 17:00–03:00 Yangon: Matches only among heavy scrapers.
 */
class Pipeline {
  constructor(env = process.env, admin = null) {
    this.env = env;
    this.configLoader = new ConfigLoader(env);
    this.cache = new CacheService();
    this.github = new GitHubService(env);
    this.browser = new PuppeteerManager();
    this.normalizer = new Normalizer();
    this.admin = admin;
    this.monitoring = null;
    this.running = false;
    this.highlightRunning = false;
    this.lastRun = null;
    this.lastHighlightRun = null;
    this.lastChannelsRun = null;
    this.lastTipsRun = null;
    this.channelsRunning = false;
    this.tipsRunning = false;
    this._expiring = false;
    this._runningSince = 0;
    this._highlightSince = 0;
    this._channelsSince = 0;
    this._tipsSince = 0;
    this._pendingMyanmarTv = false;
    this._pendingTips = false;
    this._pendingHighlights = false;
    this._pendingMatches = false;
    /** Next queued Matches run should force stream extract (Admin Match URL). */
    this._pendingForceStreamCheck = false;
    this._drainingQueued = false;
    this.lastDiscoveryAt = null;
    this.lastDiscoverySummary = null;
    this.lastExtractAt = null;
    this.lastExtractSummary = null;
    /** FotMob fixtures for today+tomorrow. Short TTL so evening runs still pick up tomorrow. */
    this.fixtureCache = { dayKey: null, fixtures: [], fetchedAt: 0 };
  }

  attachAdmin(admin) {
    this.admin = admin;
  }

  attachMonitoring(monitoring) {
    this.monitoring = monitoring || null;
  }

  _jobMaxRunMs() {
    return Math.max(
      5 * 60 * 1000,
      Number(this.env.PIPELINE_MAX_RUN_MS || 20 * 60 * 1000)
    );
  }

  /**
   * Clear job locks left true after OOM/crash/hang so highlight/tips/TV
   * are not starved forever behind a dead tipsRunning/highlightRunning flag.
   */
  _clearStuckJobLocks() {
    const maxMs = this._jobMaxRunMs();
    const now = Date.now();
    const locks = [
      ['running', '_runningSince', 'pipeline'],
      ['highlightRunning', '_highlightSince', 'highlight'],
      ['channelsRunning', '_channelsSince', 'MyanmarTV'],
      ['tipsRunning', '_tipsSince', 'tips'],
    ];
    for (const [flag, sinceKey, label] of locks) {
      if (!this[flag]) continue;
      const started = Number(this[sinceKey]) || 0;
      if (!started) {
        logger.warn('Stale lock recovery', {
          lock: label,
          previousTimestamp: null,
          ageSec: null,
          reason: 'orphan_no_timestamp',
          maxRuntimeMs: maxMs,
        });
        this[flag] = false;
        this[sinceKey] = 0;
        continue;
      }
      const ageMs = now - started;
      if (ageMs > maxMs) {
        logger.warn('Stale lock recovery', {
          lock: label,
          previousTimestamp: new Date(started).toISOString(),
          ageSec: Math.round(ageMs / 1000),
          reason: 'exceeded_max_runtime',
          maxRuntimeMs: maxMs,
        });
        this[flag] = false;
        this[sinceKey] = 0;
      }
    }
  }

  /**
   * Runtime diagnostics for /api/health and admin dashboard (1GB ops).
   */
  getRuntimeDiagnostics() {
    const now = Date.now();
    const lockAge = (since) => {
      const started = Number(since) || 0;
      if (!started) return null;
      return Math.round((now - started) / 1000);
    };
    return {
      timezone: 'Asia/Yangon',
      running: Boolean(this.running),
      tipsRunning: Boolean(this.tipsRunning),
      highlightRunning: Boolean(this.highlightRunning),
      channelsRunning: Boolean(this.channelsRunning),
      locks: {
        pipeline: {
          active: Boolean(this.running),
          since: this._runningSince || null,
          ageSec: lockAge(this._runningSince),
        },
        tips: {
          active: Boolean(this.tipsRunning),
          since: this._tipsSince || null,
          ageSec: lockAge(this._tipsSince),
        },
        highlight: {
          active: Boolean(this.highlightRunning),
          since: this._highlightSince || null,
          ageSec: lockAge(this._highlightSince),
        },
        channels: {
          active: Boolean(this.channelsRunning),
          since: this._channelsSince || null,
          ageSec: lockAge(this._channelsSince),
        },
      },
      pending: {
        matches: Boolean(this._pendingMatches),
        forceStreamCheck: Boolean(this._pendingForceStreamCheck),
        highlights: Boolean(this._pendingHighlights),
        tips: Boolean(this._pendingTips),
        myanmartv: Boolean(this._pendingMyanmarTv),
      },
      lastRun: this.lastRun || null,
      lastHighlightRun: this.lastHighlightRun || null,
      lastChannelsRun: this.lastChannelsRun || null,
      lastTipsRun: this.lastTipsRun || null,
      lastDiscoveryAt: this.lastDiscoveryAt || null,
      lastDiscoverySummary: this.lastDiscoverySummary || null,
      lastExtractAt: this.lastExtractAt || null,
      lastExtractSummary: this.lastExtractSummary || null,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSec: Math.floor(process.uptime()),
    };
  }

  buildStreamingSources(sourcesDoc) {
    let doc = sourcesDoc;
    if (this.admin?.sources) {
      doc = this.admin.sources.applyToSourcesDoc(sourcesDoc);
    }

    // Config-driven: every enabled type=streaming source (except soco/http)
    // is collected in parallel across matches — never stop after first hit.
    return buildEngineStreamingSources(doc, {
      browserManager: this.browser,
      normalizer: this.normalizer,
      isEnabled: (name) =>
        this.admin?.sources ? this.admin.sources.isEnabled(name) : true,
    });
  }

  /**
   * When local matches.json is empty but GitHub still has rows, pull them back
   * so admin/Flutter are not stuck on a blank feed after expire cleanup.
   */
  async restoreMatchesFromGithub({ actor = 'system' } = {}) {
    if (!this.github?.enabled) {
      return { ok: false, reason: 'github_not_configured', restored: 0 };
    }
    const publicPath = this.github.paths?.matches || this.github.dataPath || 'matches.json';
    const adminPath = `${this.env.GITHUB_CONFIG_PATH || 'config'}/${adminMatchFileName(this.env)}`.replace(/\/+/g, '/');
    let remote;
    let restoreSource = 'matches.json';
    try {
      const existingPreview = readExistingMatches(this.cache);
      if (!existingPreview.length) {
        const adminRemote = await this.github.getFileSha(adminPath);
        if (Array.isArray(adminRemote?.content?.matches) && adminRemote.content.matches.length) {
          remote = adminRemote;
          restoreSource = 'admin-match.json';
        }
      }
      if (!remote) {
        remote = await this.github.getFileSha(publicPath);
      }
    } catch (err) {
      return { ok: false, reason: 'github_error', error: err.message, restored: 0 };
    }
    const remoteMatches = Array.isArray(remote?.content?.matches)
      ? remote.content.matches
      : [];
    if (!remoteMatches.length) {
      return { ok: false, reason: 'remote_empty', restored: 0 };
    }

    const extras = {
      highlights: this.cache.getCurrent()?.highlights || [],
      channels: this.cache.getCurrent()?.channels || [],
    };

    // Local state is authoritative when present. Merge remote into local so a
    // sparse GitHub delivery cannot wipe Match URL / stream / Admin fields.
    // When local is empty (true recovery), take remote then stamp overrides.
    await this._ensureNormalizerLoaded().catch(() => null);
    const existing = readExistingMatches(this.cache);
    let mergedMatches;
    if (existing.length) {
      mergedMatches = syncMatchesForDelivery(existing, remoteMatches, {
        normalizer: this.normalizer,
      }).matches;
    } else {
      mergedMatches = remoteMatches.map((m) => enrichMatchState(m));
    }
    if (this.admin?.overrides) {
      mergedMatches = this.admin.overrides.applyToMatches(mergedMatches);
    }
    if (this.admin?.adminMatches) {
      await this.admin.adminMatches.load();
      mergedMatches = this.admin.adminMatches.applyToMatches(mergedMatches);
    }

    const payload = generateFlutterJson(
      mergedMatches,
      {
        configOrigin: 'github_restore',
        sources: [],
        restoredBy: actor,
        mergedWithLocal: existing.length > 0,
      },
      extras
    );
    const { payload: cached } = this.cache.saveGenerated(payload);
    const delivery = buildDeliveryBundle({
      matchesPayload: cached,
      highlights: extras.highlights,
      channels: extras.channels,
    });
    this.cache.saveDeliveryBundle(delivery);
    logger.info('Restored matches from GitHub', {
      restored: remoteMatches.length,
      restoreSource,
      localBaseline: existing.length,
      finalCount: cached.matches?.length || mergedMatches.length,
      actor,
    });
    return {
      ok: true,
      restored: remoteMatches.length,
      matchCount: cached.matches?.length || mergedMatches.length,
      payload: cached,
    };
  }

  /**
   * Drop matches past kickoff+2h and refresh Scheduled/PREPARING/LIVE/END
   * from the clock. Runs even when a scrape is still in progress so a hung
   * Puppeteer cycle cannot leave stale status in matches.json.
   */
  async expireStaleMatches({ actor = 'expire' } = {}) {
    if (this._expiring) {
      return { ok: true, changed: false, reason: 'expire_already_running' };
    }
    this._expiring = true;
    try {
      await this._ensureNormalizerLoaded();
      let existing = readExistingMatches(this.cache);
      if (!existing.length) {
        const restored = await this.restoreMatchesFromGithub({
          actor: `${actor}:auto`,
        });
        if (restored.ok) {
          existing = readExistingMatches(this.cache);
        }
        if (!existing.length) {
          return { ok: true, changed: false, removed: 0, restored };
        }
      }

      const extras = {
        highlights: this.cache.getCurrent()?.highlights || [],
        channels: this.cache.getCurrent()?.channels || [],
      };

      const sync = syncMatchesForDelivery(existing, [], {
        normalizer: this.normalizer,
      });
      // Status-only ticks must not GitHub-publish a fixtures shell before
      // StreamEngine has written Match URLs. Pipeline.run publishes status.
      if (!(sync.removedExpired > 0)) {
        return {
          ok: true,
          changed: false,
          removed: 0,
          reason: 'no_expiry',
        };
      }
      let matchesOut = sync.matches;
      if (this.admin?.overrides) {
        matchesOut = this.admin.overrides.applyToMatches(matchesOut);
      }
      if (this.admin?.adminMatches) {
        await this.admin.adminMatches.load();
        matchesOut = this.admin.adminMatches.applyToMatches(matchesOut);
      }
      const payload = generateFlutterJson(
        matchesOut,
        { configOrigin: 'expire', sources: [] },
        extras
      );
      const previous = this.cache.getCurrent();
      if (
        !hasDataChanged(
          { matches: previous?.matches || existing },
          { matches: payload.matches }
        )
      ) {
        return { ok: true, changed: false, removed: sync.removedExpired || 0 };
      }

      // Allow clearing when every row expired; refuse empty only when nothing expired
      // (that usually means a bad scrape would wipe a good feed).
      if (
        this.cache.isEmptyPayload(payload) &&
        (previous?.matches?.length || existing.length) &&
        !(sync.removedExpired > 0)
      ) {
        logger.warn('Expire would empty matches.json — keeping previous feed', {
          removedExpired: sync.removedExpired,
          previousCount: previous?.matches?.length || existing.length,
        });
        return {
          ok: true,
          changed: false,
          removed: sync.removedExpired || 0,
          reason: 'refuse_empty',
        };
      }

      logger.info('Refreshing matches.json (expire/status)', {
        removedExpired: sync.removedExpired,
        matchCount: matchesOut.length,
      });

      if (this.admin?.publish) {
        const published = await this.admin.publish.publish(
          matchesOut,
          { configOrigin: 'expire', sources: [] },
          { actor, extras }
        );
        return {
          ok: published.ok !== false,
          changed: Boolean(published.changed),
          removed: sync.removedExpired || 0,
          github: published.github,
          reason: published.reason,
        };
      }

      const previousCache = this.cache.getCurrent();
      if (
        this.cache.isEmptyPayload(payload) &&
        previousCache?.matches?.length
      ) {
        return { ok: false, reason: 'empty_payload', removed: sync.removedExpired };
      }

      const { payload: cached } = this.cache.saveGenerated(payload);
      const delivery = buildDeliveryBundle({
        matchesPayload: cached,
        highlights: extras.highlights,
        channels: extras.channels,
      });
      const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);
      let github = { uploaded: false, reason: 'local_unchanged', feeds: {} };
      try {
        github = await this.github.uploadDeliveryBundle(delivery, prevDelivery);
      } catch (err) {
        github = {
          uploaded: false,
          reason: 'github_error',
          error: err.message,
          feeds: {},
        };
      }
      return {
        ok: true,
        changed: true,
        removed: sync.removedExpired || 0,
        github,
      };
    } finally {
      this._expiring = false;
    }
  }

  async run({ forceStreamCheck = false } = {}) {
    try {
      await this.expireStaleMatches();
    } catch (err) {
      logger.warn('Expire-before-scrape failed', { error: err.message });
    }

    this._clearStuckJobLocks();
    if (this.running) {
      // Admin Match URL / force extract must not be dropped while a cycle is mid-flight.
      this._pendingMatches = true;
      if (forceStreamCheck) this._pendingForceStreamCheck = true;
      logger.warn('Pipeline skip', { reason: 'already_running', queued: true });
      return { ok: false, reason: 'already_running', queued: true };
    }
    // Never share Chromium / heavy work with highlight or MyanmarTV jobs on 1GB hosts.
    // Queue Matches so drain runs it before any lower-priority job.
    if (this.highlightRunning) {
      this._pendingMatches = true;
      if (forceStreamCheck) this._pendingForceStreamCheck = true;
      logger.warn('Pipeline skip', { reason: 'highlight_running', queued: true });
      return { ok: false, reason: 'highlight_running', queued: true };
    }
    if (this.channelsRunning) {
      this._pendingMatches = true;
      if (forceStreamCheck) this._pendingForceStreamCheck = true;
      logger.warn('Pipeline skip', { reason: 'channels_running', queued: true });
      return { ok: false, reason: 'channels_running', queued: true };
    }
    if (this.tipsRunning) {
      this._pendingMatches = true;
      if (forceStreamCheck) this._pendingForceStreamCheck = true;
      logger.warn('Pipeline skip', { reason: 'tips_running', queued: true });
      return { ok: false, reason: 'tips_running', queued: true };
    }

    this.running = true;
    this._runningSince = Date.now();
    const startedAt = Date.now();
    logEvent(events.SCRAPER_START, 'Pipeline start');

    try {
      if (!readExistingMatches(this.cache).length) {
        await this.restoreMatchesFromGithub({ actor: 'pipeline:auto' }).catch(
          () => null
        );
      }
      const config = await this.configLoader.load(true);
      let leagues = config.leagues?.allowedLeagues || config.leagues?.leagues || [];
      if (this.admin?.leagues) {
        leagues = this.admin.leagues.filterAllowedLeagueDefs(leagues);
      }
      const teams = config.teams?.teams || [];
      this.normalizer.reload({ leagues, teams });
      const leaguesFingerprint = leagues
        .map((l) => `${l.standardName}:${(l.fotmobIds || []).join(',')}`)
        .sort()
        .join('|');
      if (this._leaguesFingerprint !== leaguesFingerprint) {
        // Allow-list / aliases changed — drop once-per-day fixture cache so labels re-map.
        this.fixtureCache = { dayKey: null, fixtures: [], fetchedAt: 0 };
        this._leaguesFingerprint = leaguesFingerprint;
        logger.info('League config changed — cleared FotMob fixture cache');
      }

      const fotmobConfig = this.configLoader.getSourceConfig(config.sources, 'fotmob') || {
        name: 'fotmob',
        domains: ['https://www.fotmob.com'],
        api: { matches: 'https://www.fotmob.com/api/data/matches' },
      };

      let fixtures;
      try {
        fixtures = await this._collectFixturesTodayTomorrow(fotmobConfig, {
          force: forceStreamCheck,
        });
        if (this.admin?.leagues) {
          fixtures = this.admin.leagues.filterMatches(fixtures);
        }
        fixtures = this._unionTodayTomorrowFixtures(fixtures);
        // Carry forward streams/sourcePages from previous matches.json
        fixtures = this._mergePreviousMatchState(fixtures);
        if (this.admin?.overrides) {
          fixtures = fixtures.map((f) =>
            this.admin.overrides.applyManualMatchUrlsToFixture(f)
          );
        }
        if (this.admin?.adminMatches) {
          await this.admin.adminMatches.load();
          fixtures = this.admin.adminMatches.applyToMatches(fixtures);
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Fixture collection failed — keep previous data', {
          error: err.message,
        });
        const scraperMonitor = this.monitoring?.scraperMonitor || getScraperMonitor();
        if (isTimeoutError(err)) {
          await scraperMonitor
            .notifyTimeout(fotmobConfig.domains?.[0] || 'fotmob', err)
            .catch(() => {});
        } else {
          await scraperMonitor.notifySourceFailed('fotmob', err).catch(() => {});
        }
        if (this.admin?.logService) {
          this.admin.logService.add({
            category: 'scraper',
            action: 'fixture_failure',
            message: err.message,
          });
        }
        const kept = this.cache.keepPreviousOnFailure();
        this.lastRun = { ok: false, reason: 'fixture_failure', at: new Date().toISOString() };
        return { ok: false, reason: 'fixture_failure', kept };
      }

      const streamingSources = this.buildStreamingSources(config.sources);
      const scraperMonitor = this.monitoring?.scraperMonitor || getScraperMonitor();
      scraperMonitor.beginCycle();

      const progressMeta = {
        configOrigin: config.origin,
        sources: streamingSources.map((s) => s.name).filter(Boolean),
        sourcesDoc: config.sources,
      };

      const engine = new StreamEngine({
        sources: streamingSources,
        scraperMonitor,
        onMatchUpdated: (match) => this._persistMatchProgress(match, progressMeta),
      });

      let matches;
      try {
        matches = await engine.collectForFixtures(fixtures, { force: forceStreamCheck });
        this._recordSourceStats(matches);
        this.lastDiscoveryAt = engine.lastDiscoveryAt || this.lastDiscoveryAt;
        this.lastDiscoverySummary =
          engine.lastDiscoverySummary || this.lastDiscoverySummary;
        this.lastExtractAt = engine.lastExtractAt || this.lastExtractAt;
        this.lastExtractSummary =
          engine.lastExtractSummary || this.lastExtractSummary;
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Stream engine failed — fixtures only payload', {
          error: err.message,
        });
        await scraperMonitor.notifySourceFailed('streamEngine', err).catch(() => {});
        matches = fixtures;
      }

      const previous = this.cache.getCurrent();
      const enabledStreamNames = streamingSources.map((s) => s.name).filter(Boolean);
      await scraperMonitor.evaluateCycle({ enabledSources: enabledStreamNames }).catch(() => {});

      // Highlights + Myanmar TV channels
      const extras = await this._collectExtraContent(config.sources, previous);

      const sourceNames = [
        ...streamingSources.map((s) => s.name),
        ...(this._isSourceEnabled(config.sources, 'highlight1') ||
        this._isSourceEnabled(config.sources, 'highlight') ||
        this._isSourceEnabled(config.sources, 'highlight2')
          ? ['highlight']
          : []),
        ...(this._isSourceEnabled(config.sources, 'myanmartv') ? ['myanmartv'] : []),
      ];

      // Publish through admin layer when available (overrides + league filter + GitHub)
      if (this.admin?.publish) {
        const published = await this.admin.publish.publish(
          matches,
          {
            configOrigin: config.origin,
            sources: sourceNames,
            sourcesDoc: config.sources,
          },
          { actor: 'scraper', extras }
        );

        if (!published.ok && published.reason === 'refuse_empty') {
          this.lastRun = {
            ok: false,
            reason: 'empty_payload',
            at: new Date().toISOString(),
          };
          return { ok: false, reason: 'empty_payload', previous: published.payload };
        }

        await (this.monitoring?.githubMonitor || getGithubMonitor())
          .inspectResult(published.github)
          .catch(() => {});

        const durationMs = Date.now() - startedAt;
        logEvent(events.SCRAPER_SUCCESS, 'Pipeline success', {
          matchCount: published.payload?.matches?.length || 0,
          highlightCount: published.payload?.highlights?.length || 0,
          channelCount: published.payload?.channels?.length || 0,
          changed: published.changed,
          github: published.github,
          durationMs,
        });

        this.lastRun = {
          ok: true,
          matchCount: published.payload?.matches?.length || 0,
          changed: published.changed,
          github: published.github,
          durationMs,
          at: new Date().toISOString(),
        };

        return {
          ok: true,
          payload: published.payload,
          changed: published.changed,
          github: published.github,
          durationMs,
        };
      }

      // Fallback without admin context — same expire/merge sync as publish
      const sync = syncMatchesForDelivery(readExistingMatches(this.cache), matches, {
        normalizer: this.normalizer,
      });
      const payload = generateFlutterJson(
        sync.matches,
        {
          configOrigin: config.origin,
          sources: sourceNames,
        },
        extras
      );
      const previousCache = this.cache.getCurrent();
      if (
        this.cache.isEmptyPayload(payload) &&
        previousCache?.matches?.length
      ) {
        logger.warn('Generated empty payload — keeping previous valid data');
        logEvent(events.GITHUB_SKIPPED, 'Skip upload — empty generation');
        this.lastRun = {
          ok: false,
          reason: 'empty_payload',
          at: new Date().toISOString(),
        };
        return { ok: false, reason: 'empty_payload', previous: previousCache };
      }

      const { changed, payload: cached } = this.cache.saveGenerated(payload);
      const delivery = buildDeliveryBundle({
        matchesPayload: cached,
        highlights: extras.highlights || [],
        channels: extras.channels || [],
      });
      const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);
      let githubResult = { uploaded: false, reason: 'local_unchanged', feeds: {} };
      try {
        githubResult = await this.github.uploadDeliveryBundle(delivery, prevDelivery);
      } catch (err) {
        githubResult = {
          uploaded: false,
          reason: 'github_error',
          error: err.message,
          feeds: {},
        };
      }
      await (this.monitoring?.githubMonitor || getGithubMonitor())
        .inspectResult(githubResult)
        .catch(() => {});

      const durationMs = Date.now() - startedAt;
      this.lastRun = {
        ok: true,
        matchCount: cached.matches.length,
        changed,
        github: githubResult,
        durationMs,
        at: new Date().toISOString(),
      };

      return {
        ok: true,
        payload: cached,
        delivery,
        changed,
        github: githubResult,
        durationMs,
      };
    } catch (err) {
      logEvent(events.SCRAPER_ERROR, 'Pipeline fatal error', { error: err.message });
      await getTelegramService().serverCrash(err).catch(() => {});
      const kept = this.cache.keepPreviousOnFailure();
      this.lastRun = {
        ok: false,
        reason: err.message,
        at: new Date().toISOString(),
      };
      return { ok: false, reason: err.message, kept };
    } finally {
      this.running = false;
      this._runningSince = 0;
      await this._drainQueuedJobs().catch((err) => {
        logger.error('Queued job drain failed', { error: err.message });
      });
      // Only tear down Chromium when no other scrape owns it
      if (!this.highlightRunning && !this.channelsRunning && !this.tipsRunning) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * FotMob today + tomorrow (Asia/Yangon). Cached briefly so cron ticks
   * still refresh evening/tomorrow fixtures instead of freezing a morning list.
   */
  async _collectFixturesTodayTomorrow(fotmobConfig, { force = false } = {}) {
    const dayKey = todayYangon().toFormat('yyyy-MM-dd');
    const ttlMs = Math.max(
      0,
      Number(this.env.FOTMOB_FIXTURE_CACHE_MS || 5 * 60 * 1000)
    );
    const cacheAge = Date.now() - (Number(this.fixtureCache.fetchedAt) || 0);
    if (
      !force &&
      ttlMs > 0 &&
      this.fixtureCache.dayKey === dayKey &&
      Array.isArray(this.fixtureCache.fixtures) &&
      this.fixtureCache.fixtures.length &&
      cacheAge < ttlMs
    ) {
      logger.info('Using cached FotMob fixtures', {
        dayKey,
        count: this.fixtureCache.fixtures.length,
        ageSec: Math.round(cacheAge / 1000),
      });
      return this.fixtureCache.fixtures.map((f) =>
        this.normalizer.repairMatchLeague({
          ...f,
          streams: [],
          streamAttempts: f.streamAttempts || {},
        })
      );
    }

    const fixtureService = new FixtureService({
      config: fotmobConfig,
      normalizer: this.normalizer,
    });
    const fixtures = await fixtureService.collect();
    const todayTomorrow = (fixtures || []).filter((f) => isTodayOrTomorrow(f.kickoff));

    this.fixtureCache = {
      dayKey,
      fetchedAt: Date.now(),
      fixtures: todayTomorrow.map((f) => ({
        ...f,
        streams: [],
        streamAttempts: {},
      })),
    };

    logger.info('FotMob fixtures scraped (today + tomorrow)', {
      dayKey,
      count: this.fixtureCache.fixtures.length,
    });

    return this.fixtureCache.fixtures.map((f) =>
      this.normalizer.repairMatchLeague({ ...f })
    );
  }

  async _ensureNormalizerLoaded() {
    try {
      const config = await this.configLoader.load(false);
      let leagues = config.leagues?.allowedLeagues || config.leagues?.leagues || [];
      if (this.admin?.leagues) {
        leagues = this.admin.leagues.filterAllowedLeagueDefs(leagues);
      }
      const teams = config.teams?.teams || [];
      this.normalizer.reload({ leagues, teams });
    } catch (err) {
      logger.warn('Could not reload league config before expire', { error: err.message });
    }
  }

  /**
   * A short FotMob payload must not drop other today/tomorrow allow-list matches
   * already in matches.json (e.g. ASEAN / UCL qualification listed under a
   * different tournament id).
   */
  _unionTodayTomorrowFixtures(scraped) {
    const byKey = new Map();
    const remember = (row) => {
      if (!row?.matchId || !isTodayOrTomorrow(row.kickoff)) return;
      const fm = row.fotmobMatchId || row.fotmobId;
      const key = fm != null && fm !== '' ? `fm:${fm}` : `id:${row.matchId}`;
      if (!byKey.has(key)) byKey.set(key, row);
    };
    for (const f of scraped || []) remember(f);
    for (const m of this.cache.getCurrent()?.matches || []) remember(m);
    return [...byKey.values()];
  }

  /**
   * Re-attach streams / sourcePages / streamAttempts / streamSearch from previous
   * matches.json so fixture-only refreshes do not wipe discovered URLs or search state.
   */
  _mergePreviousMatchState(fixtures) {
    const previous = this.cache.getCurrent()?.matches || [];
    const byId = new Map(previous.map((m) => [m.matchId, m]));
    const byFotmob = new Map();
    for (const m of previous) {
      const fm = m.fotmobMatchId || m.fotmobId;
      if (fm == null || fm === '') continue;
      if (!byFotmob.has(String(fm))) byFotmob.set(String(fm), m);
    }

    const mergeSourceEntry = (prev, incoming) => {
      const p = prev && typeof prev === 'object' ? prev : null;
      const n = incoming && typeof incoming === 'object' ? incoming : null;
      if (!p) return n;
      if (!n) return p;
      const prevUrl = String(p.matchUrl || '').trim();
      const nextUrl = String(n.matchUrl || '').trim();
      return {
        ...p,
        ...n,
        matchUrl: nextUrl || prevUrl || null,
        attempts: Math.max(Number(n.attempts) || 0, Number(p.attempts) || 0),
        liveAttempts: Math.max(Number(n.liveAttempts) || 0, Number(p.liveAttempts) || 0),
        confidence: Math.max(Number(n.confidence) || 0, Number(p.confidence) || 0),
        lastAttemptAt: n.lastAttemptAt || p.lastAttemptAt || null,
        slotsDone: { ...(p.slotsDone || {}), ...(n.slotsDone || {}) },
        status: nextUrl || !prevUrl ? n.status || p.status : p.status || n.status,
        manual: Boolean(p.manual || n.manual),
      };
    };
    const mergeSearch = (prev, incoming) => {
      const p = prev && typeof prev === 'object' ? prev : null;
      const n = incoming && typeof incoming === 'object' ? incoming : null;
      if (!p && !n) return undefined;
      if (!p) return n;
      if (!n) return p;
      const prevSources = p.sources && typeof p.sources === 'object' ? p.sources : {};
      const nextSources = n.sources && typeof n.sources === 'object' ? n.sources : {};
      const names = new Set([...Object.keys(prevSources), ...Object.keys(nextSources)]);
      const sources = {};
      for (const name of names) {
        sources[name] = mergeSourceEntry(prevSources[name], nextSources[name]);
      }
      return {
        ...p,
        ...n,
        started: Boolean(n.started || p.started),
        stopped: Boolean(n.stopped || p.stopped),
        stopTime: n.stopTime || p.stopTime || null,
        slotsDone: { ...(p.slotsDone || {}), ...(n.slotsDone || {}) },
        sources,
      };
    };

    return (fixtures || []).map((f) => {
      const fm = f.fotmobMatchId || f.fotmobId;
      const prev =
        byId.get(f.matchId) ||
        (fm != null && fm !== '' ? byFotmob.get(String(fm)) : null);
      const repaired = this.normalizer.repairMatchLeague(f);
      if (!prev) return enrichMatchState(repaired);

      return enrichMatchState({
        ...repaired,
        streams: Array.isArray(prev.streams) ? prev.streams : [],
        sourcePages: { ...(prev.sourcePages || {}), ...(repaired.sourcePages || {}) },
        originalNames: {
          ...(prev.originalNames || {}),
          ...(repaired.originalNames || {}),
        },
        streamAttempts: {
          ...(prev.streamAttempts || {}),
          ...(repaired.streamAttempts || {}),
        },
        streamSearch: mergeSearch(prev.streamSearch, repaired.streamSearch),
        matchUrl: repaired.matchUrl || prev.matchUrl || null,
        matchUrlStatus: (() => {
          const url = repaired.matchUrl || prev.matchUrl || null;
          const a = repaired.matchUrlStatus || null;
          const b = prev.matchUrlStatus || null;
          if (!url) return a || b || null;
          const rank = (s) => {
            if (s === 'MATCH_URL_CONFIRMED' || s === 'MATCH_CONFIRMED') return 3;
            if (s === 'MATCH_URL_FOUND') return 2;
            if (s === 'MATCH_URL_SEARCHING') return 1;
            return 0;
          };
          return rank(a) >= rank(b) ? a || b : b || a;
        })(),
        matchUrlAttempts: Math.max(
          Number(repaired.matchUrlAttempts) || 0,
          Number(prev.matchUrlAttempts) || 0
        ),
        lastMatchUrlAttemptAt:
          repaired.lastMatchUrlAttemptAt || prev.lastMatchUrlAttemptAt || null,
        matchUrlSource: repaired.matchUrlSource || prev.matchUrlSource || null,
        matchUrlSearch: mergeSearch(prev.matchUrlSearch, repaired.matchUrlSearch),
        // Keep last good H2H when this scrape could not fetch matchDetails
        h2h: repaired.h2h != null ? repaired.h2h : prev.h2h != null ? prev.h2h : null,
        streamUrl: repaired.streamUrl || prev.streamUrl || null,
        streamHeaders: repaired.streamHeaders || prev.streamHeaders || null,
        streamStatus: repaired.streamStatus || prev.streamStatus || null,
        validationStatus: repaired.validationStatus || prev.validationStatus || null,
        validationReason:
          repaired.validationReason != null
            ? repaired.validationReason
            : prev.validationReason != null
              ? prev.validationReason
              : null,
        attempts: Math.max(Number(repaired.attempts) || 0, Number(prev.attempts) || 0),
        lastAttemptAt: repaired.lastAttemptAt || prev.lastAttemptAt || null,
        statusLocked: Boolean(prev.statusLocked),
        manual: Boolean(prev.manual || repaired.manual),
        pinned: Boolean(prev.pinned || repaired.pinned),
        featured: Boolean(prev.featured || repaired.featured),
      });
    });
  }

  /**
   * Immediate matches.json save + GitHub sync when a verified stream is found.
   * Updates only the changed match inside the current payload.
   */
  async _persistMatchProgress(match, meta = {}) {
    if (!match?.matchId) return;

    const current = this.cache.getCurrent();
    // Publish path runs full sync (expire + merge streams) against matches.json
    const incoming = [match];

    const extras = {
      highlights: current?.highlights || [],
      channels: current?.channels || [],
    };

    if (this.admin?.publish) {
      await this.admin.publish.publish(
        incoming,
        {
          configOrigin: meta.configOrigin || 'runtime',
          sources: meta.sources || [],
          sourcesDoc: meta.sourcesDoc || null,
        },
        { actor: 'stream-search', extras }
      );
      return;
    }

    const existing = readExistingMatches(this.cache);
    const sync = syncMatchesForDelivery(existing, incoming, {
      normalizer: this.normalizer,
    });

    const payload = generateFlutterJson(
      sync.matches,
      {
        configOrigin: meta.configOrigin || 'runtime',
        sources: meta.sources || [],
      },
      extras
    );
    const { payload: cached } = this.cache.saveGenerated(payload);
    const delivery = buildDeliveryBundle({
      matchesPayload: cached,
      highlights: extras.highlights,
      channels: extras.channels,
    });
    const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);
    try {
      // uploadJsonIfChanged → PUT only when content changed
      await this.github.uploadDeliveryBundle(delivery, prevDelivery);
    } catch (err) {
      logger.warn('Immediate GitHub sync failed', { error: err.message });
    }
  }

  _recordSourceStats(matches) {
    if (!this.admin?.sources) return;
    const counts = {};
    for (const m of matches || []) {
      for (const s of m.streams || []) {
        const name = String(s.source || '').toLowerCase();
        if (!name || s.active === false) continue;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    for (const [name, count] of Object.entries(counts)) {
      if (count > 0) this.admin.sources.recordSuccess(name, count);
    }
  }

  _isSourceEnabled(sourcesDoc, name) {
    const cfg = this.configLoader.getSourceConfig(sourcesDoc, name);
    if (cfg && cfg.enabled === false) return false;
    if (this.admin?.sources && typeof this.admin.sources.isEnabled === 'function') {
      try {
        return this.admin.sources.isEnabled(name);
      } catch {
        return true;
      }
    }
    return true;
  }

  /**
   * Highlights: dedicated 3-hour job (runHighlights).
   * Myanmar TV: dedicated job (runMyanmarTv). Tokens expire in ~10 minutes.
   * Main pipeline only reuses last successful stores — no live scrape each tick.
   */
  async _collectExtraContent(sourcesDoc, previous) {
    const deliveryHighlight =
      this.cache.getDelivery('highlight1') || this.cache.getDelivery('highlight');
    const manager = new HighlightManager({
      retentionDays: Number(
        this.configLoader.getSourceConfig(sourcesDoc, 'highlight1')?.retentionDays ||
          this.configLoader.getSourceConfig(sourcesDoc, 'highlight')?.retentionDays ||
          this.configLoader.getSourceConfig(sourcesDoc, 'highlight')?.recentDays ||
          7
      ),
    });

    const existing = manager.extractList(deliveryHighlight).length
      ? manager.extractList(deliveryHighlight)
      : previous?.highlights || [];

    const pruned = manager.merge({
      existing,
      scraped: [],
      retentionDays: manager.retentionDays,
    });

    const deliveryChannels = this.cache.getDelivery('myanmartv');
    const channels = Array.isArray(deliveryChannels) && deliveryChannels.length
      ? deliveryChannels
      : previous?.channels || [];

    return {
      highlights: pruned.highlights,
      channels,
    };
  }

  _highlightConfigs(sourcesDoc) {
    const list = sourcesDoc?.sources || [];
    const typed = list.filter(
      (s) => s && (s.type === 'highlights' || s.type === 'highlight') && s.enabled !== false
    );
    if (typed.length) {
      const enabled = typed.filter((s) => this._isSourceEnabled(sourcesDoc, s.name));
      // sources.json order: highlight1 then highlight2. Never reorder.
      return enabled;
    }
    const legacy = this.configLoader.getSourceConfig(sourcesDoc, 'highlight');
    if (legacy && this._isSourceEnabled(sourcesDoc, 'highlight')) return [legacy];
    return [];
  }

  _highlightFeedKey(cfg = {}) {
    const feed = String(cfg.feed || cfg.name || '').toLowerCase();
    if (feed === 'highlight2' || cfg.parser === 'socolive') return 'highlight2';
    if (feed === 'highlight1' || feed === 'highlight' || cfg.parser === 'hoofoot') {
      return 'highlight1';
    }
    return feed.startsWith('highlight') ? feed : 'highlight1';
  }

  /**
   * Dedicated highlight job (HIGHLIGHT_CRON):
   * highlight1 (Hoofoot) then highlight2 (Socolive), one after the other on 1GB RAM.
   * If highlight1 hangs or fails, highlight2 still runs.
   */
  async runHighlights({ force = false } = {}) {
    this._clearStuckJobLocks();
    if (!mayRunLowPriorityHeavyJob(null, { force })) {
      this._pendingHighlights = false;
      logger.info('Peak football window — skip Highlights (no backlog)');
      return { ok: false, reason: 'peak_window' };
    }
    if (this.highlightRunning) {
      logger.warn('Highlight job already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    if (this.running) {
      this._pendingHighlights = true;
      logger.warn('Pipeline active — queue highlight job');
      return { ok: false, reason: 'pipeline_running', queued: true };
    }
    if (this.channelsRunning) {
      this._pendingHighlights = true;
      logger.warn('MyanmarTV job active — queue highlight job');
      return { ok: false, reason: 'channels_running', queued: true };
    }
    if (this.tipsRunning) {
      this._pendingHighlights = true;
      logger.warn('Tips job active — queue highlight job');
      return { ok: false, reason: 'tips_running', queued: true };
    }

    this.highlightRunning = true;
    this._highlightSince = Date.now();
    const startedAt = Date.now();

    logEvent(events.SCRAPER_START, 'Highlight scraper started', {
      force,
      timezone: 'Asia/Yangon',
    });

    try {
      const config = await this.configLoader.load(true);
      const configs = this._highlightConfigs(config.sources);
      if (!configs.length) {
        logger.info('Highlight sources disabled — skip');
        return { ok: true, reason: 'disabled' };
      }

      const bundle = this.cache.getDeliveryBundle();
      const feedResults = {};
      let anyUploaded = false;
      let lastHighlights = [];
      const githubFeeds = {};

      for (const cfg of configs) {
        const feedKey = this._highlightFeedKey(cfg);
        const sourceManager = new HighlightManager({
          retentionDays: Number(cfg.retentionDays ?? cfg.recentDays ?? 7),
        });
        const previousDelivery =
          this.cache.getDelivery(feedKey) ||
          (feedKey === 'highlight1' ? this.cache.getDelivery('highlight') : null);
        let existing = [...sourceManager.extractList(previousDelivery)];
        if (!existing.length && feedKey === 'highlight1') {
          existing = [...sourceManager.extractList(this.cache.getCurrent())];
        }

        let scraped = [];
        try {
          const existingById = new Map(
            existing
              .filter((h) => h && h.id != null)
              .map((h) => [String(h.id), h])
          );
          const skipEnrichIds = force
            ? new Set()
            : new Set(
                existing
                  .filter(
                    (h) =>
                      h &&
                      h.id != null &&
                      String(h.m3u8 || h.embed_url || h.embedUrl || '').trim()
                  )
                  .map((h) => String(h.id))
              );

          const source = new HighlightSource({
            config: { ...cfg, recentDays: sourceManager.retentionDays },
            browserManager: this.browser,
          });
          const collectMs = Number(
            cfg.collectTimeoutMs ||
              (feedKey === 'highlight1'
                ? process.env.HIGHLIGHT1_TIMEOUT_MS || 90000
                : process.env.HIGHLIGHT2_TIMEOUT_MS || 180000)
          );
          scraped = await Promise.race([
            source.collect({
              extractM3u8: true,
              skipEnrichIds,
            }),
            new Promise((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `${cfg.name} timed out after ${collectMs}ms — continuing to next highlight source`
                    )
                  ),
                collectMs
              );
            }),
          ]);
          scraped = scraped.map((h) => {
            const prev = existingById.get(String(h.id || ''));
            if (!prev) return h;
            return {
              ...h,
              m3u8: h.m3u8 || prev.m3u8 || null,
              embedUrl: h.embedUrl || prev.embedUrl || prev.embed_url || null,
              headers: h.headers || prev.headers || null,
            };
          });
          logEvent(events.SCRAPER_SUCCESS, `${cfg.name} scrape completed`, {
            feed: feedKey,
            totalHighlightsFound: scraped.length,
            withM3u8: scraped.filter((h) => h.m3u8).length,
            skippedEnrich: skipEnrichIds.size,
          });
        } catch (err) {
          logEvent(events.SCRAPER_ERROR, `${cfg.name} scrape failed — keep previous data`, {
            feed: feedKey,
            error: err.message,
          });
          if (this.admin?.sources) this.admin.sources.recordError(cfg.name, err.message);
          feedResults[feedKey] = { ok: false, reason: 'scrape_failed', error: err.message };
          try {
            await this.browser.close();
          } catch {
            // ignore
          }
          continue;
        }

        if (!scraped.length && existing.length) {
          logger.warn(`${cfg.name} scrape empty — keep previous ${feedKey}.json`);
          feedResults[feedKey] = { ok: true, reason: 'empty_scrape_keep_previous' };
          continue;
        }
        if (!scraped.length && !existing.length) {
          feedResults[feedKey] = { ok: false, reason: 'empty' };
          continue;
        }

        const { highlights, stats } = sourceManager.merge({
          existing,
          scraped,
          retentionDays: sourceManager.retentionDays,
        });
        if (!highlights.length && existing.length) {
          feedResults[feedKey] = { ok: false, reason: 'refuse_empty' };
          continue;
        }

        const nextDelivery = sourceManager.buildDelivery(highlights, {
          source: (cfg.domains && cfg.domains[0]) || '',
          scraped_at: new Date().toISOString(),
        });
        bundle[feedKey] = nextDelivery;
        if (feedKey === 'highlight1') {
          lastHighlights = highlights;
        }

        let github = { uploaded: false, reason: 'unchanged' };
        try {
          github = await this.github.uploadJsonIfChanged(this.github.paths[feedKey], nextDelivery, {
            previousLocal: previousDelivery,
            feedKey,
          });
          if (github.uploaded) {
            anyUploaded = true;
            logEvent(events.GITHUB_UPLOAD, `${feedKey} updated successfully.`, {
              commit: github.commit,
              count: nextDelivery.count,
            });
          } else if (github.reason === 'unchanged') {
            logEvent(
              events.GITHUB_SKIPPED,
              `No ${feedKey} changes on GitHub. Upload skipped.`
            );
          }
        } catch (err) {
          github = { uploaded: false, reason: 'github_error', error: err.message };
          logEvent(events.SCRAPER_ERROR, `${feedKey} GitHub upload failed`, {
            error: err.message,
          });
        }
        githubFeeds[feedKey] = github;
        await getGithubMonitor().inspectResult(github).catch(() => {});

        if (this.admin?.sources) {
          this.admin.sources.recordSuccess(
            cfg.name,
            highlights.filter((h) => h.m3u8).length
          );
        }
        feedResults[feedKey] = {
          ok: true,
          reason: github.uploaded ? 'updated' : github.reason,
          uploaded: Boolean(github.uploaded),
          stats,
          count: nextDelivery.count,
        };
      }

      this.cache.saveDeliveryBundle(bundle);
      if (lastHighlights.length) {
        const current = this.cache.getCurrent();
        if (current) {
          this.cache.saveGenerated({
            ...current,
            highlights: lastHighlights,
            highlightCount: lastHighlights.length,
          });
        }
      }

      const anyOk = Object.values(feedResults).some((r) => r.ok);
      this.lastHighlightRun = {
        ok: anyOk,
        reason: anyUploaded ? 'updated' : 'completed',
        uploaded: anyUploaded,
        feeds: feedResults,
        github: { uploaded: anyUploaded, feeds: githubFeeds },
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };
      logEvent(events.SCRAPER_SUCCESS, 'Highlight job completed', this.lastHighlightRun);
      return {
        ok: anyOk,
        uploaded: anyUploaded,
        feeds: feedResults,
        github: this.lastHighlightRun.github,
      };
    } catch (err) {
      logEvent(events.SCRAPER_ERROR, 'Highlight job fatal error', { error: err.message });
      this.lastHighlightRun = {
        ok: false,
        reason: err.message,
        at: new Date().toISOString(),
      };
      return { ok: false, reason: err.message };
    } finally {
      this.highlightRunning = false;
      this._highlightSince = 0;
      await this._drainQueuedJobs().catch((err) => {
        logger.error('Queued job drain failed', { error: err.message });
      });
      if (!this.running && !this.channelsRunning && !this.tipsRunning) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Dedicated Myanmar TV channels job (stream tokens expire in ~10 minutes).
   * scrape → GitHub. Never overwrite with empty on failure.
   * If football/highlight/tips is running, queue and run when that job finishes.
   */
  async runMyanmarTv({ force = false } = {}) {
    this._clearStuckJobLocks();
    if (!mayRunLowPriorityHeavyJob(null, { force })) {
      this._pendingMyanmarTv = false;
      logger.info('Peak football window — skip MyanmarTV (no backlog)');
      return { ok: false, reason: 'peak_window' };
    }
    if (this.channelsRunning) {
      logger.warn('MyanmarTV job already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    if (this.running) {
      this._pendingMyanmarTv = true;
      logger.warn('Pipeline active — queue MyanmarTV job');
      return { ok: false, reason: 'pipeline_running', queued: true };
    }
    if (this.highlightRunning) {
      this._pendingMyanmarTv = true;
      logger.warn('Highlight job active — queue MyanmarTV job');
      return { ok: false, reason: 'highlight_running', queued: true };
    }
    if (this.tipsRunning) {
      this._pendingMyanmarTv = true;
      logger.warn('Tips job active — queue MyanmarTV job');
      return { ok: false, reason: 'tips_running', queued: true };
    }

    this.channelsRunning = true;
    this._channelsSince = Date.now();
    const startedAt = Date.now();
    logEvent(events.SCRAPER_START, 'MyanmarTV scraper started', {
      force,
      timezone: 'Asia/Yangon',
    });

    try {
      const config = await this.configLoader.load(true);
      if (!this._isSourceEnabled(config.sources, 'myanmartv')) {
        logger.info('MyanmarTV source disabled — skip');
        return { ok: true, reason: 'disabled' };
      }

      const cfg = this.configLoader.getSourceConfig(config.sources, 'myanmartv') || {
        name: 'myanmartv',
        domains: ['https://www.myanmartvchannels.com/'],
      };

      const previousDelivery = this.cache.getDelivery('myanmartv');
      const previousList = Array.isArray(previousDelivery)
        ? previousDelivery
        : this.cache.getCurrent()?.channels || [];

      let scraped = [];
      try {
        const tv = new MyanmarTvSource({ config: cfg, browserManager: this.browser });
        const collectMs = Number(process.env.MYANMARTV_TIMEOUT_MS || 120000);
        scraped = await Promise.race([
          tv.collect(),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error(`MyanmarTV collect timeout after ${collectMs}ms`)),
              collectMs
            );
          }),
        ]);
        logEvent(events.SCRAPER_SUCCESS, 'MyanmarTV scrape completed', {
          count: scraped.length,
          withStream: scraped.filter((c) => c.streamUrl).length,
        });
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'MyanmarTV scrape failed — keep previous data', {
          error: err.message,
        });
        if (this.admin?.sources) this.admin.sources.recordError('myanmartv', err.message);
        this.lastChannelsRun = {
          ok: false,
          reason: 'scrape_failed',
          error: err.message,
          at: new Date().toISOString(),
        };
        return {
          ok: false,
          reason: 'scrape_failed',
          kept: previousDelivery,
          error: err.message,
        };
      }

      if (!scraped.length && !previousList.length) {
        logger.warn('MyanmarTV scrape returned empty and no previous data — skip upload');
        return { ok: false, reason: 'empty', uploaded: false };
      }

      if (!scraped.length && previousList.length) {
        logger.warn('MyanmarTV scrape returned empty — keep previous myanmartv.json');
        logEvent(events.GITHUB_SKIPPED, 'No MyanmarTV changes detected. GitHub upload skipped.', {
          reason: 'empty_scrape_keep_previous',
        });
        this.lastChannelsRun = {
          ok: true,
          reason: 'empty_scrape_keep_previous',
          at: new Date().toISOString(),
        };
        return { ok: true, reason: 'empty_scrape_keep_previous', uploaded: false };
      }

      scraped = this._keepPreviousChannelStreams(scraped, previousList);

      const nextDelivery = formatChannelsDelivery(scraped);

      const changed = force || hasDataChanged(previousDelivery, nextDelivery);
      if (!changed) {
        logEvent(
          events.GITHUB_SKIPPED,
          'No MyanmarTV changes detected. GitHub upload skipped.'
        );
        this.lastChannelsRun = {
          ok: true,
          reason: 'unchanged',
          uploaded: false,
          count: nextDelivery.length,
          at: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
        return {
          ok: true,
          reason: 'unchanged',
          uploaded: false,
          delivery: nextDelivery,
        };
      }

      const bundle = this.cache.getDeliveryBundle();
      bundle.myanmartv = nextDelivery;
      this.cache.saveDeliveryBundle(bundle);

      const current = this.cache.getCurrent();
      if (current) {
        this.cache.saveGenerated({
          ...current,
          channels: scraped,
          channelCount: scraped.length,
        });
      }

      let github = { uploaded: false, reason: 'not_configured' };
      try {
        github = await this.github.uploadJsonIfChanged(
          this.github.paths.myanmartv,
          nextDelivery,
          { previousLocal: previousDelivery, feedKey: 'myanmartv' }
        );
        if (github.uploaded) {
          logEvent(events.GITHUB_UPLOAD, 'MyanmarTV channels updated successfully.', {
            commit: github.commit,
            count: nextDelivery.length,
          });
        } else if (github.reason === 'unchanged') {
          logEvent(
            events.GITHUB_SKIPPED,
            'No MyanmarTV changes detected. GitHub upload skipped.'
          );
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'MyanmarTV GitHub upload failed', {
          error: err.message,
        });
        github = { uploaded: false, reason: 'github_error', error: err.message };
      }
      await getGithubMonitor().inspectResult(github).catch(() => {});

      if (this.admin?.sources) {
        this.admin.sources.recordSuccess(
          'myanmartv',
          scraped.filter((c) => c.streamUrl).length
        );
      }

      this.lastChannelsRun = {
        ok: true,
        reason: github.uploaded ? 'updated' : github.reason,
        uploaded: Boolean(github.uploaded),
        count: nextDelivery.length,
        github,
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };

      logEvent(events.SCRAPER_SUCCESS, 'MyanmarTV job completed', this.lastChannelsRun);
      return {
        ok: true,
        uploaded: Boolean(github.uploaded),
        delivery: nextDelivery,
        github,
      };
    } catch (err) {
      logEvent(events.SCRAPER_ERROR, 'MyanmarTV job fatal error', { error: err.message });
      this.lastChannelsRun = {
        ok: false,
        reason: err.message,
        at: new Date().toISOString(),
      };
      return { ok: false, reason: err.message };
    } finally {
      this.channelsRunning = false;
      this._channelsSince = 0;
      await this._drainQueuedJobs().catch((err) => {
        logger.error('Queued job drain failed', { error: err.message });
      });
      if (!this.running && !this.highlightRunning && !this.tipsRunning) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async _drainQueuedJobs() {
    if (this._drainingQueued) return;
    this._drainingQueued = true;
    try {
      for (;;) {
        if (this.running || this.highlightRunning || this.tipsRunning || this.channelsRunning) {
          return;
        }

        // Peak: never drain lower-priority scrapers (avoid Match resource steal / backlog).
        if (isFootballPeakWindow()) {
          if (this._pendingHighlights || this._pendingTips || this._pendingMyanmarTv) {
            logger.info('Peak window — dropping queued Highlights/Tips/MyanmarTV');
          }
          this._pendingHighlights = false;
          this._pendingTips = false;
          this._pendingMyanmarTv = false;
        }

        // P0 Matches first — never permanently starved behind lower jobs.
        if (this._pendingMatches) {
          const forceStreamCheck = this._pendingForceStreamCheck;
          this._pendingMatches = false;
          this._pendingForceStreamCheck = false;
          logger.info('Running queued Matches pipeline', { forceStreamCheck });
          const queuedResult = await this.run({ forceStreamCheck });
          // If this drain attempt was re-queued (lock contention), keep force flag.
          if (forceStreamCheck && queuedResult?.queued) {
            this._pendingForceStreamCheck = true;
          }
          continue;
        }

        // P1 → P2 → P3 (only outside peak)
        if (!isFootballPeakWindow()) {
          if (this._pendingHighlights) {
            this._pendingHighlights = false;
            logger.info('Running queued highlight job');
            await this.runHighlights({ force: false });
            continue;
          }
          if (this._pendingTips) {
            this._pendingTips = false;
            logger.info('Running queued tips job');
            await this.runTips({ force: false });
            continue;
          }
          if (this._pendingMyanmarTv) {
            this._pendingMyanmarTv = false;
            logger.info('Running queued MyanmarTV job');
            await this.runMyanmarTv({ force: false });
            continue;
          }
        }
        return;
      }
    } finally {
      this._drainingQueued = false;
    }
  }

  _keepPreviousChannelStreams(scraped, previousList) {
    const byTitle = new Map(
      (previousList || []).map((c) => [String(c.title || '').toLowerCase(), c])
    );
    return (scraped || []).map((c) => {
      if (c?.streamUrl) return c;
      const prev = byTitle.get(String(c?.title || '').toLowerCase());
      if (!prev?.streamUrl) return c;
      return {
        ...c,
        streamUrl: prev.streamUrl,
        headers: c.headers || prev.headers || null,
        active: true,
      };
    });
  }

  /**
   * Dedicated PredictZ tips job (today + tomorrow).
   * Axios first, Puppeteer if blocked. Never overwrite with empty on failure.
   */
  async runTips({ force = false } = {}) {
    this._clearStuckJobLocks();
    if (!mayRunLowPriorityHeavyJob(null, { force })) {
      this._pendingTips = false;
      logger.info('Peak football window — skip Tips (no backlog)');
      return { ok: false, reason: 'peak_window' };
    }
    if (this.tipsRunning) {
      logger.warn('Tips job already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    if (this.running) {
      this._pendingTips = true;
      logger.warn('Pipeline active — queue tips job');
      return { ok: false, reason: 'pipeline_running', queued: true };
    }
    if (this.highlightRunning) {
      this._pendingTips = true;
      logger.warn('Highlight job active — queue tips job');
      return { ok: false, reason: 'highlight_running', queued: true };
    }
    if (this.channelsRunning) {
      this._pendingTips = true;
      logger.warn('MyanmarTV job active — queue tips job');
      return { ok: false, reason: 'channels_running', queued: true };
    }

    this.tipsRunning = true;
    this._tipsSince = Date.now();
    const startedAt = Date.now();
    logEvent(events.SCRAPER_START, 'PredictZ tips scraper started', {
      force,
      timezone: 'Asia/Yangon',
    });

    try {
      const config = await this.configLoader.load(true);
      if (!this._isSourceEnabled(config.sources, 'tips')) {
        logger.info('Tips source disabled — skip');
        return { ok: true, reason: 'disabled' };
      }

      const cfg = this.configLoader.getSourceConfig(config.sources, 'tips') || {
        name: 'tips',
        domains: ['https://www.predictz.com/'],
      };

      const previousDelivery = this.cache.getDelivery('tips');

      let scraped = null;
      try {
        const source = new TipsSource({ config: cfg, browserManager: this.browser });
        const collectMs = Number(process.env.TIPS_TIMEOUT_MS || 180000);
        scraped = await Promise.race([
          source.collect(),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error(`Tips collect timeout after ${collectMs}ms`)),
              collectMs
            );
          }),
        ]);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Tips scrape failed — keep previous data', {
          error: err.message,
        });
        if (this.admin?.sources) this.admin.sources.recordError('tips', err.message);
        this.lastTipsRun = {
          ok: false,
          reason: 'scrape_failed',
          error: err.message,
          at: new Date().toISOString(),
        };
        return {
          ok: false,
          reason: 'scrape_failed',
          kept: previousDelivery,
          error: err.message,
        };
      }

      const nextDelivery = formatTipsDelivery(scraped);
      if (!nextDelivery.count && previousDelivery?.count) {
        logger.warn('Tips scrape returned empty — keep previous tips.json');
        logEvent(events.GITHUB_SKIPPED, 'No tips changes detected. GitHub upload skipped.', {
          feed: 'tips',
        });
        return { ok: true, reason: 'empty_keep_previous', kept: previousDelivery };
      }

      if (!nextDelivery.count && !previousDelivery?.count) {
        logger.warn('Tips scrape returned empty and no previous data — skip upload');
        return { ok: false, reason: 'empty', uploaded: false };
      }

      const bundle = this.cache.getDeliveryBundle();
      bundle.tips = nextDelivery;
      this.cache.saveDeliveryBundle(bundle);

      let github = { uploaded: false, reason: 'skipped' };
      try {
        github = await this.github.uploadJsonIfChanged(this.github.paths.tips, nextDelivery, {
          previousLocal: previousDelivery,
          feedKey: 'tips',
        });
        if (!github.uploaded) {
          logEvent(
            events.GITHUB_SKIPPED,
            github.reason === 'unchanged'
              ? 'No tips changes detected. GitHub upload skipped.'
              : `Tips GitHub skipped (${github.reason})`
          );
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Tips GitHub upload failed', { error: err.message });
        github = { uploaded: false, reason: 'github_error', error: err.message };
      }
      await getGithubMonitor().inspectResult(github).catch(() => {});

      if (this.admin?.sources) {
        this.admin.sources.recordSuccess('tips', nextDelivery.count);
      }

      this.lastTipsRun = {
        ok: true,
        uploaded: Boolean(github.uploaded),
        today: nextDelivery.today.count,
        tomorrow: nextDelivery.tomorrow.count,
        count: nextDelivery.count,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      };

      logEvent(events.SCRAPER_SUCCESS, 'Tips job completed', this.lastTipsRun);
      return {
        ok: true,
        uploaded: Boolean(github.uploaded),
        delivery: nextDelivery,
        github,
      };
    } catch (err) {
      logEvent(events.SCRAPER_ERROR, 'Tips job fatal error', { error: err.message });
      this.lastTipsRun = {
        ok: false,
        reason: err.message,
        at: new Date().toISOString(),
      };
      return { ok: false, reason: err.message };
    } finally {
      this.tipsRunning = false;
      this._tipsSince = 0;
      await this._drainQueuedJobs().catch((err) => {
        logger.error('Queued job drain failed', { error: err.message });
      });
      if (!this.running && !this.highlightRunning && this.channelsRunning === false) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

module.exports = { Pipeline };

