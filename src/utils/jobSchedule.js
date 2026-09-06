/**
 * 1GB-safe heavy-job schedule helpers (Asia/Yangon).
 *
 * Peak football window: 17:00 → 03:00 (inclusive of 17:00, exclusive of 03:00).
 * During peak, only Matches (pipeline) may run among the four heavy scrapers.
 *
 * Priority when multiple heavy jobs contend:
 *   P0 Matches → P1 Highlights → P2 Tips → P3 Myanmar TV
 */
const { DateTime } = require('luxon');
const { ZONE, nowYangon } = require('./time');

const HEAVY_JOBS = Object.freeze({
  MATCHES: 'matches',
  HIGHLIGHTS: 'highlights',
  TIPS: 'tips',
  MYANMARTV: 'myanmartv',
});

const HEAVY_JOB_PRIORITY = Object.freeze({
  [HEAVY_JOBS.MATCHES]: 0,
  [HEAVY_JOBS.HIGHLIGHTS]: 1,
  [HEAVY_JOBS.TIPS]: 2,
  [HEAVY_JOBS.MYANMARTV]: 3,
});

/** Recommended production crons (Asia/Yangon). Matches stays every 5 minutes. */
const DEFAULT_CRONS = Object.freeze({
  PIPELINE_CRON: '*/5 * * * *',
  MYANMARTV_CRON: '0 3 * * *',
  HIGHLIGHT_CRON: '0 6 * * *',
  TIPS_CRON: '7 8 * * *',
});

/**
 * Peak = 17:00 Yangon through 02:59. Non-peak = 03:00–16:59.
 * @param {import('luxon').DateTime|Date|string|number|null} [when]
 */
function toYangonDt(when = null) {
  if (when == null) return nowYangon();
  if (DateTime.isDateTime(when)) return when.setZone(ZONE);
  if (typeof when === 'number') {
    const ms = when < 1e12 ? when * 1000 : when;
    return DateTime.fromMillis(ms, { zone: 'utc' }).setZone(ZONE);
  }
  if (when instanceof Date) {
    return DateTime.fromJSDate(when, { zone: 'utc' }).setZone(ZONE);
  }
  const iso = DateTime.fromISO(String(when), { setZone: true });
  if (iso.isValid) return iso.setZone(ZONE);
  return nowYangon();
}

function isFootballPeakWindow(when = null) {
  const hour = toYangonDt(when).hour;
  return hour >= 17 || hour < 3;
}

/** Lower-priority scrapers (not Matches) may run only outside the peak window. */
function mayRunLowPriorityHeavyJob(when = null, { force = false } = {}) {
  if (force) return true;
  return !isFootballPeakWindow(when);
}

/**
 * Sort due heavy jobs by priority (Matches first). Stable for equal ranks.
 * @param {string[]} jobs
 */
function prioritizeHeavyJobs(jobs = []) {
  return [...jobs].sort((a, b) => {
    const pa = HEAVY_JOB_PRIORITY[a];
    const pb = HEAVY_JOB_PRIORITY[b];
    const ra = pa == null ? 99 : pa;
    const rb = pb == null ? 99 : pb;
    return ra - rb;
  });
}

/**
 * Which of the due jobs should run now under peak + one-at-a-time rules.
 * Returns null if nothing should start (e.g. only low-priority due during peak).
 */
function selectNextHeavyJob(dueJobs = [], { when = null, force = false } = {}) {
  const ordered = prioritizeHeavyJobs(dueJobs);
  for (const job of ordered) {
    if (job === HEAVY_JOBS.MATCHES) return job;
    if (mayRunLowPriorityHeavyJob(when, { force })) return job;
  }
  return null;
}

module.exports = {
  ZONE,
  HEAVY_JOBS,
  HEAVY_JOB_PRIORITY,
  DEFAULT_CRONS,
  isFootballPeakWindow,
  mayRunLowPriorityHeavyJob,
  prioritizeHeavyJobs,
  selectNextHeavyJob,
};
