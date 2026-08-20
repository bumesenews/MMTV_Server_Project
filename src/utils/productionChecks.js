const { logger } = require('./logger');

const WEAK_SECRETS = new Set([
  '',
  'change-me-admin-jwt-secret',
  'YOUR_ADMIN_JWT_SECRET',
  'YOUR_API_KEY',
  'admin123',
  'YOUR_ADMIN_PASSWORD',
  'password',
  'secret',
]);

/**
 * Fail fast on unsafe production settings. Dev/local remains permissive.
 */
function assertProductionEnv(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() !== 'production') return;

  const jwtSecret = String(env.ADMIN_JWT_SECRET || '').trim();
  if (!jwtSecret || WEAK_SECRETS.has(jwtSecret)) {
    throw new Error(
      'Production requires a strong ADMIN_JWT_SECRET (set in .env). Refusing to start with a default/placeholder.'
    );
  }

  const adminPassword = String(env.ADMIN_PASSWORD || '').trim();
  if (!adminPassword || WEAK_SECRETS.has(adminPassword)) {
    throw new Error(
      'Production requires a strong ADMIN_PASSWORD (set in .env). Refusing to start with a default/placeholder.'
    );
  }

  if (!env.GITHUB_TOKEN) {
    logger.warn('GITHUB_TOKEN missing — Flutter JSON will not upload to GitHub');
  }

  if (!env.API_KEY && env.ENABLE_PUBLIC_JSON !== 'true') {
    logger.warn('API_KEY missing and ENABLE_PUBLIC_JSON is not true — API routes may be open or blocked unexpectedly');
  }

  if (!env.PUPPETEER_EXECUTABLE_PATH) {
    logger.warn(
      'PUPPETEER_EXECUTABLE_PATH unset — install google-chrome-stable on EC2 (not snap Chromium)'
    );
  } else if (/\/snap\/bin\//i.test(env.PUPPETEER_EXECUTABLE_PATH)) {
    logger.warn(
      'PUPPETEER_EXECUTABLE_PATH is snap Chromium — PM2 cannot launch it (snap cgroup). Use /usr/bin/google-chrome-stable'
    );
  }
}

module.exports = { assertProductionEnv, WEAK_SECRETS };
