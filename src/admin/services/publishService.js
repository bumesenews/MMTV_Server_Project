const { generateFlutterJson } = require('../../services/jsonGenerator');
const { buildDeliveryBundle } = require('../../services/deliveryFormats');
const { priorityMapFromSourcesDoc } = require('../../sources/registry');
const { getGithubMonitor } = require('../../monitor/github.monitor');
const { enrichMatchState } = require('../../services/statusService');
const { resolveLeagueIcon } = require('../../utils/fotmobLogos');
const {
  syncMatchesForDelivery,
  readExistingMatches,
} = require('../../services/matchesSyncService');

/**
 * Applies admin overrides + league filters, writes local cache, uploads GitHub if changed.
 * Publishes Flutter feeds: matches, highlight, myanmartv.
 * mainlive.json is published separately via publishMainLive().
 *
 * matches.json sync before save/GitHub:
 * - read existing delivery matches
 * - drop expired (kickoff + 2h)
 * - merge newly found valid stream URLs
 * - GitHub PUT only when content actually changed
 */
class PublishService {
  constructor({
    cache,
    github,
    overrideService,
    leagueAdminService,
    manualMatchService = null,
    mainLiveService = null,
    teamAdminService = null,
    logService = null,
    normalizer = null,
  }) {
    this.cache = cache;
    this.github = github;
    this.overrides = overrideService;
    this.leagues = leagueAdminService;
    this.manualMatches = manualMatchService;
    this.mainLive = mainLiveService;
    this.teams = teamAdminService;
    this.logService = logService;
    this.normalizer = normalizer;
    this.lastGithub = null;
  }

  /**
   * Publish admin-owned mainlive.json only (does not touch matches).
   */
  async publishMainLive({ actor = 'admin' } = {}) {
    if (!this.mainLive) {
      return { ok: false, reason: 'mainlive_not_configured' };
    }

    const delivery = { mainlive: this.mainLive.toDeliveryPayload() };
    const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);

    let github = { uploaded: false, reason: 'local_unchanged', feeds: {} };
    try {
      github = await this.github.uploadDeliveryBundle(delivery, prevDelivery, {
        allowEmptyFeeds: ['mainlive'],
      });
      this.lastGithub = { ...github, at: new Date().toISOString() };
    } catch (err) {
      github = {
        uploaded: false,
        reason: 'github_error',
        error: err.message,
        hint: err.hint || null,
        status: err.status || null,
        feeds: {},
      };
      this.lastGithub = { ...github, at: new Date().toISOString() };
      if (this.logService) {
        this.logService.add({
          category: 'github',
          action: 'upload_failed',
          message: err.message,
          actor,
          meta: { feed: 'mainlive', ...github },
        });
      }
    }

    await getGithubMonitor().inspectResult(github).catch(() => {});

    if (this.logService) {
      this.logService.add({
        category: 'github',
        action: github.uploaded ? 'upload' : 'skip',
        message: `Publish mainlive.json matches=${delivery.mainlive.matchCount} (github: ${github.reason}${github.error ? ` - ${github.error}` : ''})`,
        actor,
        meta: { github, feed: 'mainlive' },
      });
    }

    return {
      ok: true,
      delivery: delivery.mainlive,
      github,
      warning: github.reason === 'github_error' ? github.error : null,
    };
  }

  /**
   * @param {object[]} matches - raw/scraper matches (or current cache matches)
   * @param {object} meta
   * @param {object} extras - { highlights, channels }
   */
  async publish(matches, meta = {}, { actor = 'system', extras = {} } = {}) {
    let merged = this.manualMatches
      ? this.manualMatches.mergeInto(matches || [])
      : matches || [];

    // Fill league icons / team logos from admin catalogs when missing
    merged = merged.map((m) => {
      const repaired = this.normalizer?.repairMatchLeague
        ? this.normalizer.repairMatchLeague(m)
        : m;
      const leagueIcon =
        repaired.leagueIcon ||
        this.leagues.getIcon?.(repaired.league) ||
        resolveLeagueIcon(repaired);
      const homeLogo =
        repaired.homeLogo || this.teams?.findLogo?.(repaired.homeTeam) || null;
      const awayLogo =
        repaired.awayLogo || this.teams?.findLogo?.(repaired.awayTeam) || null;
      return { ...repaired, leagueIcon, homeLogo, awayLogo };
    });

    const filteredLeagues = this.leagues.filterMatches(merged);
    // Kickoff-window status (Scheduled / PREPARING_STREAM / LIVE / END)
    const statusFixed = (filteredLeagues || []).map((m) => enrichMatchState(m));
    const priorityMap = priorityMapFromSourcesDoc(meta.sourcesDoc || null);
    const withOverrides = this.overrides.applyToMatches(statusFixed, priorityMap);

    const previous = this.cache.getCurrent();
    const existingMatches = readExistingMatches(this.cache);

    // Sync vs matches.json: expire kickoff+2h, merge new valid streams
    const sync = syncMatchesForDelivery(existingMatches, withOverrides, {
      normalizer: this.normalizer,
    });

    const extrasMerged = {
      highlights: extras.highlights ?? previous?.highlights ?? [],
      channels: extras.channels ?? previous?.channels ?? [],
    };

    // Do not embed full sources.json (domains/selectors/attrs) into matches.json —
    // that config already lives in GitHub config/sources.json.
    const { sourcesDoc: _omitSourcesDoc, ...publicMeta } = meta || {};

    const payload = generateFlutterJson(
      sync.matches,
      {
        ...publicMeta,
        adminApplied: true,
        sync: {
          removedExpired: sync.removedExpired,
          streamsAdded: sync.streamsAdded,
          matchesAdded: sync.matchesAdded,
        },
      },
      extrasMerged
    );

    // Refuse accidental empty scrape overwrite — allow intentional expiry cleanup
    const intentionalEmptyCleanup =
      sync.removedExpired > 0 && sync.matches.length === 0;
    if (
      this.cache.isEmptyPayload(payload) &&
      previous?.matches?.length &&
      !intentionalEmptyCleanup
    ) {
      return {
        ok: false,
        reason: 'refuse_empty',
        payload: previous,
        changed: false,
        github: { uploaded: false, reason: 'refuse_empty' },
      };
    }

    const { changed, payload: cached } = this.cache.saveGenerated(payload);

    const delivery = buildDeliveryBundle({
      matchesPayload: cached,
      highlights: extrasMerged.highlights,
      channels: extrasMerged.channels,
    });

    const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);

    // GitHub REST PUT only when matches (or other feeds) actually changed
    let github = { uploaded: false, reason: 'local_unchanged', feeds: {} };
    try {
      github = await this.github.uploadDeliveryBundle(delivery, prevDelivery);
      this.lastGithub = { ...github, at: new Date().toISOString() };
    } catch (err) {
      github = {
        uploaded: false,
        reason: 'github_error',
        error: err.message,
        hint: err.hint || null,
        status: err.status || null,
        feeds: {},
      };
      this.lastGithub = { ...github, at: new Date().toISOString() };
      if (this.logService) {
        this.logService.add({
          category: 'github',
          action: 'upload_failed',
          message: err.message,
          actor,
          meta: github,
        });
      }
    }

    await getGithubMonitor().inspectResult(github).catch(() => {});

    if (this.logService) {
      this.logService.add({
        category: 'github',
        action: github.uploaded ? 'upload' : 'skip',
        message: `Publish feeds matches=${cached.matches.length} highlights=${delivery.highlight.count} channels=${delivery.myanmartv.length} (github: ${github.reason}${github.error ? ` - ${github.error}` : ''})`,
        actor,
        meta: { changed, github },
      });
    }

    return {
      ok: true,
      payload: cached,
      delivery,
      changed,
      github,
      warning: github.reason === 'github_error' ? github.error : null,
    };
  }

  /**
   * Re-publish from current cache matches (after admin edits).
   */
  async republishFromCache({ actor = 'admin', meta = {} } = {}) {
    const current = this.cache.getCurrent();
    const matches = current?.matches || [];
    return this.publish(
      matches,
      {
        ...(current?.meta || {}),
        ...meta,
        republishedAt: new Date().toISOString(),
      },
      {
        actor,
        extras: {
          highlights: current?.highlights || [],
          channels: current?.channels || [],
        },
      }
    );
  }
}

module.exports = { PublishService };
