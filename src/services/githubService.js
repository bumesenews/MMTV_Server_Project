const axios = require('axios');
const { logger, logEvent, events } = require('../utils/logger');
const { githubHeaders } = require('./configLoader');
const { getGithubMonitor } = require('../monitor/github.monitor');
const { hasDataChanged, hashPayload } = require('../utils/compare');

/**
 * Upload Flutter JSON to GitHub ONLY when data changes.
 * Never upload empty JSON when scraper fails.
 * GitHub is delivery/backup — not a database.
 *
 * Feeds (default paths match Flutter raw URLs at repo root):
 * - mainlive.json (admin-managed)
 * - matches.json
 * - highlight.json
 * - myanmartv.json
 */
class GitHubService {
  constructor(env = process.env) {
    this.env = env;
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || 'main';
    this.token = env.GITHUB_TOKEN;

    this.paths = {
      mainlive: env.GITHUB_MAINLIVE_PATH || 'mainlive.json',
      matches: env.GITHUB_MATCHES_PATH || env.GITHUB_DATA_PATH || 'matches.json',
      highlight: env.GITHUB_HIGHLIGHTS_PATH || 'highlight.json',
      highlight1: env.GITHUB_HIGHLIGHT1_PATH || 'highlight1.json',
      highlight2: env.GITHUB_HIGHLIGHT2_PATH || 'highlight2.json',
      myanmartv: env.GITHUB_CHANNELS_PATH || 'myanmartv.json',
      tips: env.GITHUB_TIPS_PATH || 'tips.json',
    };
    // Backward-compatible alias used by older call sites
    this.dataPath = this.paths.matches;
  }

  get enabled() {
    return Boolean(this.token && this.owner && this.repo);
  }

  apiUrl(path) {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
  }

  gitUrl(suffix) {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/${suffix}`;
  }

  parseGithubJson(raw, encoding = 'base64') {
    if (raw == null || raw === '') return null;
    try {
      const text =
        encoding === 'utf-8' || encoding === 'utf8'
          ? String(raw)
          : Buffer.from(String(raw).replace(/\n/g, ''), 'base64').toString('utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  isTooLargeGithubError(errOrBody) {
    const msg = String(
      errOrBody?.response?.data?.message || errOrBody?.message || errOrBody || ''
    );
    return /too large|larger than 1\s*mb|blob is too large|too_large/i.test(msg);
  }

  async getHeadSha() {
    const { data } = await axios.get(this.gitUrl(`git/ref/heads/${this.branch}`), {
      headers: githubHeaders(this.token),
      timeout: 20000,
    });
    return data.object.sha;
  }

  async getFileViaGitTree(path) {
    const head = await this.getHeadSha();
    const { data: commit } = await axios.get(this.gitUrl(`git/commits/${head}`), {
      headers: githubHeaders(this.token),
      timeout: 20000,
    });
    const { data: tree } = await axios.get(this.gitUrl(`git/trees/${commit.tree.sha}`), {
      headers: githubHeaders(this.token),
      params: { recursive: '1' },
      timeout: 30000,
    });
    const entry = (tree.tree || []).find((item) => item.path === path && item.type === 'blob');
    if (!entry?.sha) return { sha: null, content: null, size: 0 };
    const { data: blob } = await axios.get(this.gitUrl(`git/blobs/${entry.sha}`), {
      headers: githubHeaders(this.token),
      timeout: 30000,
    });
    return {
      sha: entry.sha,
      content: this.parseGithubJson(blob.content, blob.encoding),
      size: blob.size || entry.size || 0,
    };
  }

  async getFileSha(path = this.dataPath) {
    try {
      const { data } = await axios.get(this.apiUrl(path), {
        headers: githubHeaders(this.token),
        params: { ref: this.branch },
        timeout: 20000,
      });
      if (!data.content) {
        if (data.sha) {
          try {
            return await this.getFileViaGitTree(path);
          } catch (blobErr) {
            logger.warn('GitHub blob fetch failed for large file', {
              path,
              error: blobErr.message,
            });
            return { sha: data.sha, content: null, size: data.size || 0 };
          }
        }
        return { sha: data.sha || null, content: null, size: data.size || 0 };
      }
      return {
        sha: data.sha,
        content: this.parseGithubJson(data.content, data.encoding || 'base64'),
        size: data.size || 0,
      };
    } catch (err) {
      if (err.response?.status === 404) return { sha: null, content: null, size: 0 };
      if (err.response?.status === 403 && this.isTooLargeGithubError(err)) {
        return this.getFileViaGitTree(path);
      }
      throw err;
    }
  }

  needsGitDataUpload(json, remoteSize = 0) {
    const bytes = Buffer.byteLength(json, 'utf8');
    return bytes > 700 * 1024 || remoteSize > 700 * 1024;
  }

  async putViaGitData(filePath, json, message) {
    const head = await this.getHeadSha();
    const { data: commit } = await axios.get(this.gitUrl(`git/commits/${head}`), {
      headers: githubHeaders(this.token),
      timeout: 20000,
    });
    const { data: blob } = await axios.post(
      this.gitUrl('git/blobs'),
      {
        content: Buffer.from(json, 'utf8').toString('base64'),
        encoding: 'base64',
      },
      { headers: githubHeaders(this.token), timeout: 60000 }
    );
    const { data: tree } = await axios.post(
      this.gitUrl('git/trees'),
      {
        base_tree: commit.tree.sha,
        tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }],
      },
      { headers: githubHeaders(this.token), timeout: 30000 }
    );
    const { data: nextCommit } = await axios.post(
      this.gitUrl('git/commits'),
      {
        message,
        tree: tree.sha,
        parents: [head],
      },
      { headers: githubHeaders(this.token), timeout: 30000 }
    );
    await axios.patch(
      this.gitUrl(`git/refs/heads/${this.branch}`),
      { sha: nextCommit.sha, force: false },
      { headers: githubHeaders(this.token), timeout: 20000 }
    );
    return nextCommit.sha;
  }

  stripVolatile(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clone = JSON.parse(JSON.stringify(payload));
    delete clone.generatedAt;
    delete clone.scraped_at;
    if (clone.meta && typeof clone.meta === 'object') {
      delete clone.meta.checksum;
      delete clone.meta.cachedAt;
      delete clone.meta.generatedAt;
    }
    if (Array.isArray(clone.matches)) {
      for (const match of clone.matches) {
        if (!match || typeof match !== 'object') continue;
        delete match.updatedAt;
        if (Array.isArray(match.streams)) {
          for (const stream of match.streams) {
            if (stream && typeof stream === 'object') delete stream.checkedAt;
          }
        }
      }
    }
    return clone;
  }

  payloadChanged(previous, next) {
    if (!previous) return true;
    // Prefer matches-aware compare when both look like match payloads
    if (previous.matches && next?.matches) {
      return hasDataChanged(previous, next);
    }
    return (
      hashPayload(this.stripVolatile(previous)) !== hashPayload(this.stripVolatile(next))
    );
  }

  isEmptyFeed(feedKey, payload) {
    if (payload == null) return true;
    if (feedKey === 'matches' || feedKey === 'mainlive') {
      return !Array.isArray(payload.matches) || payload.matches.length === 0;
    }
    if (feedKey === 'highlight' || feedKey === 'highlight1' || feedKey === 'highlight2') {
      return !Array.isArray(payload.highlights) || payload.highlights.length === 0;
    }
    if (feedKey === 'myanmartv') {
      return !Array.isArray(payload) || payload.length === 0;
    }
    if (feedKey === 'tips') {
      const today = payload.today?.tips;
      const tomorrow = payload.tomorrow?.tips;
      return !(Array.isArray(today) && today.length) && !(Array.isArray(tomorrow) && tomorrow.length);
    }
    return false;
  }

  async uploadJsonIfChanged(filePath, payload, { previousLocal = null, feedKey = 'file', allowEmpty = false } = {}) {
    if (!this.enabled) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — not configured');
      return { uploaded: false, reason: 'not_configured', path: filePath };
    }

    if (payload == null) {
      return { uploaded: false, reason: 'invalid_payload', path: filePath };
    }

    // Never wipe a previously populated feed with empty on scrape failure.
    // Admin-owned mainlive may intentionally clear all rows (allowEmpty).
    const remoteEarly = this.enabled ? await this.getFileSha(filePath) : { sha: null, content: null };
    const previousPopulated =
      (previousLocal && !this.isEmptyFeed(feedKey, previousLocal)) ||
      (remoteEarly.content && !this.isEmptyFeed(feedKey, remoteEarly.content));

    if (this.isEmptyFeed(feedKey, payload) && previousPopulated && !allowEmpty) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — refuse empty overwrite', {
        path: filePath,
        feed: feedKey,
      });
      return { uploaded: false, reason: 'refuse_empty', path: filePath };
    }

    const remote = remoteEarly;

    // Missing GitHub file must be created even if local cache already matches payload.
    if (remote.sha && remote.content != null && !this.payloadChanged(remote.content, payload)) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub upload skipped — unchanged', {
        path: filePath,
        feed: feedKey,
      });
      return { uploaded: false, reason: 'unchanged', path: filePath };
    }

    const json = JSON.stringify(payload, null, 2);
    const message = `chore: sync ${feedKey}.json ${new Date().toISOString()}`;
    const useGitData = this.needsGitDataUpload(json, remote.size || 0);

    if (useGitData) {
      const commit = await this.putViaGitData(filePath, json, message);
      logEvent(events.GITHUB_UPLOAD, 'GitHub JSON uploaded via git data API', {
        path: filePath,
        feed: feedKey,
        commit,
        bytes: Buffer.byteLength(json, 'utf8'),
      });
      return {
        uploaded: true,
        reason: 'changed',
        path: filePath,
        feed: feedKey,
        commit: commit || null,
        htmlUrl: null,
      };
    }

    const body = {
      message,
      content: Buffer.from(json, 'utf8').toString('base64'),
      branch: this.branch,
      ...(remote.sha ? { sha: remote.sha } : {}),
    };

    const { data, status: httpStatus } = await axios.put(this.apiUrl(filePath), body, {
      headers: githubHeaders(this.token),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (this.isTooLargeGithubError(data) || httpStatus === 413) {
      const commit = await this.putViaGitData(filePath, json, message);
      logEvent(events.GITHUB_UPLOAD, 'GitHub JSON uploaded via git data API (contents too large)', {
        path: filePath,
        feed: feedKey,
        commit,
      });
      return {
        uploaded: true,
        reason: 'changed',
        path: filePath,
        feed: feedKey,
        commit: commit || null,
        htmlUrl: null,
      };
    }

    if (data?.message || (data?.status && Number(data.status) >= 400) || httpStatus >= 400) {
      const status = httpStatus || Number(data.status) || 403;
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
      path: filePath,
      feed: feedKey,
      commit: data.commit?.sha,
    });

    return {
      uploaded: true,
      reason: 'changed',
      path: filePath,
      feed: feedKey,
      commit: data.commit?.sha || null,
      htmlUrl: data.content?.html_url || null,
    };
  }

  /**
   * Upload Flutter feeds independently (change-only per file).
   * Null keys are skipped — scraper publish omits mainlive so it stays admin-owned.
   * @param {object} bundle - { mainlive?, matches, highlight, myanmartv }
   * @param {object} previousBundle - previous local delivery files
   * @param {object} options - { allowEmptyFeeds?: string[] }
   */
  async uploadDeliveryBundle(bundle, previousBundle = {}, options = {}) {
    if (!this.enabled) {
      logEvent(events.GITHUB_SKIPPED, 'GitHub delivery upload skipped — not configured');
      return { uploaded: false, reason: 'not_configured', feeds: {} };
    }

    const allowEmptyFeeds = new Set(options.allowEmptyFeeds || []);
    const feeds = {};
    let anyUploaded = false;

    for (const key of [
      'mainlive',
      'matches',
      'highlight',
      'highlight1',
      'highlight2',
      'myanmartv',
      'tips',
    ]) {
      if (bundle[key] == null) {
        feeds[key] = { uploaded: false, reason: 'missing' };
        continue;
      }
      try {
        const result = await this.uploadJsonIfChanged(this.paths[key], bundle[key], {
          previousLocal: previousBundle[key] || null,
          feedKey: key,
          allowEmpty: allowEmptyFeeds.has(key),
        });
        feeds[key] = result;
        if (result.uploaded) anyUploaded = true;
      } catch (err) {
        feeds[key] = {
          uploaded: false,
          reason: 'github_error',
          error: err.message,
          hint: err.hint || null,
          status: err.status || null,
          path: this.paths[key],
        };
        logger.error('GitHub feed upload failed', { feed: key, error: err.message });
        await getGithubMonitor()
          .notifyUploadFailed(err, { feed: key })
          .catch(() => {});
      }
    }

    return {
      uploaded: anyUploaded,
      reason: anyUploaded ? 'changed' : 'unchanged',
      feeds,
      paths: { ...this.paths },
    };
  }

  /** Backward-compatible: upload matches feed only */
  async uploadIfChanged(payload, { previousLocal = null } = {}) {
    return this.uploadJsonIfChanged(this.paths.matches, payload, {
      previousLocal,
      feedKey: 'matches',
    });
  }
}

module.exports = { GitHubService };
