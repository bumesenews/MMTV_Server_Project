const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getCheckIntervalMinutes, nowYangon } = require('../utils/time');
const { DomainMonitor } = require('../monitor/domain.monitor');
const {
  DEFAULT_CRONS,
  isFootballPeakWindow,
  mayRunLowPriorityHeavyJob,
} = require('../utils/jobSchedule');
const {
  morningSlotName,
  shouldRunMorningSlot,
} = require('../utils/morningRetry');

/**
 * Job schedule (Asia/Yangon) — 1GB RAM safe:
 *
 * Matches (PIPELINE_CRON, default every 5 minutes)
 * └── expire kickoff+2h → Match URL (−60/−45/−30) → m3u8 (−30…+10) → publish
 *
 * Peak football window 17:00–03:00 Yangon:
 * └── Matches only among Highlights and Tips. Those jobs are skipped (no backlog).
 * Results still runs and waits if a match, highlight, or tips job is in progress.
 *
 * Morning scrapes, Asia/Yangon. The second time runs only when the first
 * scrape did not store new data:
 * └── Highlights 05:00, again 08:00
 * └── Results 06:00, again 10:00
 * └── Tips 07:00, again 11:00
 * Results defers while Matches, Highlights, or Tips are actually running.
 *
 * Domain check (DOMAIN_CHECK_CRON, default every hour) — lightweight, not a heavy scrape.
 *
 * At most ONE heavy scraper at a time (pipeline locks). Priority on contention:
 * Matches → Highlights → Tips → Results.
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
    const resultsExpression = this.env.RESULTS_CRON || DEFAULT_CRONS.RESULTS_CRON;
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
          if (!shouldRunMorningSlot('highlights', at)) {
            logger.info('Highlights already have new data today — skip 08:00 run');
            return;
          }
          try {
            await this.pipeline.runHighlights({
              force: false,
              slot: morningSlotName('highlights', at),
            });
          } catch (err) {
            logger.error('Scheduled highlight job failed', {
              error: err.message,
            });
          }
        },
        { timezone: 'Asia/Yangon' }
      );
    }

    if (!cron.validate(resultsExpression)) {
      logger.error('Invalid RESULTS_CRON expression', {
        expression: resultsExpression,
      });
    } else {
      this.channelsTask = cron.schedule(
        resultsExpression,
        async () => {
          const at = nowYangon();
          logger.info('Results scheduler tick', {
            at: at.toISO(),
            expression: resultsExpression,
            peak: isFootballPeakWindow(at),
          });
          if (!shouldRunMorningSlot('results', at)) {
            logger.info('Results already have new data today — skip 10:00 run');
            return;
          }
          try {
            await this.pipeline.runResults({
              slot: morningSlotName('results', at),
            });
          } catch (err) {
            logger.error('Scheduled results job failed', {
              stage: 'results',
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
          if (!shouldRunMorningSlot('tips', at)) {
            logger.info('Tips already have new data today — skip 11:00 run');
            return;
          }
          try {
            await this.pipeline.runTips({
              force: false,
              slot: morningSlotName('tips', at),
            });
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
      resultsExpression,
      tipsExpression,
      domainExpression,
      timezone: 'Asia/Yangon',
      peakWindow: '17:00–03:00 Asia/Yangon (Matches only)',
      heavyJobPriority: 'matches > highlights > tips > results',
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
