const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger } = require('../utils/logger');

/**
 * Loads remote scraper configuration from GitHub.
 * Falls back to local ./config when GitHub is unavailable.
 * GitHub is NOT used as a database — only config + Flutter JSON delivery.
 */
class ConfigLoader {
  constructor(env = process.env) {
    this.env = env;
    this.localDir = path.resolve(process.cwd(), env.LOCAL_CONFIG_DIR || './config');
    this.cache = null;
    this.loadedAt = null;
  }

  get githubEnabled() {
    return Boolean(this.env.GITHUB_TOKEN && this.env.GITHUB_OWNER && this.env.GITHUB_REPO);
  }

  async load(force = false) {
    if (this.cache && !force) return this.cache;

    let remote = null;
    if (this.githubEnabled) {
      try {
        remote = await this.loadFromGitHub();
        logger.info('Loaded remote configuration from GitHub');
      } catch (err) {
        logger.warn('GitHub config load failed, using local fallback', {
          error: err.message,
        });
      }
    }

    const local = this.loadFromLocal();
    const merged = {
      leagues: remote?.leagues || local.leagues,
      teams: remote?.teams || local.teams,
      sources: remote?.sources || local.sources,
      origin: remote ? 'github' : 'local',
      loadedAt: new Date().toISOString(),
    };

    this.cache = merged;
    this.loadedAt = merged.loadedAt;
    return merged;
  }

  loadFromLocal() {
    return {
      leagues: readJson(path.join(this.localDir, 'leagues.json')),
      teams: readJson(path.join(this.localDir, 'teams.json')),
      sources: readJson(path.join(this.localDir, 'sources.json')),
    };
  }

  async loadFromGitHub() {
    const base = this.env.GITHUB_CONFIG_PATH || 'config';
    const [leagues, teams, sources] = await Promise.all([
      this.fetchGitHubFile(`${base}/leagues.json`),
      this.fetchGitHubFile(`${base}/teams.json`),
      this.fetchGitHubFile(`${base}/sources.json`),
    ]);
    return { leagues, teams, sources };
  }

  async fetchGitHubFile(filePath) {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.env.GITHUB_REPO;
    const branch = this.env.GITHUB_BRANCH || 'main';
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

    const { data } = await axios.get(url, {
      headers: githubHeaders(this.env.GITHUB_TOKEN),
      timeout: 20000,
    });

    if (!data?.content) throw new Error(`Empty content for ${filePath}`);
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }

  getSourceConfig(sourcesDoc, name) {
    const list = sourcesDoc?.sources || [];
    return list.find((s) => s.name === name) || null;
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    logger.warn('Local config missing', { filePath });
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'football-live-streaming-backend',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

module.exports = { ConfigLoader, githubHeaders };
