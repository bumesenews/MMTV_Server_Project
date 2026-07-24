const os = require('os');
const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getTelegramService } = require('../services/telegram.service');

/**
 * System RAM + Node heap monitor.
 * MEMORY_LIMIT=85 → alert when system used memory % exceeds limit.
 */
class SystemMonitor {
  constructor({ telegram, env = process.env } = {}) {
    this.telegram = telegram || getTelegramService(env);
    this.env = env;
    this.limitPct = Number(env.MEMORY_LIMIT || 85);
    this.cronExpr = env.MEMORY_CHECK_CRON || '*/2 * * * *';
    this.task = null;
    this.processName = env.PM2_PROCESS_NAME || 'football-streaming';
  }

  start() {
    if (!cron.validate(this.cronExpr)) {
      logger.warn('Invalid MEMORY_CHECK_CRON', { expression: this.cronExpr });
      return;
    }
    this.task = cron.schedule(
      this.cronExpr,
      () => {
        this.check().catch((err) => {
          logger.debug('Memory check failed', { error: err.message });
        });
      },
      { timezone: 'Asia/Yangon' }
    );
    logger.info('System memory monitor started', {
      limitPct: this.limitPct,
      cron: this.cronExpr,
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  getMemorySnapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const systemPct = total > 0 ? (used / total) * 100 : 0;
    const node = process.memoryUsage();
    const nodeRssMb = node.rss / (1024 * 1024);
    const nodeHeapMb = node.heapUsed / (1024 * 1024);
    return {
      systemPct,
      totalMb: total / (1024 * 1024),
      usedMb: used / (1024 * 1024),
      freeMb: free / (1024 * 1024),
      nodeRssMb,
      nodeHeapMb,
    };
  }

  async check() {
    const snap = this.getMemorySnapshot();
    if (snap.systemPct >= this.limitPct) {
      await this.telegram.highMemory({
        memoryPercent: snap.systemPct,
        processName: this.processName,
      });
    }
    return snap;
  }
}

module.exports = { SystemMonitor };
