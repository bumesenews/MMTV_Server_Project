const {
  toYangon,
  toUtcUnixSeconds,
  nowUtcUnixSeconds,
  MATCH_URL_LEAD_MIN,
} = require('../../utils/time');

/** Earliest Live, once a stream URL exists. 2:00 AM kickoff → Live from 1:55 AM. */
const MAINLIVE_STATUS_LIVE_BEFORE_MIN = 5;
/** Live ends this many minutes after kickoff. 2:00 AM kickoff → End at 4:00 AM. */
const MAINLIVE_STATUS_END_AFTER_MIN = 120;

function mainLiveHasStream(match) {
  if (String(match?.streamUrl || '').trim()) return true;
  return (match?.streams || []).some((stream) => stream && String(stream.url || '').trim());
}

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
 * LIVE starts 5 minutes before kickoff only after a stream URL is saved,
 * and ends 2 hours after kickoff. No stream URL stays Preparing.
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

  const preparingFrom = kickSec - MATCH_URL_LEAD_MIN * 60;
  const liveFrom = kickSec - MAINLIVE_STATUS_LIVE_BEFORE_MIN * 60;
  const liveUntil = kickSec + MAINLIVE_STATUS_END_AFTER_MIN * 60;

  if (nowSec >= liveUntil) return 'END';
  if (nowSec >= liveFrom && mainLiveHasStream(match)) return 'LIVE';
  if (nowSec >= preparingFrom) return 'PREPARING_STREAM';
  return 'Scheduled';
}

module.exports = {
  isMainLiveAutoStatusEligible,
  resolveMainLiveAutoStatus,
  MAINLIVE_STATUS_LIVE_BEFORE_MIN,
  MAINLIVE_STATUS_END_AFTER_MIN,
};
