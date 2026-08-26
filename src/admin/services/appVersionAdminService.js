const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { githubHeaders } = require('../../services/configLoader');
const { hasDataChanged } = require('../../utils/compare');

const DEFAULT_APP_VERSION = {
  change: false,
  con: false,
  title: 'Temporary Server Error',
  subtitle: 'Please Update Burmese Stream Player',
  link: 'https://play.google.com/store/apps/details?id=com.example.com',
  uriversion: '1.0.0',
  uriversionDetails: 'Ui fix So Please Update',
  facebook: 'https://www.facebook.com/share/1cQtGLvaQV/',
  telegram: 'https://t.me/burmesestreamplayer',
};

/**
 * Admin-editable mobile app version / maintenance JSON.
 * Publishes to a separate GitHub repo (default: bumesenews/version-control @ json).
 */
class AppVersionAdminService {
  constructor(env = process.env) {
    this.env = env;
    this.localPath = path.resolve(
      process.cwd(),
      env.APP_VERSION_LOCAL_PATH || 'data/admin/app-version.json'
    );
    this.owner = env.APP_VERSION_GITHUB_OWNER || 'bumesenews';
    this.repo = env.APP_VERSION_GITHUB_REPO || 'version-control';
    this.branch = env.APP_VERSION_GITHUB_BRANCH || 'main';
    this.filePath = env.APP_VERSION_GITHUB_PATH || 'json';
    this.token = env.APP_VERSION_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
  }

  get enabled() {
    return Boolean(this.token && this.owner && this.repo);
  }

  get rawUrl() {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/refs/heads/${this.branch}/${this.filePath}`;
  }

  apiUrl() {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${this.filePath}`;
  }

  ensureLocalDir() {
    fs.mkdirSync(path.dirname(this.localPath), { recursive: true });
  }

  normalize(content = {}) {
    const src = content && typeof content === 'object' ? content : {};
    return {
      change: Boolean(src.change),
      con: Boolean(src.con),
      title: String(src.title ?? DEFAULT_APP_VERSION.title).trim(),
      subtitle: String(src.subtitle ?? DEFAULT_APP_VERSION.subtitle).trim(),
      link: String(src.link ?? DEFAULT_APP_VERSION.link).trim(),
      uriversion: String(src.uriversion ?? DEFAULT_APP_VERSION.uriversion).trim(),
      uriversionDetails: String(src.uriversionDetails ?? DEFAULT_APP_VERSION.uriversionDetails).trim(),
      facebook: String(src.facebook ?? DEFAULT_APP_VERSION.facebook).trim(),
      telegram: String(src.telegram ?? DEFAULT_APP_VERSION.telegram).trim(),
    };
  }

  readLocal() {
    if (!fs.existsSync(this.localPath)) return null;
    try {
      const content = this.normalize(JSON.parse(fs.readFileSync(this.localPath, 'utf8')));
      return { sha: null, content, path: this.localPath, origin: 'local' };
    } catch {
      return null;
    }
  }

  writeLocal(content) {
    this.ensureLocalDir();
    const normalized = this.normalize(content);
    fs.writeFileSync(this.localPath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  async getRemote() {
    if (!this.enabled) return null;
    try {
      const { data } = await axios.get(this.apiUrl(), {
        headers: githubHeaders(this.token),
        params: { ref: this.branch },
        timeout: 20000,
      });
      const content = this.normalize(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
      return { sha: data.sha, content, path: this.filePath, origin: 'github' };
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  async get() {
    if (this.enabled) {
      try {
        const remote = await this.getRemote();
        if (remote?.content) return remote;
      } catch (err) {
        const local = this.readLocal();
        if (local) return { ...local, remoteError: err.message };
        throw err;
      }
    }
    const local = this.readLocal();
    if (local) return local;
    return {
      sha: null,
      content: { ...DEFAULT_APP_VERSION },
      path: this.localPath,
      origin: 'default',
    };
  }

  async save(content, { message, actor } = {}) {
    const normalized = this.writeLocal(content);

    if (!this.enabled) {
      return {
        saved: true,
        origin: 'local',
        uploaded: false,
        reason: 'github_not_configured',
        content: normalized,
        rawUrl: this.rawUrl,
      };
    }

    const remote = await this.getRemote();
    if (remote && !hasDataChanged(remote.content, normalized)) {
      return {
        saved: true,
        origin: 'github',
        uploaded: false,
        reason: 'unchanged',
        content: normalized,
        rawUrl: this.rawUrl,
      };
    }

    const body = {
      message:
        message ||
        `chore: update app version json via admin (${actor || 'admin'}) ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(normalized, null, 2), 'utf8').toString('base64'),
      branch: this.branch,
      ...(remote?.sha ? { sha: remote.sha } : {}),
    };

    const { data } = await axios.put(this.apiUrl(), body, {
      headers: githubHeaders(this.token),
      timeout: 30000,
    });

    return {
      saved: true,
      origin: 'github',
      uploaded: true,
      commit: data.commit?.sha || null,
      htmlUrl: data.content?.html_url || null,
      content: normalized,
      rawUrl: this.rawUrl,
    };
  }

  async syncLocalToGithub({ message, actor } = {}) {
    const local = this.readLocal();
    if (!local?.content) throw new Error('Local app-version.json not found');
    return this.save(local.content, {
      message: message || `chore: sync local app version json (${actor || 'admin'})`,
      actor,
    });
  }

  readLocalForPublic() {
    const local = this.readLocal();
    if (local?.content) return local.content;
    return { ...DEFAULT_APP_VERSION };
  }
}

module.exports = { AppVersionAdminService, DEFAULT_APP_VERSION };
