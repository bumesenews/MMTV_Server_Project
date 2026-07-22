require('dotenv').config();

const { logger } = require('../utils/logger');
const { Pipeline } = require('../services/pipeline');

async function main() {
  const force = process.argv.includes('--force');
  const highlightsOnly = process.argv.includes('--highlights');
  const channelsOnly =
    process.argv.includes('--channels') || process.argv.includes('--myanmartv');
  const pipeline = new Pipeline(process.env);

  if (highlightsOnly) {
    logger.info('CLI highlight job', { force });
    const result = await pipeline.runHighlights({ force });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          reason: result.reason,
          uploaded: result.uploaded,
          stats: result.stats,
          github: result.github,
          count: result.delivery?.count,
        },
        null,
        2
      )
    );
    process.exit(result.ok ? 0 : 1);
  }

  if (channelsOnly) {
    logger.info('CLI MyanmarTV job', { force });
    const result = await pipeline.runMyanmarTv({ force });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          reason: result.reason,
          uploaded: result.uploaded,
          github: result.github,
          count: Array.isArray(result.delivery) ? result.delivery.length : 0,
        },
        null,
        2
      )
    );
    process.exit(result.ok ? 0 : 1);
  }

  logger.info('CLI pipeline run', { force });
  const result = await pipeline.run({ forceStreamCheck: force });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: result.ok,
    reason: result.reason,
    matchCount: result.payload?.matches?.length ?? result.kept?.matches?.length ?? 0,
    changed: result.changed,
    github: result.github,
    durationMs: result.durationMs,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  logger.error('CLI failed', { error: err.message });
  process.exit(1);
});
