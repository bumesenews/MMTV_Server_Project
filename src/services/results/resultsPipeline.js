const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { logger } = require('../../utils/logger');
const { ZONE, nowYangon } = require('../../utils/time');
const { hasDataChanged } = require('../../utils/compare');
const {
  SOURCE_PAGE,
  resultDates,
  fetchRecentResults,
  buildResultsDelivery,
} = require('./resultsSource');

const LOCK_MS = 15 * 60 * 1000;
let inProcess = false;
let inProcessSince = 0;

function statusPath(env = process.env) {
  return path.resolve(process.cwd(), env.RESULTS_STATE_PATH || './data/results/status.json');
}

function readStatus(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(env), 'utf8'));
  } catch {
    return {
      sourceStatus: 'unknown',
      lastScrapeAt: null,
      lastGithubDeliveryAt: null,
      lastGithubStatus: null,
      lastRunAt: null,
      lastRunStatus: null,
      count: 0,
      lastError: null,
    };
  }
}

function writeStatus(status, env = process.env) {
  const file = statusPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

function resultsHaveNewData(previous, next) {
  const count = Number(next?.count) || 0;
  if (!count) return false;
  if (!previous) return true;
  return hasDataChanged(previous, next);
}

function createResultsPipeline({ env = process.env, cache, github, fetchDay = fetchRecentResults } = {}) {
  return {
    async run({ isHigherPriorityBusy = () => false, now = null } = {}) {
      const nowDt = now && DateTime.isDateTime(now) ? now.setZone(ZONE) : nowYangon();
      const at = nowDt.toISO();
      if (inProcess && Date.now() - inProcessSince < LOCK_MS) {
        return { ok: false, reason: 'already_running' };
      }
      if (inProcess) {
        inProcess = false;
      }
      if (isHigherPriorityBusy()) {
        const status = readStatus(env);
        status.lastRunAt = at;
        status.lastRunStatus = 'deferred';
        writeStatus(status, env);
        logger.info('Results deferred', { stage: 'results', at });
        return { ok: false, reason: 'deferred', deferred: true };
      }

      inProcess = true;
      inProcessSince = Date.now();
      const status = readStatus(env);
      try {
        const dates = resultDates(nowDt);
        const allowed = new Set(dates);
        const merged = [];
        const seen = new Set();
        for (const date of dates) {
          const rows = await fetchDay(date, env);
          for (const row of rows) {
            if (!allowed.has(row.date) || seen.has(row.id)) continue;
            seen.add(row.id);
            merged.push(row);
          }
        }
        merged.sort((a, b) => String(b.kickoff).localeCompare(String(a.kickoff)));
        const payload = buildResultsDelivery(merged, { generatedAt: at, source: SOURCE_PAGE });
        const previous = cache?.getDelivery ? cache.getDelivery('results') : null;
        if (cache?.saveDeliveryBundle) cache.saveDeliveryBundle({ results: payload });
        let githubResult = { uploaded: false, reason: 'not_configured' };
        if (github?.uploadJsonIfChanged && github.paths?.results) {
          githubResult = await github.uploadJsonIfChanged(github.paths.results, payload, {
            previousLocal: previous,
            feedKey: 'results',
            allowEmpty: true,
          });
        }
        status.sourceStatus = 'ok';
        status.lastScrapeAt = at;
        status.lastRunAt = at;
        status.lastRunStatus = 'ok';
        status.count = payload.count;
        status.lastError = null;
        status.dates = dates;
        if (githubResult.uploaded) status.lastGithubDeliveryAt = at;
        status.lastGithubStatus = githubResult.reason || (githubResult.uploaded ? 'changed' : 'skipped');
        writeStatus(status, env);
        logger.info('Results job completed', {
          stage: 'results',
          at,
          count: payload.count,
          github: status.lastGithubStatus,
        });
        return {
          ok: true,
          delivery: payload,
          github: githubResult,
          changed: resultsHaveNewData(previous, payload),
        };
      } catch (err) {
        const message = String(err.message || 'results_failed').slice(0, 300);
        status.sourceStatus = 'error';
        status.lastRunAt = at;
        status.lastRunStatus = 'error';
        status.lastError = { stage: 'fetch', message, at };
        writeStatus(status, env);
        logger.error('Results job failed', { stage: 'results', at, error: message });
        return { ok: false, reason: message, changed: false };
      } finally {
        inProcess = false;
        inProcessSince = 0;
      }
    },
  };
}

function readResultsStatus(env = process.env) {
  const status = readStatus(env);
  return {
    timezone: ZONE,
    source: SOURCE_PAGE,
    sourceStatus: status.sourceStatus || 'unknown',
    count: Number(status.count) || 0,
    dates: status.dates || [],
    lastScrapeAt: status.lastScrapeAt || null,
    lastGithubDeliveryAt: status.lastGithubDeliveryAt || null,
    lastGithubStatus: status.lastGithubStatus || null,
    lastRunAt: status.lastRunAt || null,
    lastRunStatus: status.lastRunStatus || null,
    lastError: status.lastError || null,
  };
}

module.exports = {
  createResultsPipeline,
  readResultsStatus,
};
