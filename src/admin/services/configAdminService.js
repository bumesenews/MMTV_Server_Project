const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { githubHeaders } = require('../../services/configLoader');
const { hasDataChanged } = require('../../utils/compare');

/**
 * Edit remote GitHub config files (sources.json etc.) without touching AWS scraper code.
 */
class ConfigAdminService {
  constructor(env = process.env) {
    this.env = env;
    this.localDir = path.resolve(process.cwd(), env.LOCAL_CONFIG_DIR || './config');
    this.configPath = env.GITHUB_CONFIG_PATH || 'config';
  }

  get enabled() {
    return Boolean(this.env.GITHUB_TOKEN && this.env.GITHUB_OWNER && this.env.GITHUB_REPO);
  }

  apiUrl(filePath) {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.env.GITHUB_REPO;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  }

  async getRemoteFile(relativePath) {
    const filePath = `${this.configPath}/${relativePath}`.replace(/\/+/g, '/');
    try {
      const { data } = await axios.get(this.apiUrl(filePath), {
        headers: githubHeaders(this.env.GITHUB_TOKEN),
        params: { ref: this.env.GITHUB_BRANCH || 'main' },
        timeout: 20000,
      });
      const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      return { sha: data.sha, content, path: filePath, origin: 'github' };
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  readLocalFile(relativePath) {
    const file = path.join(this.localDir, relativePath);
    if (!fs.existsSync(file)) return null;
    return {
      sha: null,
      content: JSON.parse(fs.readFileSync(file, 'utf8')),
      path: file,
      origin: 'local',
    };
  }

  async getSourcesConfig() {
    if (this.enabled) {
      const remote = await this.getRemoteFile('sources.json');
      if (remote) return remote;
    }
    const local = this.readLocalFile('sources.json');
    if (!local) throw new Error('sources.json not found');
    return local;
  }

  async saveSourcesConfig(content, { message, actor } = {}) {
    // Always mirror locally so AWS scraper has immediate fallback
    const localPath = path.join(this.localDir, 'sources.json');
    fs.writeFileSync(localPath, JSON.stringify(content, null, 2), 'utf8');

    if (!this.enabled) {
      return { saved: true, origin: 'local', uploaded: false, reason: 'github_not_configured' };
    }

    const remote = await this.getRemoteFile('sources.json');
    if (remote && !hasDataChanged(remote.content, content)) {
      return { saved: true, origin: 'github', uploaded: false, reason: 'unchanged' };
    }

    const filePath = `${this.configPath}/sources.json`.replace(/\/+/g, '/');
    const body = {
      message:
        message ||
        `chore: update sources config via admin (${actor || 'admin'}) ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(content, null, 2), 'utf8').toString('base64'),
      branch: this.env.GITHUB_BRANCH || 'main',
      ...(remote?.sha ? { sha: remote.sha } : {}),
    };

    const { data } = await axios.put(this.apiUrl(filePath), body, {
      headers: githubHeaders(this.env.GITHUB_TOKEN),
      timeout: 30000,
    });

    return {
      saved: true,
      origin: 'github',
      uploaded: true,
      commit: data.commit?.sha || null,
      htmlUrl: data.content?.html_url || null,
    };
  }

  async updateSourceEntry(sourceName, patch = {}, meta = {}) {
    const current = await this.getSourcesConfig();
    const sources = [...(current.content.sources || [])];
    const idx = sources.findIndex((s) => s.name === sourceName);
    if (idx < 0) throw new Error(`Source ${sourceName} not found in config`);

    sources[idx] = deepMerge(sources[idx], patch);
    const next = {
      ...current.content,
      updatedAt: new Date().toISOString(),
      sources,
    };

    const result = await this.saveSourcesConfig(next, meta);
    return { source: sources[idx], ...result };
  }
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return patch;
}

module.exports = { ConfigAdminService };
