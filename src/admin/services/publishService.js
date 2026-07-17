const { generateFlutterJson } = require('../../services/jsonGenerator');

/**
 * Applies admin overrides + league filters, writes local cache, uploads GitHub if changed.
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
   */
  async publish(matches, meta = {}, { actor = 'system', extras = {} } = {}) {
    const filteredLeagues = this.leagues.filterMatches(matches || []);
    const withOverrides = this.overrides.applyToMatches(filteredLeagues);

    const previous = this.cache.getCurrent();
    const extrasMerged = {
      highlights: extras.highlights ?? previous?.highlights ?? [],
      channels: extras.channels ?? previous?.channels ?? [],
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
    let github = { uploaded: false, reason: 'local_unchanged' };
    if (changed) {
      try {
        github = await this.github.uploadIfChanged(cached, { previousLocal: previous });
        this.lastGithub = { ...github, at: new Date().toISOString() };
      } catch (err) {
        github = {
          uploaded: false,
          reason: 'github_error',
          error: err.message,
          hint: err.hint || null,
          status: err.status || null,
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
    }

    if (this.logService) {
      this.logService.add({
        category: 'github',
        action: changed ? (github.uploaded ? 'upload' : 'skip') : 'unchanged',
        message: changed
          ? `Publish ${cached.matches.length} matches (github: ${github.reason}${github.error ? ` - ${github.error}` : ''})`
          : 'Publish skipped — unchanged',
        actor,
        meta: { changed, github },
      });
    }

    return {
      ok: true,
      payload: cached,
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
