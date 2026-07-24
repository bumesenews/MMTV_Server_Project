const { getTelegramService } = require('../services/telegram.service');

/**
 * GitHub upload failure alerts.
 */
class GithubMonitor {
  constructor({ telegram, env = process.env } = {}) {
    this.telegram = telegram || getTelegramService(env);
    this.env = env;
    this.repo = `${env.GITHUB_OWNER || '?'}/${env.GITHUB_REPO || '?'}`;
  }

  async notifyUploadFailed(error, { feed } = {}) {
    await this.telegram.githubUploadFailed(this.repo, error, { feed });
  }

  /**
   * Inspect uploadDeliveryBundle / uploadJsonIfChanged style results.
   */
  async inspectResult(result) {
    if (!result) return;

    if (result.reason === 'github_error' && result.error) {
      await this.notifyUploadFailed(new Error(result.error), { feed: result.feed });
      return;
    }

    const feeds = result.feeds || {};
    for (const [feed, row] of Object.entries(feeds)) {
      if (row?.reason === 'github_error' || row?.error) {
        await this.notifyUploadFailed(new Error(row.error || 'GitHub upload failed'), {
          feed,
        });
      }
    }
  }
}

let shared = null;

function getGithubMonitor(opts) {
  if (!shared) shared = new GithubMonitor(opts);
  return shared;
}

module.exports = { GithubMonitor, getGithubMonitor };
