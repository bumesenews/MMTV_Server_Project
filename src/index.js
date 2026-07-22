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
  // Bind all interfaces so EC2 public IP / security-group:3000 can reach the admin panel
  const host = process.env.HOST || '0.0.0.0';

  const server = app.listen(port, host, () => {
    logger.info(`API listening on http://${host}:${port}`, {
      timezone: 'Asia/Yangon',
      adminPanel: `http://${host}:${port}/admin`,
    });
  });

  const scheduler = new Scheduler(pipeline, process.env);
  scheduler.start();

  // Boot: one job at a time (1GB EC2). Light first pipeline, then highlights.
  // Avoid forceStreamCheck:true — it deep-scrapes ~3h of fixtures and OOMs t3.micro.
  setTimeout(() => {
    pipeline
      .run({ forceStreamCheck: false })
      .catch((err) => {
        logger.error('Initial pipeline run failed', { error: err.message });
      })
      .finally(() => {
        setTimeout(() => {
          pipeline.runHighlights({ force: false }).catch((err) => {
            logger.error('Initial highlight job failed', { error: err.message });
          });
        }, 5000);
      });
  }, 5000);

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
