const {
  toYangon,
  toUtcUnixSeconds,
  nowUtcUnixSeconds,
  MATCH_URL_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
} = require('../../utils/time');
const { hasValidStream, hasPlayableStream } = require('../../services/statusService');

/** Asia/Yangon kickoff at or after 23:00 is eligible for MainLive auto status. */
const MAINLIVE_AUTO_STATUS_AFTER_MINUTES = 23 * 60;

/**
 * True when kickoff wall clock in Asia/Yangon is ≥ 23:00.
 */
function isMainLiveAutoStatusEligible(kickoff) {
  const dt = toYangon(kickoff);
  if (!dt || !dt.isValid) return false;
  return dt.hour * 60 + dt.minute >= MAINLIVE_AUTO_STATUS_AFTER_MINUTES;
}

/**
 * MainLive-only auto status. Does not change Football matches.json logic.
 *
 * Scheduled → PREPARING_STREAM → LIVE → END
 * LIVE requires a verified/playable stream (never kickoff alone).
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
  const liveUntil = kickSec + MATCH_LIVE_DURATION_MIN * 60;

  if (nowSec < preparingFrom) return 'Scheduled';
  if (nowSec < kickSec) return 'PREPARING_STREAM';
  if (nowSec < liveUntil) {
    // Never LIVE on kickoff alone — need a verified playable stream.
    if (hasValidStream(match) || hasPlayableStream(match)) return 'LIVE';
    return 'PREPARING_STREAM';
  }
  return 'END';
}

module.exports = {
  MAINLIVE_AUTO_STATUS_AFTER_MINUTES,
  isMainLiveAutoStatusEligible,
  resolveMainLiveAutoStatus,
};
