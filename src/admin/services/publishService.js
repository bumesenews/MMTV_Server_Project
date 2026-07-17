const { generateFlutterJson } = require('../../services/jsonGenerator');
const { buildDeliveryBundle } = require('../../services/deliveryFormats');

/**
 * Applies admin overrides + league filters, writes local cache, uploads GitHub if changed.
 * Publishes four Flutter feeds: matches, soco, highlight, myanmartv.
 */
class PublishService {
  constructor({
    cache,
    github,
    overrideService,
    leagueAdminService,
    logService = null,
  }) {
    this.cache = cache;
    this.github = github;
    this.overrides = overrideService;
    this.leagues = leagueAdminService;
    this.logService = logService;
    this.lastGithub = null;
  }

  /**
   * @param {object[]} matches - raw/scraper matches (or current cache matches)
   * @param {object} meta
   * @param {object} extras - { highlights, channels, socoMatches }
   */
  async publish(matches, meta = {}, { actor = 'system', extras = {} } = {}) {
    const filteredLeagues = this.leagues.filterMatches(matches || []);
    const withOverrides = this.overrides.applyToMatches(filteredLeagues);

    const previous = this.cache.getCurrent();
    const previousDelivery = this.cache.getDeliveryBundle();
    const extrasMerged = {
      highlights: extras.highlights ?? previous?.highlights ?? [],
      channels: extras.channels ?? previous?.channels ?? [],
      socoMatches: extras.socoMatches?.length
        ? extras.socoMatches
        : flattenSocoLeagues(previousDelivery?.soco),
    };

    const payload = generateFlutterJson(
      withOverrides,
      {
        ...meta,
        adminApplied: true,
      },
      extrasMerged
    );

    if (this.cache.isEmptyPayload(payload) && previous?.matches?.length) {
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
      socoMatches: extrasMerged.socoMatches,
      highlights: extrasMerged.highlights,
      channels: extrasMerged.channels,
    });

    const { previous: prevDelivery } = this.cache.saveDeliveryBundle(delivery);

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

    if (this.logService) {
      this.logService.add({
        category: 'github',
        action: github.uploaded ? 'upload' : 'skip',
        message: `Publish feeds matches=${cached.matches.length} socoLeagues=${delivery.soco.leagues.length} highlights=${delivery.highlight.count} channels=${delivery.myanmartv.length} (github: ${github.reason}${github.error ? ` - ${github.error}` : ''})`,
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
    const delivery = this.cache.getDeliveryBundle();
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
          socoMatches: flattenSocoLeagues(delivery.soco),
        },
      }
    );
  }
}

function flattenSocoLeagues(socoPayload) {
  if (!socoPayload?.leagues) return [];
  const out = [];
  for (const league of socoPayload.leagues) {
    for (const m of league.matches || []) {
      out.push({
        league: league.league_name,
        leagueIcon: league.league_icon || '',
        homeTeam: m.home_team?.name || '',
        awayTeam: m.away_team?.name || '',
        homeLogo: m.home_team?.logo || '',
        awayLogo: m.away_team?.logo || '',
        month: m.month,
        clock: m.time,
        links: m.links || [],
      });
    }
  }
  return out;
}

module.exports = { PublishService };
