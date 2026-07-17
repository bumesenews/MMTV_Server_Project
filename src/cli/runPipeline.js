require('dotenv').config();

const { logger } = require('../utils/logger');
const { Pipeline } = require('../services/pipeline');

async function main() {
  const force = process.argv.includes('--force');
  const pipeline = new Pipeline(process.env);
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
