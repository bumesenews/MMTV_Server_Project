const { logger, logEvent, events } = require('../utils/logger');
const { Normalizer } = require('../utils/normalize');
const { PuppeteerManager } = require('../browser/puppeteerManager');
const { ConfigLoader } = require('./configLoader');
const { FixtureService } = require('./fixtureService');
const { StreamEngine } = require('./streamEngine');
const { CacheService } = require('./cacheService');
const { GitHubService } = require('./githubService');
const { generateFlutterJson } = require('./jsonGenerator');
const { buildDeliveryBundle } = require('./deliveryFormats');
const { MatchMerger } = require('./matchMerger');
const { SocoSource } = require('../sources/soco');
const { HighlightSource } = require('../sources/highlight');
const { MyanmarTvSource } = require('../sources/myanmartv');
const { buildEngineStreamingSources } = require('../sources/registry');
const { HighlightManager } = require('./highlightManager');

/**
 * Main AWS processing pipeline:
 * Load config → FotMob fixtures → filter/normalize → discover streams →
 * validate → merge → status → apply admin overrides → Flutter JSON →
 * compare → GitHub if changed
 *
 * Highlights run on a separate 3-hour schedule via runHighlights().
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

      const fixtureService = new FixtureService({
        config: fotmobConfig,
        normalizer: this.normalizer,
      });

      let fixtures;
      try {
        fixtures = await fixtureService.collect();
        if (this.admin?.leagues) {
          fixtures = this.admin.leagues.filterMatches(fixtures);
        }
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
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.running = false;
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
      const full = await soco.scrapeFull({ fetchStreams: true });
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
   * Highlights are scraped on a dedicated 3-hour schedule (runHighlights).
   * Main pipeline only reuses/prunes the last successful store — no Hoofoot HTTP each tick.
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

    const extras = {
      highlights: pruned.highlights,
      channels: previous?.channels || [],
    };

    if (this._isSourceEnabled(sourcesDoc, 'myanmartv')) {
      try {
        const cfg = this.configLoader.getSourceConfig(sourcesDoc, 'myanmartv') || {
          name: 'myanmartv',
          domains: ['https://www.myanmartvchannels.com/'],
        };
        const tv = new MyanmarTvSource({ config: cfg });
        extras.channels = await tv.collect();
        if (this.admin?.sources) {
          this.admin.sources.recordSuccess(
            'myanmartv',
            extras.channels.filter((c) => c.streamUrl).length
          );
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'MyanmarTV scrape failed — keep previous', {
          error: err.message,
        });
        if (this.admin?.sources) this.admin.sources.recordError('myanmartv', err.message);
      }
    }

    return extras;
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
        // Only skip embed/m3u8 work when we already have a playable URL cached
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

        // Re-attach cached media onto items we skipped enriching
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
        // Never overwrite with empty on failure
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

      // Scrape returned nothing but we have history — keep previous (site glitch)
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

      // Persist local delivery + sync highlights into current.json
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
      // Keep browser alive if main pipeline may still need it; close only when idle
      if (!this.running) {
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
