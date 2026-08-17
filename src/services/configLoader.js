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
    // USE_LOCAL_CONFIG=true (default for EC2 deploys): prefer on-disk config so a
    // stale GitHub sources.json cannot re-enable removed scrapers / old domains.
    const preferLocal = String(this.env.USE_LOCAL_CONFIG || 'true').toLowerCase() !== 'false';
    const sources = preferLocalSources(local.sources, remote?.sources, preferLocal);
    const merged = {
      // Prefer local leagues over remote so deployed config/leagues.json
      // (ASEAN, Friendlies, Summer Series, etc.) is not wiped by a stale GitHub copy.
      // Remote still fills in if local is missing.
      leagues: mergeLeaguesDoc(local.leagues, remote?.leagues),
      teams: mergeTeamsDoc(local.teams, remote?.teams),
      sources,
      origin: remote ? (preferLocal && hasSources(local.sources) ? 'local+github' : 'github') : 'local',
      loadedAt: new Date().toISOString(),
      sourcesOrigin: hasSources(local.sources) && (preferLocal || !hasSources(remote?.sources))
        ? 'local'
        : hasSources(remote?.sources)
          ? 'github'
          : 'local',
      leaguesOrigin: local.leagues?.allowedLeagues?.length
        ? remote?.leagues?.allowedLeagues?.length
          ? 'merged'
          : 'local'
        : remote?.leagues
          ? 'github'
          : 'local',
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

/** Local wins on same standardName; keep remote-only leagues that local dropped. */
function mergeLeaguesDoc(local, remote) {
  const localList = local?.allowedLeagues;
  const remoteList = remote?.allowedLeagues;
  if (!Array.isArray(localList) || localList.length === 0) {
    return remote || local || { allowedLeagues: [] };
  }
  if (!Array.isArray(remoteList) || remoteList.length === 0) {
    return local;
  }
  const byName = new Map();
  for (const row of remoteList) {
    const name = row?.standardName;
    if (name) byName.set(String(name), row);
  }
  for (const row of localList) {
    const name = row?.standardName;
    if (name) byName.set(String(name), row);
  }
  // Drop legacy AFF Cup entry when ASEAN Championship is present (rename)
  if (byName.has('ASEAN Championship') && byName.has('AFF Cup')) {
    byName.delete('AFF Cup');
  }
  return { allowedLeagues: [...byName.values()] };
}

function mergeTeamsDoc(local, remote) {
  const localList = local?.teams || local?.allowedTeams;
  if (Array.isArray(localList) && localList.length) return local;
  return remote || local || {};
}

function hasSources(doc) {
  return Array.isArray(doc?.sources) && doc.sources.length > 0;
}

/** Prefer local sources when present so production domains stay under deploy control. */
function preferLocalSources(local, remote, preferLocal) {
  if (preferLocal && hasSources(local)) return local;
  if (hasSources(remote)) return remote;
  return local || remote || { sources: [] };
}

module.exports = { ConfigLoader, githubHeaders, preferLocalSources, hasSources };
