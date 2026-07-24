#!/usr/bin/env node
/**
 * Simulate Telegram alerts (force-send, bypasses cooldown).
 *
 * Usage:
 *   node src/cli/testTelegramAlerts.js
 *   node src/cli/testTelegramAlerts.js server_start
 *   node src/cli/testTelegramAlerts.js all
 */
require('dotenv').config();

const { getTelegramService } = require('../services/telegram.service');
const { SystemMonitor } = require('../monitor/system.monitor');

const ACTIONS = {
  server_start: async (tg) => tg.serverStarted(),
  server_crash: async (tg) => tg.serverCrash(new Error('Simulated crash for Telegram test')),
  scraper_failed: async (tg) =>
    tg.scraperFailed('xoilac', new Error('Simulated scraper failure')),
  github_failed: async (tg) =>
    tg.githubUploadFailed(
      `${process.env.GITHUB_OWNER || 'owner'}/${process.env.GITHUB_REPO || 'repo'}`,
      new Error('Simulated GitHub upload failure'),
      { feed: 'matches' }
    ),
  pm2_restart: async (tg) =>
    tg.pm2Restart({ processName: process.env.PM2_PROCESS_NAME || 'football-streaming', restartCount: 99 }),
  high_memory: async (tg) => {
    const mon = new SystemMonitor({ telegram: tg });
    const snap = mon.getMemorySnapshot();
    return tg.highMemory({
      memoryPercent: Math.max(snap.systemPct, Number(process.env.MEMORY_LIMIT || 85) + 5),
      processName: process.env.PM2_PROCESS_NAME || 'football-streaming',
    });
  },
  website_timeout: async (tg) =>
    tg.websiteTimeout({ website: 'https://example-stream.test', timeoutSec: 30 }),
  all_sources_failed: async (tg) =>
    tg.allSourcesFailed({
      sources: ['luongson', 'xoilac', 'soco'],
      error: 'Simulated all-sources failure',
    }),
  daily_report: async (tg) =>
    tg.dailyReport({
      date: new Date().toISOString().slice(0, 10),
      scraperOk: true,
      failedCount: 2,
      githubOk: true,
      apiOnline: true,
      totalMatches: 120,
    }),
};

async function main() {
  const tg = getTelegramService();
  if (!tg.configured) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
    process.exit(1);
  }

  const arg = String(process.argv[2] || 'all').trim();
  const keys = arg === 'all' ? Object.keys(ACTIONS) : [arg];

  for (const key of keys) {
    const fn = ACTIONS[key];
    if (!fn) {
      console.error(`Unknown alert: ${key}`);
      console.error(`Available: ${Object.keys(ACTIONS).join(', ')}, all`);
      process.exit(1);
    }
    // Force by temporarily using sendAlert force via public methods that use force where needed.
    // For methods without force, clear cooldown key state.
    if (tg.state?.alerts) {
      for (const k of Object.keys(tg.state.alerts)) {
        if (k === key || k.startsWith(`${key}:`) || k.includes(key.replace(/_/g, ''))) {
          delete tg.state.alerts[k];
        }
      }
      // Broader clear for mapped keys
      delete tg.state.alerts.server_start;
      delete tg.state.alerts.server_crash;
      delete tg.state.alerts['scraper_failed:xoilac'];
      delete tg.state.alerts.github_upload_failed;
      delete tg.state.alerts.pm2_restart;
      delete tg.state.alerts.high_memory;
      delete tg.state.alerts['website_timeout:https://example-stream.test'];
      delete tg.state.alerts.all_sources_failed;
      delete tg.state.alerts.daily_report;
      tg._saveState();
    }

    const result = await fn(tg);
    console.log(key, result);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
