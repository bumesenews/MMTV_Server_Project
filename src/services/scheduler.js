const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getCheckIntervalMinutes, nowYangon } = require('../utils/time');
const { DomainMonitor } = require('../monitor/domain.monitor');

/**
 * Job schedule (Asia/Yangon):
 *
 * Main pipeline (PIPELINE_CRON)
 * └── expire kickoff+2h (even if scrape skipped) → matches scrape
 *
 * Highlight Job (HIGHLIGHT_CRON, default every 3 hr)
 * └── Highlights → highlight.json
 *
 * MyanmarTV Job (MYANMARTV_CRON, default every 8 min)
 * └── Channels → myanmartv.json (wmsAuthSign tokens last ~10 min)
 *
 * Tips Job (TIPS_CRON, default 08:07 and 20:07 Yangon)
 * └── PredictZ today + tomorrow → tips.json
 *
 * Domain check (DOMAIN_CHECK_CRON, default every hour)
 * └── Enabled streaming source domains → Telegram if down or domain changed
 */
class Scheduler {
  constructor(pipeline, env = process.env) {
    this.pipeline = pipeline;
    this.env = env;
    this.task = null;
    this.highlightTask = null;
    this.channelsTask = null;
    this.tipsTask = null;
    this.domainTask = null;
    this.tickMinutes = 1;
    // Prefer monitor bootstrapped in startMonitoring (shared state file)
    this.domainMonitor =
      pipeline?.monitoring?.domainMonitor ||
      new DomainMonitor({ pipeline, env });
  }

  start() {
    const expression = this.env.PIPELINE_CRON || `*/${this.tickMinutes} * * * *`;
    const highlightExpression = this.env.HIGHLIGHT_CRON || '0 */3 * * *';
    const channelsExpression = this.env.MYANMARTV_CRON || '*/8 * * * *';
    const tipsExpression = this.env.TIPS_CRON || '7 8,20 * * *';
    const domainExpression = this.env.DOMAIN_CHECK_CRON || '0 * * * *';

    if (!cron.validate(expression)) {
      logger.error('Invalid PIPELINE_CRON expression', { expression });
      return;
    }

    this.task = cron.schedule(
      expression,
      async () => {
        logger.info('Scheduler tick', { at: nowYangon().toISO() });
        try {
          await this.pipeline.expireStaleMatches();
        } catch (err) {
          logger.warn('Scheduled expire failed', { error: err.message });
        }
        try {
          await this.pipeline.run({ forceStreamCheck: false });
        } catch (err) {
          logger.error('Scheduled pipeline failed', { error: err.message });
          try {
            const { getTelegramService } = require('./telegram.service');
            await getTelegramService().serverCrash(err);
          } catch {
            // ignore telegram failures
          }
        }
      },
      { timezone: 'Asia/Yangon' }
    );

    if (!cron.validate(highlightExpression)) {
      logger.error('Invalid HIGHLIGHT_CRON expression', { expression: highlightExpression });
    } else {
      this.highlightTask = cron.schedule(
        highlightExpression,
        async () => {
          logger.info('Highlight scheduler tick', {
            at: nowYangon().toISO(),
            expression: highlightExpression,
          });
          try {
            await this.pipeline.runHighlights({ force: false });
          } catch (err) {
            logger.error('Scheduled highlight job failed', { error: err.message });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (!cron.validate(channelsExpression)) {
      logger.error('Invalid MYANMARTV_CRON expression', { expression: channelsExpression });
    } else {
      this.channelsTask = cron.schedule(
        channelsExpression,
        async () => {
          logger.info('MyanmarTV scheduler tick', {
            at: nowYangon().toISO(),
            expression: channelsExpression,
          });
          try {
            await this.pipeline.runMyanmarTv({ force: false });
          } catch (err) {
            logger.error('Scheduled MyanmarTV job failed', { error: err.message });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (!cron.validate(tipsExpression)) {
      logger.error('Invalid TIPS_CRON expression', { expression: tipsExpression });
    } else {
      this.tipsTask = cron.schedule(
        tipsExpression,
        async () => {
          logger.info('Tips scheduler tick', {
            at: nowYangon().toISO(),
            expression: tipsExpression,
          });
          try {
            await this.pipeline.runTips({ force: false });
          } catch (err) {
            logger.error('Scheduled tips job failed', { error: err.message });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (this.env.DOMAIN_CHECK_ENABLED === 'false') {
      logger.info('Domain check scheduler disabled (DOMAIN_CHECK_ENABLED=false)');
    } else if (!cron.validate(domainExpression)) {
      logger.error('Invalid DOMAIN_CHECK_CRON expression', {
        expression: domainExpression,
      });
    } else {
      this.domainTask = cron.schedule(
        domainExpression,
        async () => {
          logger.info('Domain check scheduler tick', {
            at: nowYangon().toISO(),
            expression: domainExpression,
          });
          try {
            await this.domainMonitor.checkAll();
          } catch (err) {
            // Must never stop the scraper / other jobs
            logger.warn('Scheduled domain check failed (ignored)', {
              error: err.message,
            });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    logger.info('Scheduler started', {
      expression,
      highlightExpression,
      channelsExpression,
      tipsExpression,
      domainExpression,
      timezone: 'Asia/Yangon',
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    if (this.highlightTask) {
      this.highlightTask.stop();
      this.highlightTask = null;
    }
    if (this.channelsTask) {
      this.channelsTask.stop();
      this.channelsTask = null;
    }
    if (this.tipsTask) {
      this.tipsTask.stop();
      this.tipsTask = null;
    }
    if (this.domainTask) {
      this.domainTask.stop();
      this.domainTask = null;
    }
    logger.info('Scheduler stopped');
  }

  describeCadence(matches) {
    return (matches || []).map((m) => ({
      matchId: m.matchId,
      status: m.status,
      intervalMinutes: getCheckIntervalMinutes(m.kickoff, m.status),
    }));
  }
}

module.exports = { Scheduler };
