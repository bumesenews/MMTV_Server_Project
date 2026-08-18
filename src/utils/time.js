const { DateTime } = require('luxon');
const {
  STREAM_FIND_LEAD_MIN,
  MATCH_URL_LEAD_MIN,
  STREAM_EXTRACT_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  STREAM_SEARCH_INTERVAL_MINUTES,
  MATCH_URL_MAX_ATTEMPTS,
  MATCH_URL_SEARCH_SLOTS,
  MATCH_URL_EARLY_SLOT,
  STREAM_SEARCH_SLOTS,
} = require('./scraperConfig');

const ZONE = 'Asia/Yangon';

function nowYangon() {
  return DateTime.now().setZone(ZONE);
}

function nowUtcUnixSeconds() {
  return Math.floor(DateTime.utc().toSeconds());
}

/**
 * Parse kickoff into Asia/Yangon DateTime.
 * ISO strings with Z / explicit offsets are treated as absolute instants (UTC-safe).
 * Naive date/time strings are interpreted as Yangon wall clock.
 */
function toYangon(input) {
  if (!input) return null;
  if (DateTime.isDateTime(input)) return input.setZone(ZONE);

  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input;
    return DateTime.fromMillis(ms, { zone: 'utc' }).setZone(ZONE);
  }

  const raw = String(input).trim();

  // Prefer true ISO / RFC3339 parsing first so "...Z" and offsets stay absolute UTC
  // instants (avoids mis-reading a UTC timestamp as Yangon wall time).
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const isoInstant = DateTime.fromISO(raw, { setZone: true });
    if (isoInstant.isValid) return isoInstant.setZone(ZONE);
  }

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

  const js = DateTime.fromJSDate(new Date(raw));
  return js.isValid ? js.setZone(ZONE) : null;
}

/**
 * Kickoff → UTC unix seconds (null if unparseable).
 * Use this for all currentTime vs kickoffTime comparisons.
 */
function toUtcUnixSeconds(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input < 1e12 ? Math.floor(input) : Math.floor(input / 1000);
  }
  const dt = toYangon(input);
  if (!dt || !dt.isValid) return null;
  return Math.floor(dt.toUTC().toSeconds());
}

function combineDateAndTime(dateStr, timeStr) {
  const datePart = String(dateStr || '').trim();
  let timePart = String(timeStr || '00:00').trim();
  const ampm = timePart.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2];
    const period = ampm[3].toUpperCase();
    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    timePart = `${String(hour).padStart(2, '0')}:${minute}`;
  } else if (/^\d{1,2}:\d{2}$/.test(timePart)) {
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

/** Display clock for matches.json, e.g. 17:00 → "5:00 PM". */
function formatTime12(dt) {
  const d = toYangon(dt);
  return d ? d.toFormat('h:mm a') : null;
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

function minutesUntilKickoff(kickoff, nowSec = nowUtcUnixSeconds()) {
  const kickSec = toUtcUnixSeconds(kickoff);
  if (kickSec == null) return null;
  return Math.round((kickSec - nowSec) / 60);
}

function isKickoffStarted(kickoff, nowSec = nowUtcUnixSeconds()) {
  const mins = minutesUntilKickoff(kickoff, nowSec);
  return mins !== null && mins <= 0;
}

/** Legacy alias — second pre-kickoff Match URL checkpoint. */
const STREAM_RETRY_LEAD_MIN = MATCH_URL_SEARCH_SLOTS[1]?.maxInclusive || 45;
/** Match stays LIVE until this many minutes after kickoff; then END + drop streams. */
const MATCH_LIVE_DURATION_MIN = 120;
/**
 * Max |FotMob kickoff − streaming URL kickoff| (minutes) after both are in
 * the canonical timezone (Asia/Yangon). Configurable via MATCH_TIME_TOLERANCE_MIN.
 */
const MATCH_TIME_TOLERANCE_MIN = Math.max(
  0,
  Number(process.env.MATCH_TIME_TOLERANCE_MIN || 10)
);

/**
 * Resolve which Match URL discovery slot the fixture is in.
 * Default: −60 / −45 / −30 (max 3). Optional tEarly only if enabled.
 * Null at/after kickoff.
 */
function resolveMatchUrlSearchSlot(kickoff, nowSec = nowUtcUnixSeconds()) {
  const mins = minutesUntilKickoff(kickoff, nowSec);
  if (mins == null) return null;
  if (mins <= 0) return null;
  if (mins > MATCH_URL_LEAD_MIN) {
    if (
      MATCH_URL_EARLY_SLOT &&
      mins <= MATCH_URL_EARLY_SLOT.maxInclusive &&
      mins > MATCH_URL_EARLY_SLOT.minExclusive
    ) {
      return MATCH_URL_EARLY_SLOT;
    }
    return null;
  }
  for (const slot of MATCH_URL_SEARCH_SLOTS) {
    if (mins <= slot.maxInclusive && mins > slot.minExclusive) return slot;
  }
  return null;
}

/**
 * After kickoff, keep hunting Match URLs while the match is still LIVE (up to +2h).
 * ASEAN / friendlies often appear on Today pages only at or after kickoff.
 */
function resolveMatchUrlLiveSlot(kickoff, nowSec = nowUtcUnixSeconds()) {
  const mins = minutesUntilKickoff(kickoff, nowSec);
  if (mins == null || mins > 0) return null;
  if (mins <= -MATCH_LIVE_DURATION_MIN) return null;
  return {
    id: 'tLive',
    live: true,
    postKickoff: true,
    minExclusive: -MATCH_LIVE_DURATION_MIN,
    maxInclusive: 0,
  };
}

function resolveAnyMatchUrlSlot(kickoff, nowSec = nowUtcUnixSeconds()) {
  return resolveMatchUrlSearchSlot(kickoff, nowSec) || resolveMatchUrlLiveSlot(kickoff, nowSec);
}

/**
 * Resolve the m3u8 extract slot: −30 / −15 / −5, then kickoff / +5 / +10.
 * Returns null before −30m and at/after the +15 stop.
 */
function resolveStreamSearchSlot(kickoff, nowSec = nowUtcUnixSeconds()) {
  const mins = minutesUntilKickoff(kickoff, nowSec);
  if (mins == null) return null;
  if (mins > STREAM_EXTRACT_LEAD_MIN) return null;
  if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) return null;
  for (const slot of STREAM_SEARCH_SLOTS) {
    if (mins <= slot.maxInclusive && mins > slot.minExclusive) return slot;
  }
  return null;
}

function isStreamSearchStopped(kickoff, streamSearch, nowSec = nowUtcUnixSeconds()) {
  if (streamSearch?.stopped) return true;
  const mins = minutesUntilKickoff(kickoff, nowSec);
  return mins != null && mins <= -STREAM_SEARCH_STOP_AFTER_MIN;
}

/**
 * Dynamic stream-check interval for matches.json (fixture kickoff based).
 * Hits kickoff-relative search slots; does not use fixed clock times.
 */
function getCheckIntervalMinutes(kickoff, status, nowSec = nowUtcUnixSeconds()) {
  if (status === 'END') return null;

  const mins = minutesUntilKickoff(kickoff, nowSec);
  if (mins === null) return 30;

  // After search stop (+15) but before END (+120): light status refresh only
  if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) {
    if (status === 'LIVE' || status === 'PREPARING_STREAM') return 5;
    return null;
  }

  // Inside Match URL / stream-search window (−60 .. +15)
  if (mins <= MATCH_URL_LEAD_MIN) return STREAM_SEARCH_INTERVAL_MINUTES;

  // Far from kickoff
  return 15;
}

/**
 * Time-only phase helper (no stream knowledge).
 * Full match status (incl. PREPARING_STREAM / LIVE) lives in statusService.
 *
 * Scheduled → more than MATCH_URL_LEAD_MIN before kickoff
 * PREPARING → kickoff−lead .. kickoff
 * POST_KICKOFF / LIVE window → kickoff .. kickoff+120m
 * END → after +120m
 */
function resolveFixtureStatus(kickoff, nowSec = nowUtcUnixSeconds()) {
  const kickSec = toUtcUnixSeconds(kickoff);
  if (kickSec == null) return 'Scheduled';
  const preparingFrom = kickSec - MATCH_URL_LEAD_MIN * 60;
  const liveUntil = kickSec + MATCH_LIVE_DURATION_MIN * 60;

  if (nowSec < preparingFrom) return 'Scheduled';
  if (nowSec < kickSec) return 'PREPARING';
  if (nowSec < liveUntil) return 'POST_KICKOFF';
  return 'END';
}

module.exports = {
  ZONE,
  nowYangon,
  nowUtcUnixSeconds,
  toYangon,
  toUtcUnixSeconds,
  combineDateAndTime,
  formatDate,
  formatTime,
  formatTime12,
  formatKickoffId,
  todayYangon,
  tomorrowYangon,
  isTodayOrTomorrow,
  minutesUntilKickoff,
  isKickoffStarted,
  getCheckIntervalMinutes,
  resolveFixtureStatus,
  resolveStreamSearchSlot,
  resolveMatchUrlSearchSlot,
  resolveMatchUrlLiveSlot,
  resolveAnyMatchUrlSlot,
  isStreamSearchStopped,
  STREAM_FIND_LEAD_MIN,
  MATCH_URL_LEAD_MIN,
  STREAM_EXTRACT_LEAD_MIN,
  STREAM_RETRY_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  STREAM_SEARCH_SLOTS,
  MATCH_URL_SEARCH_SLOTS,
  MATCH_URL_EARLY_SLOT,
  STREAM_SEARCH_INTERVAL_MINUTES,
  MATCH_TIME_TOLERANCE_MIN,
  MATCH_URL_MAX_ATTEMPTS,
  MATCH_LIVE_DURATION_MIN,
};
