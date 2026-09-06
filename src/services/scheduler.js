const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getCheckIntervalMinutes, nowYangon } = require('../utils/time');
const { DomainMonitor } = require('../monitor/domain.monitor');
const {
  DEFAULT_CRONS,
  isFootballPeakWindow,
  mayRunLowPriorityHeavyJob,
} = require('../utils/jobSchedule');

/**
 * Job schedule (Asia/Yangon) — 1GB RAM safe:
 *
 * Matches (PIPELINE_CRON, default every 5 minutes)
 * └── expire kickoff+2h → Match URL (−60/−45/−30) → m3u8 (−30…+10) → publish
 *
 * Peak football window 17:00–03:00 Yangon:
 * └── Matches only. Highlights / Tips / MyanmarTV are skipped (no backlog).
 *
 * Non-peak (once per day, staggered):
 * └── 03:00 MyanmarTV | 06:00 Highlights | 08:07 Tips
 *
 * Domain check (DOMAIN_CHECK_CRON, default every hour) — lightweight, not a heavy scrape.
 *
 * At most ONE heavy scraper at a time (pipeline locks). Priority on contention:
 * Matches → Highlights → Tips → MyanmarTV.
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
    const expression = this.env.PIPELINE_CRON || DEFAULT_CRONS.PIPELINE_CRON;
    const highlightExpression =
      this.env.HIGHLIGHT_CRON || DEFAULT_CRONS.HIGHLIGHT_CRON;
    const channelsExpression =
      this.env.MYANMARTV_CRON || DEFAULT_CRONS.MYANMARTV_CRON;
    const tipsExpression = this.env.TIPS_CRON || DEFAULT_CRONS.TIPS_CRON;
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
      logger.error('Invalid HIGHLIGHT_CRON expression', {
        expression: highlightExpression,
      });
    } else {
      this.highlightTask = cron.schedule(
        highlightExpression,
        async () => {
          const at = nowYangon();
          logger.info('Highlight scheduler tick', {
            at: at.toISO(),
            expression: highlightExpression,
            peak: isFootballPeakWindow(at),
          });
          if (!mayRunLowPriorityHeavyJob(at)) {
            logger.info(
              'Peak football window (17:00–03:00 Yangon) — skip Highlights'
            );
            return;
          }
          try {
            await this.pipeline.runHighlights({ force: false });
          } catch (err) {
            logger.error('Scheduled highlight job failed', {
              error: err.message,
            });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (!cron.validate(channelsExpression)) {
      logger.error('Invalid MYANMARTV_CRON expression', {
        expression: channelsExpression,
      });
    } else {
      this.channelsTask = cron.schedule(
        channelsExpression,
        async () => {
          const at = nowYangon();
          logger.info('MyanmarTV scheduler tick', {
            at: at.toISO(),
            expression: channelsExpression,
            peak: isFootballPeakWindow(at),
          });
          if (!mayRunLowPriorityHeavyJob(at)) {
            logger.info(
              'Peak football window (17:00–03:00 Yangon) — skip MyanmarTV'
            );
            return;
          }
          try {
            await this.pipeline.runMyanmarTv({ force: false });
          } catch (err) {
            logger.error('Scheduled MyanmarTV job failed', {
              error: err.message,
            });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (!cron.validate(tipsExpression)) {
      logger.error('Invalid TIPS_CRON expression', {
        expression: tipsExpression,
      });
    } else {
      this.tipsTask = cron.schedule(
        tipsExpression,
        async () => {
          const at = nowYangon();
          logger.info('Tips scheduler tick', {
            at: at.toISO(),
            expression: tipsExpression,
            peak: isFootballPeakWindow(at),
          });
          if (!mayRunLowPriorityHeavyJob(at)) {
            logger.info(
              'Peak football window (17:00–03:00 Yangon) — skip Tips'
            );
            return;
          }
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
      peakWindow: '17:00–03:00 Asia/Yangon (Matches only)',
      heavyJobPriority: 'matches > highlights > tips > myanmartv',
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
