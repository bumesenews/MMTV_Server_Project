const fs = require('fs');
const path = require('path');
const winston = require('winston');

const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const logger = winston.createLogger({
  levels,
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      const base = `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
      return stack ? `${base}\n${stack}` : base;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

const events = {
  SCRAPER_START: 'scraper_start',
  SCRAPER_SUCCESS: 'scraper_success',
  SCRAPER_ERROR: 'scraper_error',
  FIXTURES_FOUND: 'fixtures_found',
  LEAGUE_FILTERED: 'league_filtered',
  TEAM_NORMALIZED: 'team_normalized',
  DUPLICATE_MERGED: 'duplicate_merged',
  STREAM_FOUND: 'stream_found',
  VALIDATION_RESULT: 'validation_result',
  STATUS_CHANGED: 'status_changed',
  GITHUB_UPLOAD: 'github_upload',
  GITHUB_SKIPPED: 'github_skipped',
};

function logEvent(event, message, meta = {}) {
  logger.info(message, { event, ...meta });
}

module.exports = { logger, logEvent, events };
