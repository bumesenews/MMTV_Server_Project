const cron = require('node-cron');
const { logger } = require('../utils/logger');
const { getCheckIntervalMinutes, nowYangon } = require('../utils/time');

/**
 * Dynamic checking:
 * >30m before kickoff → every 30m
 * 30m before → every 5m
 * 10m before → every 1–2m
 * LIVE → every 5m
 * END → stop
 *
 * Implemented via a frequent tick that consults per-match intervals inside StreamEngine.
 *
 * Highlights: separate cron every 3 hours (00:00, 03:00, …, 21:00 Asia/Yangon).
 */
class Scheduler {
  constructor(pipeline, env = process.env) {
    this.pipeline = pipeline;
    this.env = env;
    this.task = null;
    this.highlightTask = null;
    this.tickMinutes = 1;
  }

  start() {
    const expression = this.env.PIPELINE_CRON || `*/${this.tickMinutes} * * * *`;
    // Every 3 hours on the hour — 00,03,06,09,12,15,18,21 Asia/Yangon
    const highlightExpression = this.env.HIGHLIGHT_CRON || '0 */3 * * *';

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

    logger.info('Scheduler started', {
      expression,
      highlightExpression,
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
    logger.info('Scheduler stopped');
  }

  /**
   * Helper for ops/debug: describe next recommended interval for a match list.
   */
  describeCadence(matches) {
    return (matches || []).map((m) => ({
      matchId: m.matchId,
      status: m.status,
      intervalMinutes: getCheckIntervalMinutes(m.kickoff, m.status),
    }));
  }
}

module.exports = { Scheduler };
