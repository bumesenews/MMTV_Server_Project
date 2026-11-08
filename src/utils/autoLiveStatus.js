/** Status becomes Preparing this many minutes before kickoff. Match-page search uses its own lead. */
const PREPARING_LEAD_MIN = 60;
/** Earliest Live. 8:00 PM kickoff → Live from 7:55 PM, and only with a valid stream URL. */
const LIVE_BEFORE_MIN = 5;
/** No valid stream URL by this many minutes after kickoff → END. */
const NO_STREAM_END_AFTER_MIN = 30;
/** A match that already has a valid stream URL stays Live until this many minutes after kickoff. */
const LIVE_UNTIL_AFTER_MIN = 120;

function streamRowIsValid(stream) {
  if (!stream || !String(stream.url || '').trim()) return false;
  if (stream.active === false) return false;
  if (stream.validation && stream.validation.ok === false) return false;
  return true;
}

/** A saved playlist that was not marked failed. A lone streamUrl counts when streams[] is empty. */
function hasValidStreamUrl(match) {
  const streams = Array.isArray(match?.streams) ? match.streams : [];
  if (streams.some(streamRowIsValid)) return true;
  if (streams.length) return false;
  return Boolean(String(match?.streamUrl || '').trim());
}

/**
 * Shared Auto status for MainLive and SecondLive.
 * LIVE only when now >= kickoff−5 and a valid stream URL exists.
 * No valid stream stays PREPARING through kickoff, then END at kickoff+30.
 * A valid stream stays LIVE until kickoff+2h.
 */
function resolveAutoClockStatus(kickSec, nowSec, match, preparingLeadMin) {
  const preparingFrom = kickSec - preparingLeadMin * 60;
  const liveFrom = kickSec - LIVE_BEFORE_MIN * 60;
  const noStreamEnd = kickSec + NO_STREAM_END_AFTER_MIN * 60;
  const liveUntil = kickSec + LIVE_UNTIL_AFTER_MIN * 60;
  const valid = hasValidStreamUrl(match);

  if (nowSec >= liveUntil) return 'END';
  if (!valid && nowSec >= noStreamEnd) return 'END';
  if (valid && nowSec >= liveFrom) return 'LIVE';
  if (nowSec >= preparingFrom) return 'PREPARING_STREAM';
  return 'Scheduled';
}

module.exports = {
  PREPARING_LEAD_MIN,
  LIVE_BEFORE_MIN,
  NO_STREAM_END_AFTER_MIN,
  LIVE_UNTIL_AFTER_MIN,
  hasValidStreamUrl,
  resolveAutoClockStatus,
};
