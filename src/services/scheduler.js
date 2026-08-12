const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getCheckIntervalMinutes, nowYangon } = require('../utils/time');
const { DomainMonitor } = require('../monitor/domain.monitor');

/**
 * Job schedule (Asia/Yangon):
 *
 * Main pipeline (PIPELINE_CRON)
 * └── matches.json
 *
 * Highlight Job (HIGHLIGHT_CRON, default every 3 hr)
 * └── Highlights → highlight.json
 *
 * MyanmarTV Job (MYANMARTV_CRON, default every 12 hr)
 * └── Channels → myanmartv.json
 *
 * Domain check (DOMAIN_CHECK_CRON, default every 30 min)
 * └── Enabled streaming source domains → Telegram alerts only
 */
class Scheduler {
  constructor(pipeline, env = process.env) {
    this.pipeline = pipeline;
    this.env = env;
    this.task = null;
    this.highlightTask = null;
    this.channelsTask = null;
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
    const channelsExpression = this.env.MYANMARTV_CRON || '0 */12 * * *';
    const domainExpression = this.env.DOMAIN_CHECK_CRON || '*/30 * * * *';

    if (!cron.validate(expression)) {
      logger.error('Invalid PIPELINE_CRON expression', { expression });
      return;
    }

    this.task = cron.schedule(
      expression,
      async () => {
        logger.info('Scheduler tick', { at: nowYangon().toISO() });
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
