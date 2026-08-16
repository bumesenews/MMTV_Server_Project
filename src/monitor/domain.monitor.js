const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger } = require('../utils/logger');
const { getTelegramService } = require('../services/telegram.service');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

const DEFAULT_STATE_PATH = path.resolve(
  process.cwd(),
  process.env.DOMAIN_CHECK_STATE_PATH || './data/domain-check-state.json'
);

/**
 * Periodic domain health checks for enabled streaming sources.
 *
 * - Probe configured primary domain every hour (DOMAIN_CHECK_CRON)
 * - Immediate Telegram if the site redirects to a new host
 * - After N consecutive failures: look for mirrors / variants, then alert down
 * - Telegram notify only — never auto-update sources.json
 */
class DomainMonitor {
  constructor({ pipeline, telegram, env = process.env, statePath } = {}) {
    this.pipeline = pipeline || null;
    this.env = env;
    this.telegram = telegram || getTelegramService(env);
    this.statePath = statePath || DEFAULT_STATE_PATH;
    this.failThreshold = Math.max(
      1,
      Number(env.DOMAIN_CHECK_FAIL_THRESHOLD || 1)
    );
    this.timeoutMs = Number(env.DOMAIN_CHECK_TIMEOUT_MS || 12000);
    this.state = this._loadState();
    this.running = false;
  }

  /**
   * Check all enabled streaming sources. Never throws to callers.
   */
  async checkAll() {
    if (this.running) {
      logger.debug('Domain check already running — skip');
      return { ok: false, reason: 'already_running' };
    }
    this.running = true;
    const results = [];

    try {
      const sources = await this._listEnabledStreamingSources();
      for (const source of sources) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const row = await this._checkSource(source);
          results.push(row);
        } catch (err) {
          logger.warn('Domain check source error (ignored)', {
            source: source.name,
            error: err.message,
          });
          results.push({
            source: source.name,
            ok: false,
            error: err.message,
          });
        }
      }
      this._saveState();
      return { ok: true, results };
    } catch (err) {
      logger.warn('Domain check cycle failed (ignored)', { error: err.message });
      return { ok: false, reason: err.message };
    } finally {
      this.running = false;
    }
  }

  async _listEnabledStreamingSources() {
    if (!this.pipeline?.configLoader) return [];

    const config = await this.pipeline.configLoader.load(true);
    let sourcesDoc = config.sources;
    if (this.pipeline.admin?.sources?.applyToSourcesDoc) {
      sourcesDoc = this.pipeline.admin.sources.applyToSourcesDoc(sourcesDoc);
    }

    const list = sourcesDoc?.sources || [];
    return list
      .filter((cfg) => cfg && cfg.type === 'streaming' && cfg.enabled !== false)
      .filter((cfg) => {
        if (this.pipeline.admin?.sources?.isEnabled) {
          return this.pipeline.admin.sources.isEnabled(cfg.name);
        }
        return true;
      })
      .map((cfg) => {
        const domains = [
          ...(cfg.domains || []),
          ...(cfg.mirrorDomains || []),
        ].filter(Boolean);
        return {
          name: cfg.name,
          primary: domains[0] || null,
          domains,
        };
      })
      .filter((s) => s.name && s.primary);
  }

  async _checkSource(source) {
    const name = source.name;
    const primary = this._normalizeUrl(source.primary);
    const watchedHost = this._hostKey(primary);

    let st = this.state.sources[name] || {
      watchedDomain: primary,
      consecutiveFailures: 0,
      lastOkAt: null,
      lastFailAt: null,
      lastCheckAt: null,
      alertedChange: null,
      alertedDown: null,
    };

    // Admin updated configured domain → reset tracking; future checks use new domain
    if (this._hostKey(st.watchedDomain) !== watchedHost) {
      st = {
        ...st,
        watchedDomain: primary,
        consecutiveFailures: 0,
        alertedChange: null,
        alertedDown: null,
        lastCheckAt: null,
      };
    } else {
      st.watchedDomain = primary;
    }

    const probe = await this._probeUrl(primary);
    st.lastCheckAt = new Date().toISOString();

    if (probe.reachable && this._sameSite(primary, probe.finalUrl || primary)) {
      st.consecutiveFailures = 0;
      st.lastOkAt = st.lastCheckAt;
      st.alertedDown = null;
      this.state.sources[name] = st;
      return {
        source: name,
        ok: true,
        domain: primary,
        status: probe.status,
      };
    }

    // Live but landed on a different host (common VN stream-site hops).
    if (probe.reachable && probe.finalUrl && !this._sameSite(primary, probe.finalUrl)) {
      const moved = this._originOf(probe.finalUrl) || probe.finalUrl;
      return this._recordDomainChange(name, st, primary, moved);
    }

    st.consecutiveFailures = Number(st.consecutiveFailures || 0) + 1;
    st.lastFailAt = st.lastCheckAt;
    this.state.sources[name] = st;

    if (st.consecutiveFailures < this.failThreshold) {
      logger.info('Domain check failed (waiting for threshold)', {
        source: name,
        domain: primary,
        failures: st.consecutiveFailures,
        threshold: this.failThreshold,
        error: probe.error || `http_${probe.status}`,
      });
      return {
        source: name,
        ok: false,
        pending: true,
        failures: st.consecutiveFailures,
        domain: primary,
      };
    }

    // Threshold reached — investigate redirects / new domain
    const discovery = await this._discoverNewDomain(source, primary, probe);

    if (discovery?.newDomain) {
      return this._recordDomainChange(name, st, primary, discovery.newDomain);
    }

    // Website down / unreachable — not a domain change
    const downKey = `${watchedHost}:${probe.error || probe.status || 'down'}`;
    if (st.alertedDown !== downKey) {
      try {
        await this.telegram.websiteError({
          source: name,
          website: this._displayHost(primary),
          error:
            probe.error ||
            (probe.status ? `HTTP ${probe.status}` : 'unreachable'),
          consecutiveFailures: st.consecutiveFailures,
        });
      } catch (err) {
        logger.warn('Telegram website-error alert failed (ignored)', {
          source: name,
          error: err.message,
        });
      }
      st.alertedDown = downKey;
    }

    this.state.sources[name] = st;
    return {
      source: name,
      ok: false,
      websiteError: true,
      domain: primary,
      error: probe.error || `http_${probe.status}`,
    };
  }

  /**
   * After repeated failures: follow redirects / try mirrors / URL variants.
   * Returns { newDomain } only when a different working host is found.
   */
  async _discoverNewDomain(source, primary, initialProbe) {
    const primaryHost = this._hostKey(primary);
    const candidates = [];

    if (initialProbe?.finalUrl && !this._sameSite(primary, initialProbe.finalUrl)) {
      candidates.push(initialProbe.finalUrl);
    }

    const redirectTarget = await this._readRedirectLocation(primary);
    if (redirectTarget) candidates.push(redirectTarget);

    for (const variant of this._urlVariants(primary)) {
      if (!this._sameSite(primary, variant)) candidates.push(variant);
    }

    for (const d of source.domains || []) {
      if (this._hostKey(d) !== primaryHost) {
        candidates.push(this._normalizeUrl(d));
      }
    }

    const seen = new Set();
    for (const raw of candidates) {
      const url = this._normalizeUrl(raw);
      const host = this._hostKey(url);
      if (!host || host === primaryHost || seen.has(host)) continue;
      seen.add(host);

      // eslint-disable-next-line no-await-in-loop
      const probe = await this._probeUrl(url);
      if (probe.reachable && this._sameSite(url, probe.finalUrl || url)) {
        const origin = this._originOf(probe.finalUrl || url);
        return { newDomain: origin || url, via: host };
      }
    }

    return null;
  }

  async _recordDomainChange(name, st, primary, newDomain) {
    const oldHost = this._displayHost(primary);
    const newHost = this._displayHost(newDomain);
    const changeKey = `${oldHost}->${newHost}`;

    if (st.alertedChange === changeKey) {
      logger.debug('Domain change already alerted — skip duplicate', {
        source: name,
        changeKey,
      });
      this.state.sources[name] = st;
      return {
        source: name,
        ok: false,
        domainChanged: true,
        duplicate: true,
        oldDomain: oldHost,
        newDomain: newHost,
      };
    }

    try {
      await this.telegram.streamingDomainChanged({
        source: name,
        oldDomain: oldHost,
        newDomain: newHost,
      });
    } catch (err) {
      logger.warn('Telegram domain-change alert failed (ignored)', {
        source: name,
        error: err.message,
      });
    }

    st.alertedChange = changeKey;
    st.consecutiveFailures = 0;
    this.state.sources[name] = st;
    return {
      source: name,
      ok: false,
      domainChanged: true,
      oldDomain: oldHost,
      newDomain: newHost,
    };
  }

  async _probeUrl(url) {
    const target = this._normalizeUrl(url);
    try {
      const res = await axios.get(target, {
        timeout: this.timeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent': this.env.USER_AGENT || DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        maxContentLength: 256 * 1024,
        maxBodyLength: 256 * 1024,
        responseType: 'text',
      });

      const finalUrl =
        res.request?.res?.responseUrl ||
        res.request?.responseURL ||
        res.config?.url ||
        target;

      const reachable = Number.isFinite(res.status);
      const healthy = reachable && res.status > 0 && res.status < 500;

      return {
        reachable: healthy,
        status: res.status,
        finalUrl,
        error: healthy ? null : `http_${res.status}`,
      };
    } catch (err) {
      return {
        reachable: false,
        status: err.response?.status || null,
        finalUrl: null,
        error: err.code || err.message || 'request_failed',
      };
    }
  }

  async _readRedirectLocation(url) {
    const target = this._normalizeUrl(url);
    try {
      const res = await axios.get(target, {
        timeout: this.timeoutMs,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: {
          'User-Agent': this.env.USER_AGENT || DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        maxContentLength: 64 * 1024,
        responseType: 'text',
      });
      const loc = res.headers?.location;
      if (loc) return new URL(loc, target).toString();
    } catch (err) {
      const loc = err.response?.headers?.location;
      if (loc) {
        try {
          return new URL(loc, target).toString();
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  _urlVariants(url) {
    const out = [];
    try {
      const u = new URL(this._normalizeUrl(url));
      const host = u.hostname;
      const bare = host.replace(/^www\./i, '');
      const withWww = host.startsWith('www.') ? host : `www.${bare}`;
      for (const scheme of ['https:', 'http:']) {
        out.push(`${scheme}//${bare}/`);
        out.push(`${scheme}//${withWww}/`);
      }
    } catch {
      // ignore
    }
    return out;
  }

  _normalizeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw}`;
  }

  _hostKey(url) {
    try {
      const u = new URL(this._normalizeUrl(url));
      return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return String(url || '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .toLowerCase();
    }
  }

  _displayHost(url) {
    try {
      const u = new URL(this._normalizeUrl(url));
      return u.host || u.hostname;
    } catch {
      return this._hostKey(url) || String(url || '');
    }
  }

  _originOf(url) {
    try {
      const u = new URL(this._normalizeUrl(url));
      return `${u.protocol}//${u.host}/`;
    } catch {
      return this._normalizeUrl(url);
    }
  }

  _sameSite(a, b) {
    return this._hostKey(a) === this._hostKey(b);
  }

  _loadState() {
    try {
      if (!fs.existsSync(this.statePath)) return { sources: {} };
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return { sources: raw.sources || {} };
    } catch {
      return { sources: {} };
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      logger.debug('Domain check state save failed', { error: err.message });
    }
  }
}

module.exports = { DomainMonitor };
