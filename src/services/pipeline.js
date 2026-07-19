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

/**
 * Main AWS processing pipeline:
 * Load config → FotMob fixtures → filter/normalize → discover streams →
 * validate → merge → status → apply admin overrides → Flutter JSON →
 * compare → GitHub if changed
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
    this.lastRun = null;
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

  async _collectExtraContent(sourcesDoc, previous) {
    const extras = {
      highlights: previous?.highlights || [],
      channels: previous?.channels || [],
    };

    if (this._isSourceEnabled(sourcesDoc, 'highlight')) {
      try {
        const cfg = this.configLoader.getSourceConfig(sourcesDoc, 'highlight') || {
          name: 'highlight',
          domains: ['https://hoofoot.com/'],
        };
        const highlight = new HighlightSource({
          config: cfg,
          browserManager: this.browser,
        });
        extras.highlights = await highlight.collect({ extractM3u8: true });
        if (this.admin?.sources) {
          this.admin.sources.recordSuccess(
            'highlight',
            extras.highlights.filter((h) => h.m3u8).length
          );
        }
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Highlight scrape failed — keep previous', {
          error: err.message,
        });
        if (this.admin?.sources) this.admin.sources.recordError('highlight', err.message);
      }
    }

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
}

module.exports = { Pipeline };
