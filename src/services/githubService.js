const axios = require('axios');
const { logger, logEvent, events } = require('../utils/logger');
const { githubHeaders } = require('./configLoader');
const { hasDataChanged } = require('../utils/compare');

/**
 * Upload Flutter JSON to GitHub ONLY when data changes.
 * Never upload empty JSON when scraper fails.
 * GitHub is delivery/backup — not a database.
 */
class GitHubService {
  constructor(env = process.env) {
    this.env = env;
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || 'main';
    this.dataPath = env.GITHUB_DATA_PATH || 'data/matches.json';
    this.token = env.GITHUB_TOKEN;
  }

  get enabled() {
    return Boolean(this.token && this.owner && this.repo);
  }

  apiUrl(path) {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
  }

  async getFileSha(path = this.dataPath) {
    try {
      const { data } = await axios.get(this.apiUrl(path), {
        headers: githubHeaders(this.token),
        params: { ref: this.branch },
        timeout: 20000,
      });
      return { sha: data.sha, content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')) };
    } catch (err) {
      if (err.response?.status === 404) return { sha: null, content: null };
      throw err;
    }
  }

  async uploadIfChanged(payload, { previousLocal = null } = {}) {
    if (!this.enabled) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — not configured');
      return { uploaded: false, reason: 'not_configured' };
    }

    if (!payload || !Array.isArray(payload.matches)) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — invalid payload');
      return { uploaded: false, reason: 'invalid_payload' };
    }

    // Never upload empty when we previously had data (scraper failure safety)
    if (payload.matches.length === 0 && previousLocal?.matches?.length > 0) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — refuse empty overwrite');
      return { uploaded: false, reason: 'refuse_empty' };
    }

    const remote = await this.getFileSha(this.dataPath);
    const baseline = remote.content || previousLocal;

    if (!hasDataChanged(baseline, payload)) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — unchanged', {
        path: this.dataPath,
      });
      return { uploaded: false, reason: 'unchanged' };
    }

    const body = {
      message: `chore: update matches JSON ${payload.generatedAt || new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
      branch: this.branch,
      ...(remote.sha ? { sha: remote.sha } : {}),
    };

    const { data } = await axios.put(this.apiUrl(this.dataPath), body, {
      headers: githubHeaders(this.token),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (data?.message || (data?.status && Number(data.status) >= 400)) {
      const status = Number(data.status) || 403;
      const msg = data.message || 'GitHub upload failed';
      const err = new Error(msg);
      err.status = status;
      err.github = data;
      if (/personal access token|Resource not accessible/i.test(msg)) {
        err.hint =
          'Fine-grained token needs Contents: Read and write on this repository. Create a new token and update GITHUB_TOKEN in .env';
      }
      throw err;
    }

    logEvent(events.GITHUB_UPLOAD, 'GitHub JSON uploaded', {
      path: this.dataPath,
      commit: data.commit?.sha,
      matchCount: payload.matches.length,
    });

    return {
      uploaded: true,
      reason: 'changed',
      commit: data.commit?.sha || null,
      htmlUrl: data.content?.html_url || null,
    };
  }
}

module.exports = { GitHubService };
