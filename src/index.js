require('dotenv').config();

const { logger } = require('./utils/logger');
const { Pipeline } = require('./services/pipeline');
const { Scheduler } = require('./services/scheduler');
const { createApp } = require('./app');
const { createAdminContext } = require('./admin/services/adminContext');

async function main() {
  const pipeline = new Pipeline(process.env);
  const { cache, github } = pipeline;

  const admin = createAdminContext({ pipeline, cache, github, env: process.env });
  await admin.users.ensureSeedAdmin();
  pipeline.attachAdmin(admin);

  const app = createApp({ pipeline, cache, admin, env: process.env });
  const port = Number(process.env.PORT || 3000);

  const server = app.listen(port, () => {
    logger.info(`API listening on :${port}`, {
      timezone: 'Asia/Yangon',
      adminPanel: `http://localhost:${port}/admin`,
    });
  });

  const scheduler = new Scheduler(pipeline, process.env);
  scheduler.start();

  setTimeout(() => {
    pipeline.run({ forceStreamCheck: true }).catch((err) => {
      logger.error('Initial pipeline run failed', { error: err.message });
    });
  }, 3000);

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    scheduler.stop();
    server.close();
    try {
      await pipeline.browser.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
