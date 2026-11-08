const { logEvent, events } = require('../utils/logger');
const {
  toYangon,
  toUtcUnixSeconds,
  nowUtcUnixSeconds,
  MATCH_LIVE_DURATION_MIN,
} = require('../utils/time');
const {
  NO_STREAM_END_AFTER_MIN,
  PREPARING_LEAD_MIN,
  resolveAutoClockStatus,
} = require('../utils/autoLiveStatus');

/**
 * Final status for Flutter matches.json:
 * Scheduled | PREPARING_STREAM | LIVE | END
 *
 * Driven by fixture kickoff vs current time (UTC unix seconds):
 * Same Auto clock as MainLive:
 * - before kickoff−lead, no Live yet → Scheduled
 * - a valid stream URL does not make the match Live early
 * - kickoff−5 and a valid stream URL, until kickoff+2h → LIVE
 * - no valid stream URL stays PREPARING_STREAM, including after kickoff
 * - no valid stream URL at kickoff+30 → END
 * - current ≥ kickoff+2h → END (streams stripped)
 */
function hasPlayableStream(match) {
  if (String(match?.streamUrl || '').trim()) return true;
  return (match.streams || []).some((s) => s && String(s.url || '').trim());
}

/** Valid = non-empty URL that passed (or was kept as) active stream. */
function hasValidStream(match) {
  return (match.streams || []).some(
    (s) =>
      s &&
      String(s.url || '').trim() &&
      s.active !== false &&
      (s.validation == null || s.validation.ok !== false)
  );
}

function resolveMatchStatus(match, options = {}) {
  const previous = match.status || 'Scheduled';

  if (options.forceEnd || match.forceEnd) {
    if (previous !== 'END') {
      logEvent(events.STATUS_CHANGED, 'Match status changed', {
        matchId: match.matchId,
        from: previous,
        to: 'END',
        reason: 'forceEnd',
        kickoff: match.kickoff,
      });
    }
    return 'END';
  }

  // Admin / manual fixtures: keep the status set from the admin panel
  if (match.statusLocked && match.status) {
    return match.status;
  }

  const kickSec = toUtcUnixSeconds(match.kickoff);
  const nowSec = options.nowSec != null ? options.nowSec : nowUtcUnixSeconds();
  let status = 'Scheduled';

  if (kickSec == null) {
    status = 'Scheduled';
  } else {
    status = resolveAutoClockStatus(kickSec, nowSec, match, PREPARING_LEAD_MIN);
  }

  if (status !== previous) {
    logEvent(events.STATUS_CHANGED, 'Match status changed', {
      matchId: match.matchId,
      from: previous,
      to: status,
      hasStreams: hasPlayableStream(match),
      hasValidStream: hasValidStream(match),
      kickoff: match.kickoff,
      kickoffUnix: kickSec,
      nowUnix: nowSec,
      liveDurationMin: MATCH_LIVE_DURATION_MIN,
      preparingLeadMin: PREPARING_LEAD_MIN,
      searchStopAfterMin: NO_STREAM_END_AFTER_MIN,
      reason:
        status === 'END' &&
        previous !== 'END' &&
        kickSec != null &&
        nowSec < kickSec + MATCH_LIVE_DURATION_MIN * 60 &&
        !hasPlayableStream(match)
          ? 'no_stream_after_search_window'
          : undefined,
    });
  }

  return status;
}

function stripStreamsIfEnded(match, status) {
  if (status !== 'END') return match.streams || [];
  return [];
}

function enrichMatchState(match, options = {}) {
  const status = resolveMatchStatus(match, options);
  const kickoff = toYangon(match.kickoff);
  const streams = stripStreamsIfEnded(match, status);
  const playable = streams.filter((s) => s && String(s.url || '').trim());
  return {
    ...match,
    status,
    statusLocked: Boolean(match.statusLocked),
    streams,
    timezone: 'Asia/Yangon',
    hasStreams: playable.some((s) => s.active !== false),
    streamCount: playable.filter((s) => s.active !== false).length,
    updatedAt: new Date().toISOString(),
    kickoffYangon: kickoff ? kickoff.toISO() : match.kickoff,
  };
}

module.exports = {
  resolveMatchStatus,
  enrichMatchState,
  hasPlayableStream,
  hasValidStream,
};
