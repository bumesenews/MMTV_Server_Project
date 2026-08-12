const { DateTime } = require('luxon');

const ZONE = 'Asia/Yangon';

function nowYangon() {
  return DateTime.now().setZone(ZONE);
}

function toYangon(input) {
  if (!input) return null;
  if (DateTime.isDateTime(input)) return input.setZone(ZONE);

  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input;
    return DateTime.fromMillis(ms, { zone: 'utc' }).setZone(ZONE);
  }

  const raw = String(input).trim();
  const formats = [
    "yyyy-MM-dd'T'HH:mm:ss.SSSZZ",
    "yyyy-MM-dd'T'HH:mm:ssZZ",
    "yyyy-MM-dd'T'HH:mm:ss",
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd',
    'dd/MM/yyyy HH:mm',
    'dd-MM-yyyy HH:mm',
  ];

  for (const fmt of formats) {
    const dt = DateTime.fromFormat(raw, fmt, { zone: ZONE });
    if (dt.isValid) return dt;
  }

  const iso = DateTime.fromISO(raw, { setZone: true });
  if (iso.isValid) return iso.setZone(ZONE);

  const js = DateTime.fromJSDate(new Date(raw), { zone: ZONE });
  return js.isValid ? js : null;
}

function combineDateAndTime(dateStr, timeStr) {
  const datePart = String(dateStr || '').trim();
  let timePart = String(timeStr || '00:00').trim();
  if (/^\d{1,2}:\d{2}$/.test(timePart)) {
    const [h, m] = timePart.split(':');
    timePart = `${h.padStart(2, '0')}:${m}`;
  }
  return toYangon(`${datePart} ${timePart}`);
}

function formatDate(dt) {
  const d = toYangon(dt);
  return d ? d.toFormat('yyyy-MM-dd') : null;
}

function formatTime(dt) {
  const d = toYangon(dt);
  return d ? d.toFormat('HH:mm') : null;
}

function formatKickoffId(dt) {
  const d = toYangon(dt);
  return d ? d.toFormat('yyyyMMdd') : 'unknown';
}

function todayYangon() {
  return nowYangon().startOf('day');
}

function tomorrowYangon() {
  return todayYangon().plus({ days: 1 });
}

function isTodayOrTomorrow(dt) {
  const d = toYangon(dt);
  if (!d) return false;
  const day = d.startOf('day');
  return day.equals(todayYangon()) || day.equals(tomorrowYangon());
}

function minutesUntilKickoff(kickoff) {
  const k = toYangon(kickoff);
  if (!k) return null;
  return Math.round(k.diff(nowYangon(), 'minutes').minutes);
}

function isKickoffStarted(kickoff) {
  const mins = minutesUntilKickoff(kickoff);
  return mins !== null && mins <= 0;
}

/** Minutes before kickoff to begin stream search (first slot). */
const STREAM_FIND_LEAD_MIN = 30;
/** Legacy alias — second pre-kickoff checkpoint. */
const STREAM_RETRY_LEAD_MIN = 15;
/** Stop all stream searching this many minutes after kickoff. */
const STREAM_SEARCH_STOP_AFTER_MIN = 15;
/** Match stays LIVE until this many minutes after kickoff; then END + drop streams. */
const MATCH_LIVE_DURATION_MIN = 120;

/**
 * Kickoff-relative search slots (minutes until kickoff).
 * Search at: -30, -15, -5, 0, +5, +10. Stop at +15.
 */
const STREAM_SEARCH_SLOTS = [
  { id: 't30', minExclusive: 15, maxInclusive: 30, postKickoff: false },
  { id: 't15', minExclusive: 5, maxInclusive: 15, postKickoff: false },
  { id: 't5', minExclusive: 0, maxInclusive: 5, postKickoff: false },
  { id: 't0', minExclusive: -5, maxInclusive: 0, postKickoff: true },
  { id: 'tP5', minExclusive: -10, maxInclusive: -5, postKickoff: true },
  { id: 'tP10', minExclusive: -15, maxInclusive: -10, postKickoff: true },
];

/**
 * Resolve which search slot the match is currently in (or null if outside window).
 */
function resolveStreamSearchSlot(kickoff) {
  const mins = minutesUntilKickoff(kickoff);
  if (mins == null) return null;
  if (mins > STREAM_FIND_LEAD_MIN) return null;
  if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) return null;
  for (const slot of STREAM_SEARCH_SLOTS) {
    if (mins <= slot.maxInclusive && mins > slot.minExclusive) return slot;
  }
  return null;
}

function isStreamSearchStopped(kickoff, streamSearch) {
  if (streamSearch?.stopped) return true;
  const mins = minutesUntilKickoff(kickoff);
  return mins != null && mins <= -STREAM_SEARCH_STOP_AFTER_MIN;
}

/**
 * Dynamic stream-check interval for matches.json (fixture kickoff based).
 * Hits kickoff-relative search slots; does not use fixed clock times.
 */
function getCheckIntervalMinutes(kickoff, status) {
  if (status === 'END') return null;

  const mins = minutesUntilKickoff(kickoff);
  if (mins === null) return 30;

  // After search stop (+15) but before END (+120): light status refresh only
  if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) {
    if (status === 'LIVE' || status === 'PREPARING_STREAM') return 5;
    return null;
  }

  // Inside active search window (−30 .. +15): poll often enough to hit each slot
  if (mins <= STREAM_FIND_LEAD_MIN) return 2;

  // Far from kickoff
  return 15;
}

/**
 * Time-only phase helper (no stream knowledge).
 * Full match status (incl. PREPARING_STREAM / LIVE) lives in statusService.
 *
 * Scheduled → before kickoff
 * POST_KICKOFF → kickoff .. kickoff+120m
 * END → after +120m
 */
function resolveFixtureStatus(kickoff) {
  const mins = minutesUntilKickoff(kickoff);
  if (mins == null) return 'Scheduled';
  if (mins > 0) return 'Scheduled';
  if (mins > -MATCH_LIVE_DURATION_MIN) return 'POST_KICKOFF';
  return 'END';
}

module.exports = {
  ZONE,
  nowYangon,
  toYangon,
  combineDateAndTime,
  formatDate,
  formatTime,
  formatKickoffId,
  todayYangon,
  tomorrowYangon,
  isTodayOrTomorrow,
  minutesUntilKickoff,
  isKickoffStarted,
  getCheckIntervalMinutes,
  resolveFixtureStatus,
  resolveStreamSearchSlot,
  isStreamSearchStopped,
  STREAM_FIND_LEAD_MIN,
  STREAM_RETRY_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  STREAM_SEARCH_SLOTS,
  MATCH_LIVE_DURATION_MIN,
};
