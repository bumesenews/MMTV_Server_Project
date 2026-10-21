const fs = require('fs');
const path = require('path');
const { formatDate, nowYangon, toYangon } = require('./time');
const { MORNING_FEEDS } = require('./jobSchedule');

function stateFile() {
  return path.resolve(
    process.cwd(),
    process.env.MORNING_RETRY_PATH || './data/schedule/morning-retry.json'
  );
}

function wall(when) {
  if (when == null) return nowYangon();
  return toYangon(when) || nowYangon();
}

function readState(file = stateFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state, file = stateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

/**
 * Once a Yangon day has fresh data, a later empty run keeps that flag.
 * @param {object} state
 * @param {'highlights'|'results'|'tips'} feed
 * @param {boolean} fresh
 */
function applyMorningResult(state, feed, when, fresh) {
  const date = formatDate(wall(when));
  const prev = state?.[feed];
  if (prev && prev.date === date && prev.fresh === true) return state || {};
  return { ...(state || {}), [feed]: { date, fresh: Boolean(fresh) } };
}

/** Primary hours always run. The retry hour runs when today is not already fresh. */
function morningSlotShouldRun(feed, when, state) {
  const spec = MORNING_FEEDS[feed];
  if (!spec) return true;
  const dt = wall(when);
  if (dt.hour !== spec.retryHour) return true;
  const row = state?.[feed];
  return !(row && row.date === formatDate(dt) && row.fresh === true);
}

function morningSlotName(feed, when) {
  const spec = MORNING_FEEDS[feed];
  if (!spec) return 'scheduled';
  const hour = wall(when).hour;
  if (hour === spec.primaryHour) return 'primary';
  if (hour === spec.retryHour) return 'retry';
  return 'scheduled';
}

function markMorningFeed(feed, { fresh } = {}, when = null) {
  const file = stateFile();
  writeState(applyMorningResult(readState(file), feed, when, fresh), file);
}

function morningFeedIsFresh(feed, when = null) {
  const row = readState()?.[feed];
  return Boolean(row && row.date === formatDate(wall(when)) && row.fresh === true);
}

function shouldRunMorningSlot(feed, when = null) {
  return morningSlotShouldRun(feed, when, readState());
}

module.exports = {
  applyMorningResult,
  morningSlotShouldRun,
  morningSlotName,
  markMorningFeed,
  morningFeedIsFresh,
  shouldRunMorningSlot,
};
