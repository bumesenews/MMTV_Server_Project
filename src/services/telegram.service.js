const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger } = require('../utils/logger');
const { nowYangon } = require('../utils/time');

const STATE_PATH = path.resolve(
  process.cwd(),
  process.env.TELEGRAM_ALERT_STATE_PATH || './data/telegram-alert-state.json'
);

/**
 * Telegram Bot alerts with per-key cooldown + last-message fingerprint
 * so the same alert is not spammed. Never throws to callers.
 */
class TelegramService {
  constructor(env = process.env) {
    this.env = env;
    this.token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
    this.chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
    this.cooldownMs = Number(env.TELEGRAM_ALERT_COOLDOWN_MS || 15 * 60 * 1000);
    this.serviceName = env.TELEGRAM_SERVICE_NAME || 'Football API';
    this.serverLabel = env.TELEGRAM_SERVER_LABEL || 'AWS EC2';
    this.processName = env.PM2_PROCESS_NAME || env.name || 'football-streaming';
    this.enabled = Boolean(this.token && this.chatId);
    this.state = this._loadState();
  }

  get configured() {
    return this.enabled;
  }

  formatTime(date = new Date()) {
    try {
      return nowYangon().toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
    } catch {
      return date.toISOString();
    }
  }

  /**
   * @param {string} key - cooldown / dedupe key
   * @param {string} text - message body
   * @param {{ force?: boolean, fingerprint?: string }} [options]
   */
  async sendAlert(key, text, options = {}) {
    if (!this.enabled) {
      logger.debug('Telegram alert skipped — not configured', { key });
      return { ok: false, reason: 'not_configured' };
    }

    const fingerprint = options.fingerprint || String(text || '').slice(0, 500);
    const now = Date.now();
    const prev = this.state.alerts?.[key];

    if (!options.force && prev) {
      if (prev.fingerprint === fingerprint && now - (prev.at || 0) < this.cooldownMs) {
        return { ok: false, reason: 'cooldown_duplicate' };
      }
      if (now - (prev.at || 0) < this.cooldownMs && prev.fingerprint === fingerprint) {
        return { ok: false, reason: 'cooldown' };
      }
      // Same key within cooldown but different fingerprint: still rate-limit lightly
      if (now - (prev.at || 0) < Math.min(this.cooldownMs, 60_000)) {
        return { ok: false, reason: 'cooldown_burst' };
      }
    }

    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await axios.post(
        url,
        {
          chat_id: this.chatId,
          text: String(text || '').slice(0, 4000),
          disable_web_page_preview: true,
        },
        { timeout: 15000 }
      );

      this._remember(key, fingerprint, now);
      logger.info('Telegram alert sent', { key });
      return { ok: true };
    } catch (err) {
      logger.warn('Telegram alert failed (ignored)', {
        key,
        error: err.response?.data?.description || err.message,
      });
      return { ok: false, reason: 'send_failed', error: err.message };
    }
  }

  lines(title, fields = {}) {
    const rows = [String(title || '').trim()];
    for (const [label, value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      rows.push(`${label}:`);
      rows.push(String(value));
    }
    if (!fields.Time) {
      rows.push('Time:');
      rows.push(this.formatTime());
    }
    return rows.join('\n');
  }

  async serverStarted() {
    return this.sendAlert(
      'server_start',
      this.lines('🟢 Server Started', {
        Service: this.serviceName,
        Server: this.serverLabel,
        Process: this.processName,
        Time: this.formatTime(),
      }),
      { force: true, fingerprint: `start:${Date.now()}` }
    );
  }

  async serverCrash(error) {
    const msg = error?.stack || error?.message || String(error || 'unknown');
    return this.sendAlert(
      'server_crash',
      this.lines('🔴 Server Crash', {
        Service: this.serviceName,
        Error: msg.slice(0, 1500),
        Time: this.formatTime(),
      }),
      { fingerprint: `crash:${String(error?.message || msg).slice(0, 200)}` }
    );
  }

  async scraperFailed(source, error) {
    const errMsg = error?.message || String(error || 'unknown');
    const name = source || 'unknown';
    return this.sendAlert(
      `scraper_failed:${name}`,
      this.lines('⚠️ Scraper Failed', {
        Source: name,
        Error: errMsg.slice(0, 1000),
        Time: this.formatTime(),
      }),
      { fingerprint: `${name}:${errMsg.slice(0, 200)}` }
    );
  }

  async githubUploadFailed(repo, error, extra = {}) {
    const errMsg = error?.message || String(error || 'unknown');
    return this.sendAlert(
      'github_upload_failed',
      this.lines('⚠️ GitHub Upload Failed', {
        Repository: repo || `${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}`,
        Feed: extra.feed || '',
        Error: errMsg.slice(0, 1000),
        Time: this.formatTime(),
      }),
      { fingerprint: `gh:${extra.feed || ''}:${errMsg.slice(0, 200)}` }
    );
  }

  async pm2Restart({ processName, restartCount } = {}) {
    return this.sendAlert(
      'pm2_restart',
      this.lines('🔄 PM2 Restart Detected', {
        Process: processName || this.processName,
        'Restart Count': String(restartCount ?? '?'),
        Time: this.formatTime(),
      }),
      { fingerprint: `pm2:${processName}:${restartCount}` }
    );
  }

  async highMemory({ memoryPercent, processName } = {}) {
    const pct = Number(memoryPercent);
    return this.sendAlert(
      'high_memory',
      this.lines('⚠️ High Memory Usage', {
        Memory: `${Number.isFinite(pct) ? pct.toFixed(0) : '?'}%`,
        Process: processName || this.processName,
        Time: this.formatTime(),
      }),
      { fingerprint: `mem:${Math.floor(pct / 5) * 5}` }
    );
  }

  async websiteTimeout({ website, timeoutSec } = {}) {
    return this.sendAlert(
      `website_timeout:${website || 'unknown'}`,
      this.lines('🌐 Website Timeout', {
        Website: website || 'unknown',
        Timeout: `${timeoutSec || 30} seconds`,
        Time: this.formatTime(),
      }),
      { fingerprint: `timeout:${website}` }
    );
  }

  async allSourcesFailed({ sources = [], error } = {}) {
    const list = (sources || []).filter(Boolean);
    return this.sendAlert(
      'all_sources_failed',
      this.lines('🚨 All Sources Failed', {
        Sources: list.length ? list.join('\n') : '(none)',
        Error: (error?.message || String(error || 'All enabled sources failed')).slice(0, 1000),
        Time: this.formatTime(),
      }),
      { fingerprint: `all:${list.sort().join(',')}` }
    );
  }

  async dailyReport(stats = {}) {
    const scraperOk = stats.scraperOk !== false;
    return this.sendAlert(
      'daily_report',
      this.lines('📊 Daily Report', {
        Date: stats.date || nowYangon().toFormat('yyyy-MM-dd'),
        Scraper: scraperOk ? '✅ Successful' : '❌ Failed',
        Failed: String(stats.failedCount ?? 0),
        'GitHub Upload': stats.githubOk ? '✅ Successful' : '❌ Failed / skipped',
        'API Status': stats.apiOnline !== false ? '🟢 Online' : '🔴 Offline',
        'Total Matches': String(stats.totalMatches ?? 0),
        Time: this.formatTime(),
      }),
      { force: true, fingerprint: `daily:${stats.date || ''}` }
    );
  }

  _remember(key, fingerprint, at) {
    if (!this.state.alerts) this.state.alerts = {};
    this.state.alerts[key] = { fingerprint, at };
    this._saveState();
  }

  _loadState() {
    try {
      if (!fs.existsSync(STATE_PATH)) return { alerts: {}, meta: {} };
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      return {
        alerts: raw.alerts || {},
        meta: raw.meta || {},
      };
    } catch {
      return { alerts: {}, meta: {} };
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      logger.debug('Telegram state save failed', { error: err.message });
    }
  }

  getMeta(key, fallback = null) {
    return this.state.meta?.[key] ?? fallback;
  }

  setMeta(key, value) {
    if (!this.state.meta) this.state.meta = {};
    this.state.meta[key] = value;
    this._saveState();
  }
}

let shared = null;

function getTelegramService(env = process.env) {
  if (!shared) shared = new TelegramService(env);
  return shared;
}

module.exports = { TelegramService, getTelegramService };
