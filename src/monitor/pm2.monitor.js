const { execFile } = require('child_process');
const { promisify } = require('util');
const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getTelegramService } = require('../services/telegram.service');

const execFileAsync = promisify(execFile);

/**
 * Detect PM2 restarts by polling `pm2 jlist` restart_time for this process.
 * Safe no-op when not running under PM2 or pm2 CLI is unavailable.
 */
class Pm2Monitor {
  constructor({ telegram, env = process.env } = {}) {
    this.telegram = telegram || getTelegramService(env);
    this.env = env;
    this.processName = env.PM2_PROCESS_NAME || 'football-streaming';
    this.cronExpr = env.PM2_CHECK_CRON || '*/5 * * * *';
    this.task = null;
  }

  start() {
    // Immediate baseline so first poll does not false-alarm
    this.snapshot()
      .then((snap) => {
        if (snap && typeof snap.restartTime === 'number') {
          const prev = this.telegram.getMeta('pm2_restart_time');
          if (prev == null) {
            this.telegram.setMeta('pm2_restart_time', snap.restartTime);
            this.telegram.setMeta('pm2_process_name', snap.name);
          }
        }
      })
      .catch(() => {});

    if (!cron.validate(this.cronExpr)) {
      logger.warn('Invalid PM2_CHECK_CRON', { expression: this.cronExpr });
      return;
    }

    this.task = cron.schedule(
      this.cronExpr,
      () => {
        this.check().catch((err) => {
          logger.debug('PM2 check failed', { error: err.message });
        });
      },
      { timezone: 'Asia/Yangon' }
    );

    logger.info('PM2 monitor started', {
      processName: this.processName,
      cron: this.cronExpr,
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  async snapshot() {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], {
        timeout: 8000,
        windowsHide: true,
      });
      const list = JSON.parse(stdout || '[]');
      if (!Array.isArray(list) || !list.length) return null;

      const pmId = this.env.pm_id != null ? Number(this.env.pm_id) : null;
      let proc =
        (Number.isFinite(pmId) && list.find((p) => Number(p.pm_id) === pmId)) ||
        list.find((p) => p.name === this.processName) ||
        list[0];

      if (!proc) return null;
      return {
        name: proc.name,
        restartTime: Number(proc.pm2_env?.restart_time ?? 0),
        status: proc.pm2_env?.status,
      };
    } catch (err) {
      logger.debug('pm2 jlist unavailable', { error: err.message });
      return null;
    }
  }

  async check() {
    const snap = await this.snapshot();
    if (!snap || !Number.isFinite(snap.restartTime)) return null;

    const prev = this.telegram.getMeta('pm2_restart_time');
    if (prev == null) {
      this.telegram.setMeta('pm2_restart_time', snap.restartTime);
      this.telegram.setMeta('pm2_process_name', snap.name);
      return snap;
    }

    if (snap.restartTime > Number(prev)) {
      this.telegram.setMeta('pm2_restart_time', snap.restartTime);
      this.telegram.setMeta('pm2_process_name', snap.name);
      await this.telegram.pm2Restart({
        processName: snap.name,
        restartCount: snap.restartTime,
      });
    }

    return snap;
  }
}

module.exports = { Pm2Monitor };
