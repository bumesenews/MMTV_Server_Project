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

/** Minutes before kickoff to first look for streaming URLs (e.g. 05:00 for 05:30). */
const STREAM_FIND_LEAD_MIN = 30;
/** Second attempt if first find failed. */
const STREAM_RETRY_LEAD_MIN = 15;
/** Match stays LIVE until this many minutes after kickoff; then END + drop streams. */
const MATCH_LIVE_DURATION_MIN = 120;

/**
 * Dynamic stream-check interval for matches.json (fixture kickoff based).
 * - Far out: every 30m
 * - At −30m window: every 5m
 * - At −15m / near kickoff: every 2m
 * - PREPARING_STREAM: every 2m (keep looking for a valid URL)
 * - LIVE: every 5m
 * - END: stop
 *
 * Note: Scheduled / PREPARING_STREAM / LIVE / END for matches.json is resolved
 * in statusService (kickoff + valid stream). This helper only drives check cadence.
 */
function getCheckIntervalMinutes(kickoff, status) {
  if (status === 'END') return null;
  if (status === 'PREPARING_STREAM') return 2;
  if (status === 'LIVE') return 5;

  const mins = minutesUntilKickoff(kickoff);
  if (mins === null) return 30;
  if (mins <= STREAM_RETRY_LEAD_MIN) return 2;
  if (mins <= STREAM_FIND_LEAD_MIN) return 5;
  return 30;
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
  STREAM_FIND_LEAD_MIN,
  STREAM_RETRY_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
};
