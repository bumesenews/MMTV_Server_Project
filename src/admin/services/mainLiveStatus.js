const {
  toYangon,
  toUtcUnixSeconds,
  nowUtcUnixSeconds,
} = require('../../utils/time');
const {
  LIVE_BEFORE_MIN,
  LIVE_UNTIL_AFTER_MIN,
  PREPARING_LEAD_MIN,
  resolveAutoClockStatus,
} = require('../../utils/autoLiveStatus');

/** Same clock as SecondLive. Live from kickoff−5 only with a valid stream URL. */
const MAINLIVE_STATUS_LIVE_BEFORE_MIN = LIVE_BEFORE_MIN;
/** A valid stream stays Live until kickoff+2h. No stream ends at kickoff+30. */
const MAINLIVE_STATUS_END_AFTER_MIN = LIVE_UNTIL_AFTER_MIN;

/**
 * Any valid kickoff can use auto status. The admin Auto/Manual switch
 * decides whether the server updates it. There is no hour-of-day cutoff.
 */
function isMainLiveAutoStatusEligible(kickoff) {
  const dt = toYangon(kickoff);
  return Boolean(dt && dt.isValid);
}

/**
 * MainLive auto status when the row is unlocked. Does not change matches.json.
 *
 * Scheduled → PREPARING_STREAM → LIVE → END.
 * LIVE only when the clock has reached kickoff−5 and a valid stream URL exists.
 * No valid stream stays Preparing after kickoff, then END at kickoff+30.
 * A valid stream stays Live until kickoff+2h.
 * statusLocked matches keep the admin-set status.
 */
function resolveMainLiveAutoStatus(match, options = {}) {
  if (match?.statusLocked && match.status) {
    return match.status;
  }
  if (!isMainLiveAutoStatusEligible(match?.kickoff)) {
    return match?.status || 'Scheduled';
  }

  const kickSec = toUtcUnixSeconds(match.kickoff);
  const nowSec = options.nowSec != null ? options.nowSec : nowUtcUnixSeconds();
  if (kickSec == null) return match?.status || 'Scheduled';

  return resolveAutoClockStatus(kickSec, nowSec, match, PREPARING_LEAD_MIN);
}

module.exports = {
  isMainLiveAutoStatusEligible,
  resolveMainLiveAutoStatus,
  MAINLIVE_STATUS_LIVE_BEFORE_MIN,
  MAINLIVE_STATUS_END_AFTER_MIN,
};
