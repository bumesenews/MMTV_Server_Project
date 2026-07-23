const { logger, logEvent, events } = require('../utils/logger');
const { Normalizer } = require('../utils/normalize');
const { todayYangon, isTodayOrTomorrow } = require('../utils/time');
const { PuppeteerManager } = require('../browser/puppeteerManager');
const { ConfigLoader } = require('./configLoader');
const { FixtureService } = require('./fixtureService');
const { StreamEngine } = require('./streamEngine');
const { CacheService } = require('./cacheService');
const { GitHubService } = require('./githubService');
const { generateFlutterJson } = require('./jsonGenerator');
const { buildDeliveryBundle, formatChannelsDelivery } = require('./deliveryFormats');
const { MatchMerger } = require('./matchMerger');
const { enrichMatchState } = require('./statusService');
const { hasDataChanged } = require('../utils/compare');
const { SocoSource } = require('../sources/soco');
const { HighlightSource } = require('../sources/highlight');
const { MyanmarTvSource } = require('../sources/myanmartv');
const { buildEngineStreamingSources } = require('../sources/registry');
const { HighlightManager } = require('./highlightManager');

/**
 * Main AWS processing pipeline (matches.json):
 * Load config → FotMob fixtures once/day (today+tomorrow) →
 * stream find at T−30m / retry T−15m → status from fixture kickoff
 * (LIVE until +120m, then END + drop streams) → Flutter JSON → GitHub
 *
 * Separate jobs:
 * - Highlights every 3 hours (runHighlights)
 * - Myanmar TV channels every 12 hours (runMyanmarTv)
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
    this.running = false;
    this.highlightRunning = false;
    this.lastRun = null;
    this.lastHighlightRun = null;
    this.lastChannelsRun = null;
    this.channelsRunning = false;
    /** FotMob fixtures cached once per Yangon calendar day (today + tomorrow). */
    this.fixtureCache = { dayKey: null, fixtures: [] };
  }

  attachAdmin(admin) {
    this.admin = admin;
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

  async run({ forceStreamCheck = false } = {}) {
    if (this.running) {
      logger.warn('Pipeline already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    // Never share Chromium / heavy work with highlight or MyanmarTV jobs on 1GB hosts
    if (this.highlightRunning) {
      logger.warn('Highlight job active — skip pipeline to avoid OOM');
      return { ok: false, reason: 'highlight_running' };
    }
    if (this.channelsRunning) {
      logger.warn('MyanmarTV job active — skip pipeline');
      return { ok: false, reason: 'channels_running' };
    }

    this.running = true;
    const startedAt = Date.now();
    logEvent(events.SCRAPER_START, 'Pipeline start');

    try {
      const config = await this.configLoader.load(true);
      let leagues = config.leagues?.allowedLeagues || config.leagues?.leagues || [];
      if (this.admin?.leagues) {
        leagues = this.admin.leagues.filterAllowedLeagueDefs(leagues);
      }
      const teams = config.teams?.teams || [];
      this.normalizer.reload({ leagues, teams });

      const fotmobConfig = this.configLoader.getSourceConfig(config.sources, 'fotmob') || {
        name: 'fotmob',
        domains: ['https://www.fotmob.com'],
        api: { matches: 'https://www.fotmob.com/api/data/matches' },
      };

      let fixtures;
      try {
        fixtures = await this._collectFixturesOncePerDay(fotmobConfig, {
          force: forceStreamCheck,
        });
        if (this.admin?.leagues) {
          fixtures = this.admin.leagues.filterMatches(fixtures);
        }
        // Carry forward streams/sourcePages from previous matches.json
        fixtures = this._mergePreviousMatchState(fixtures);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Fixture collection failed — keep previous data', {
          error: err.message,
        });
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
      const engine = new StreamEngine({ sources: streamingSources });

      let matches;
      try {
        matches = await engine.collectForFixtures(fixtures, { force: forceStreamCheck });
        this._recordSourceStats(matches);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Stream engine failed — fixtures only payload', {
          error: err.message,
        });
        matches = fixtures;
      }

      // Soco (socolivemm.io) — full scrape for soco.json + merge into main live
      const previous = this.cache.getCurrent();
      const socoResult = await this._scrapeSocoFull(matches, config.sources);
      matches = socoResult.matches;

      // Highlights + Myanmar TV channels
      const extras = await this._collectExtraContent(config.sources, previous);
      extras.socoMatches = socoResult.socoMatches;

      const sourceNames = [
        ...streamingSources.map((s) => s.name),
        ...(this._isSourceEnabled(config.sources, 'soco') ? ['soco'] : []),
        ...(this._isSourceEnabled(config.sources, 'highlight') ? ['highlight'] : []),
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

      // Fallback without admin context
      const payload = generateFlutterJson(
        matches,
        {
          configOrigin: config.origin,
          sources: sourceNames,
        },
        extras
      );
      const previousCache = this.cache.getCurrent();
      if (this.cache.isEmptyPayload(payload) && previousCache?.matches?.length) {
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
        socoMatches: extras.socoMatches || [],
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
      const kept = this.cache.keepPreviousOnFailure();
      this.lastRun = {
        ok: false,
        reason: err.message,
        at: new Date().toISOString(),
      };
      return { ok: false, reason: err.message, kept };
    } finally {
      this.running = false;
      // Only tear down Chromium when no other scrape owns it
      if (!this.highlightRunning && !this.channelsRunning) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * FotMob fixtures: today + tomorrow only, scraped once per Yangon calendar day.
   * force=true (CLI --force) refreshes fixtures immediately.
   */
  async _collectFixturesOncePerDay(fotmobConfig, { force = false } = {}) {
    const dayKey = todayYangon().toFormat('yyyy-MM-dd');
    if (
      !force &&
      this.fixtureCache.dayKey === dayKey &&
      Array.isArray(this.fixtureCache.fixtures) &&
      this.fixtureCache.fixtures.length
    ) {
      logger.info('Using cached FotMob fixtures (once per day)', {
        dayKey,
        count: this.fixtureCache.fixtures.length,
      });
      return this.fixtureCache.fixtures.map((f) => ({
        ...f,
        streams: [],
        streamAttempts: f.streamAttempts || {},
      }));
    }

    const fixtureService = new FixtureService({
      config: fotmobConfig,
      normalizer: this.normalizer,
    });
    const fixtures = await fixtureService.collect();
    const todayTomorrow = (fixtures || []).filter((f) => isTodayOrTomorrow(f.kickoff));

    this.fixtureCache = {
      dayKey,
      fixtures: todayTomorrow.map((f) => ({
        ...f,
        streams: [],
        streamAttempts: {},
      })),
    };

    logger.info('FotMob fixtures scraped (once per day)', {
      dayKey,
      count: this.fixtureCache.fixtures.length,
    });

    return this.fixtureCache.fixtures.map((f) => ({ ...f }));
  }

  /**
   * Re-attach streams / sourcePages / streamAttempts from previous matches.json
   * so fixture-only refreshes do not wipe discovered URLs.
   */
  _mergePreviousMatchState(fixtures) {
    const previous = this.cache.getCurrent()?.matches || [];
    const byId = new Map(previous.map((m) => [m.matchId, m]));

    return (fixtures || []).map((f) => {
      const prev = byId.get(f.matchId);
      if (!prev) return enrichMatchState(f);

      return enrichMatchState({
        ...f,
        streams: Array.isArray(prev.streams) ? prev.streams : [],
        sourcePages: { ...(prev.sourcePages || {}), ...(f.sourcePages || {}) },
        originalNames: { ...(prev.originalNames || {}), ...(f.originalNames || {}) },
        streamAttempts: { ...(prev.streamAttempts || {}), ...(f.streamAttempts || {}) },
        pinned: prev.pinned || f.pinned,
        featured: prev.featured || f.featured,
      });
    });
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
   * Full soco scrape for Flutter soco.json (leagues format) and merge into main live matches.
   */
  async _scrapeSocoFull(matches, sourcesDoc) {
    const empty = { matches, socoMatches: [] };
    if (!this._isSourceEnabled(sourcesDoc, 'soco')) return empty;

    const cfg = this.configLoader.getSourceConfig(sourcesDoc, 'soco') || {
      name: 'soco',
      enabled: true,
      domains: ['https://socolivemm.io'],
    };

    try {
      const soco = new SocoSource({ config: cfg, normalizer: this.normalizer });
      const full = await soco.scrapeFull({ fetchStreams: false });
      const socoMatches = full.matches || [];

      // Merge into FotMob fixtures when matchId aligns
      const merger = new MatchMerger();
      let next = matches;
      let streamCount = 0;
      for (const sm of socoMatches) {
        const streams = (sm.links || [])
          .filter((l) => l.url)
          .map((l) => ({
            source: 'soco',
            type: 'm3u8',
            quality: l.name || 'HD',
            url: l.url,
            headers: {
              'User-Agent': process.env.USER_AGENT || '',
              Referer: l.reffer || sm.matchUrl || '',
            },
            active: true,
            priority: Number(cfg.priority || 0),
            checkedAt: new Date().toISOString(),
          }));
        if (!streams.length) continue;
        streamCount += streams.length;
        const idx = next.findIndex((m) => m.matchId === sm.matchId);
        if (idx < 0) continue;
        next[idx] = merger.mergeMatch(next[idx], [
          {
            matchId: sm.matchId,
            source: 'soco',
            matchUrl: sm.matchUrl,
            streams,
            originalNames: sm.originalNames,
            sourceLive: sm.live || sm.status === 'LIVE',
          },
        ]);
      }

      if (this.admin?.sources) this.admin.sources.recordSuccess('soco', streamCount);
      logger.info('Soco full scrape merged', {
        socoMatches: socoMatches.length,
        streams: streamCount,
      });
      return { matches: next, socoMatches };
    } catch (err) {
      logEvent(events.SCRAPER_ERROR, 'Soco full scrape failed', { error: err.message });
      if (this.admin?.sources) this.admin.sources.recordError('soco', err.message);
      return empty;
    }
  }

  /**
   * Highlights: dedicated 3-hour job (runHighlights).
   * Myanmar TV: dedicated 12-hour job (runMyanmarTv).
   * Main pipeline only reuses last successful stores — no live scrape each tick.
   */
  async _collectExtraContent(sourcesDoc, previous) {
    const deliveryHighlight = this.cache.getDelivery('highlight');
    const manager = new HighlightManager({
      retentionDays: Number(
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

  /**
   * Dedicated Hoofoot highlight job (every 3 hours):
   * scrape → merge → dedupe → 7-day retention → compare → GitHub only if changed.
   */
  async runHighlights({ force = false } = {}) {
    if (this.highlightRunning) {
      logger.warn('Highlight job already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    if (this.running) {
      logger.warn('Pipeline active — skip highlight job to avoid OOM');
      return { ok: false, reason: 'pipeline_running' };
    }
    if (this.channelsRunning) {
      logger.warn('MyanmarTV job active — skip highlight job');
      return { ok: false, reason: 'channels_running' };
    }

    this.highlightRunning = true;
    const startedAt = Date.now();
    const manager = new HighlightManager({ retentionDays: 7 });

    logEvent(events.SCRAPER_START, 'Highlight scraper started', {
      force,
      timezone: 'Asia/Yangon',
    });

    try {
      const config = await this.configLoader.load(true);
      if (!this._isSourceEnabled(config.sources, 'highlight')) {
        logger.info('Highlight source disabled — skip');
        return { ok: true, reason: 'disabled' };
      }

      const cfg = this.configLoader.getSourceConfig(config.sources, 'highlight') || {
        name: 'highlight',
        domains: ['https://hoofoot.com/'],
        recentDays: 7,
        retentionDays: 7,
      };
      manager.retentionDays = Number(cfg.retentionDays ?? cfg.recentDays ?? 7);

      const previousDelivery = this.cache.getDelivery('highlight');
      let existing = [...manager.extractList(previousDelivery)];
      if (!existing.length) {
        existing = [...manager.extractList(this.cache.getCurrent())];
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
                .filter((h) => h && h.id != null && String(h.m3u8 || h.embed_url || h.embedUrl || '').trim())
                .map((h) => String(h.id))
            );

        const source = new HighlightSource({
          config: { ...cfg, recentDays: manager.retentionDays },
          browserManager: this.browser,
        });
        scraped = await source.collect({
          extractM3u8: true,
          skipEnrichIds,
        });

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

        logEvent(events.SCRAPER_SUCCESS, 'Highlight scrape completed', {
          totalHighlightsFound: scraped.length,
          withM3u8: scraped.filter((h) => h.m3u8).length,
          skippedEnrich: skipEnrichIds.size,
          force,
        });
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Highlight scrape failed — keep previous data', {
          error: err.message,
        });
        if (this.admin?.sources) this.admin.sources.recordError('highlight', err.message);
        this.lastHighlightRun = {
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

      if (!scraped.length && !existing.length) {
        logger.warn('Highlight scrape returned empty and no previous data — skip upload');
        return { ok: false, reason: 'empty', uploaded: false };
      }

      if (!scraped.length && existing.length) {
        logger.warn('Highlight scrape returned empty — keep previous highlights.json');
        logEvent(events.GITHUB_SKIPPED, 'No highlight changes detected. GitHub upload skipped.', {
          reason: 'empty_scrape_keep_previous',
        });
        this.lastHighlightRun = {
          ok: true,
          reason: 'empty_scrape_keep_previous',
          at: new Date().toISOString(),
        };
        return { ok: true, reason: 'empty_scrape_keep_previous', uploaded: false };
      }

      const { highlights, stats } = manager.merge({
        existing,
        scraped,
        retentionDays: manager.retentionDays,
      });

      logger.info('Highlight merge stats', {
        totalHighlightsFound: stats.scrapedCount,
        newHighlightsAdded: stats.newAdded,
        duplicateHighlightsRemoved: stats.duplicatesRemoved,
        oldHighlightsRemoved: stats.oldRemoved,
        totalAfterMerge: stats.totalAfterMerge,
      });

      if (!highlights.length && existing.length) {
        logger.warn('Merge produced empty highlights — refuse overwrite');
        logEvent(events.GITHUB_SKIPPED, 'No highlight changes detected. GitHub upload skipped.', {
          reason: 'refuse_empty',
        });
        return { ok: false, reason: 'refuse_empty', uploaded: false };
      }

      const nextDelivery = manager.buildDelivery(highlights, {
        source: (cfg.domains && cfg.domains[0]) || 'https://hoofoot.com/',
        scraped_at: new Date().toISOString(),
      });

      logger.info('JSON comparison', {
        feed: 'highlight',
        previousCount: previousDelivery?.count ?? existing.length,
        nextCount: nextDelivery.count,
      });

      const changed = force || manager.hasChanged(previousDelivery, nextDelivery);
      if (!changed) {
        logEvent(
          events.GITHUB_SKIPPED,
          'No highlight changes detected. GitHub upload skipped.'
        );
        this.lastHighlightRun = {
          ok: true,
          reason: 'unchanged',
          uploaded: false,
          stats,
          at: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
        return { ok: true, reason: 'unchanged', uploaded: false, stats, delivery: nextDelivery };
      }

      const bundle = this.cache.getDeliveryBundle();
      bundle.highlight = nextDelivery;
      this.cache.saveDeliveryBundle(bundle);

      const current = this.cache.getCurrent();
      if (current) {
        this.cache.saveGenerated({
          ...current,
          highlights,
          highlightCount: highlights.length,
        });
      }

      let github = { uploaded: false, reason: 'not_configured' };
      try {
        github = await this.github.uploadJsonIfChanged(
          this.github.paths.highlight,
          nextDelivery,
          { previousLocal: previousDelivery, feedKey: 'highlight' }
        );
        if (github.uploaded) {
          logEvent(events.GITHUB_UPLOAD, 'Highlights updated successfully.', {
            commit: github.commit,
            count: nextDelivery.count,
          });
        } else if (github.reason === 'unchanged') {
          logEvent(
            events.GITHUB_SKIPPED,
            'No highlight changes detected. GitHub upload skipped.'
          );
        } else if (github.reason === 'refuse_empty') {
          logger.warn('Highlight GitHub upload refused empty overwrite');
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Highlight GitHub upload failed', {
          error: err.message,
        });
        github = { uploaded: false, reason: 'github_error', error: err.message };
      }

      if (this.admin?.sources) {
        this.admin.sources.recordSuccess(
          'highlight',
          highlights.filter((h) => h.m3u8).length
        );
      }

      this.lastHighlightRun = {
        ok: true,
        reason: github.uploaded ? 'updated' : github.reason,
        uploaded: Boolean(github.uploaded),
        stats,
        github,
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };

      logEvent(events.SCRAPER_SUCCESS, 'Highlight job completed', this.lastHighlightRun);
      return {
        ok: true,
        uploaded: Boolean(github.uploaded),
        stats,
        delivery: nextDelivery,
        github,
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
      if (!this.running && !this.channelsRunning) {
        try {
          await this.browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Dedicated Myanmar TV channels job (every 12 hours):
   * scrape → compare → GitHub only if changed. Never overwrite with empty on failure.
   */
  async runMyanmarTv({ force = false } = {}) {
    if (this.channelsRunning) {
      logger.warn('MyanmarTV job already running — skip overlapping run');
      return { ok: false, reason: 'already_running' };
    }
    if (this.running) {
      logger.warn('Pipeline active — skip MyanmarTV job');
      return { ok: false, reason: 'pipeline_running' };
    }
    if (this.highlightRunning) {
      logger.warn('Highlight job active — skip MyanmarTV job');
      return { ok: false, reason: 'highlight_running' };
    }

    this.channelsRunning = true;
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
        const tv = new MyanmarTvSource({ config: cfg });
        scraped = await tv.collect();
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
    }
  }
}

module.exports = { Pipeline };

