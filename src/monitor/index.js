const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { nowYangon } = require('../utils/time');
const { getTelegramService } = require('../services/telegram.service');
const { SystemMonitor } = require('./system.monitor');
const { ScraperMonitor, getScraperMonitor } = require('./scraper.monitor');
const { GithubMonitor, getGithubMonitor } = require('./github.monitor');
const { Pm2Monitor } = require('./pm2.monitor');

/**
 * Boots Telegram monitors + process crash hooks + optional daily report.
 */
function startMonitoring({ pipeline, env = process.env } = {}) {
  const telegram = getTelegramService(env);
  const scraperMonitor = getScraperMonitor({ telegram, env });
  const githubMonitor = getGithubMonitor({ telegram, env });
  const systemMonitor = new SystemMonitor({ telegram, env });
  const pm2Monitor = new Pm2Monitor({ telegram, env });

  systemMonitor.start();
  pm2Monitor.start();

  let dailyTask = null;
  const dailyExpr = env.TELEGRAM_DAILY_REPORT_CRON || '0 9 * * *';
  if (env.TELEGRAM_DAILY_REPORT !== 'false' && cron.validate(dailyExpr)) {
    dailyTask = cron.schedule(
      dailyExpr,
      async () => {
        try {
          const matches = pipeline?.cache?.getCurrent()?.matches || [];
          const lastRun = pipeline?.lastRun || {};
          const githubOk =
            lastRun.github?.uploaded === true ||
            lastRun.github?.reason === 'unchanged' ||
            lastRun.github?.reason === 'local_unchanged';
          await telegram.dailyReport({
            date: nowYangon().toFormat('yyyy-MM-dd'),
            scraperOk: lastRun.ok !== false,
            failedCount: lastRun.ok === false ? 1 : 0,
            githubOk: Boolean(githubOk),
            apiOnline: true,
            totalMatches: matches.length,
          });
        } catch (err) {
          logger.debug('Daily Telegram report failed', { error: err.message });
        }
      },
      { timezone: 'Asia/Yangon' }
    );
    logger.info('Telegram daily report scheduled', { cron: dailyExpr });
  }

  const onCrash = (error, label) => {
    logger.error(label, { error: error?.message || String(error), stack: error?.stack });
    telegram.serverCrash(error).catch(() => {});
  };

  process.on('uncaughtException', (err) => {
    onCrash(err, 'uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    onCrash(err, 'unhandledRejection');
  });

  logger.info('Telegram monitoring started', {
    configured: telegram.configured,
  });

  return {
    telegram,
    scraperMonitor,
    githubMonitor,
    systemMonitor,
    pm2Monitor,
    stop() {
      systemMonitor.stop();
      pm2Monitor.stop();
      if (dailyTask) dailyTask.stop();
    },
  };
}

module.exports = {
  startMonitoring,
  getTelegramService,
  getScraperMonitor,
  getGithubMonitor,
  SystemMonitor,
  ScraperMonitor,
  GithubMonitor,
  Pm2Monitor,
};
