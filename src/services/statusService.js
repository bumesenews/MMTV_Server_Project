const { logEvent, events } = require('../utils/logger');
const {
  minutesUntilKickoff,
  toYangon,
  MATCH_LIVE_DURATION_MIN,
} = require('../utils/time');

/**
 * Final status for Flutter matches.json:
 * Scheduled | PREPARING_STREAM | LIVE | END
 *
 * Driven by fixture kickoff date/time (FotMob) + validated stream presence.
 * - Before kickoff → Scheduled
 * - After kickoff .. +120m, no valid stream → PREPARING_STREAM
 * - After kickoff .. +120m, valid stream → LIVE
 * - After +120m → END (streams stripped)
 *
 * LIVE is never set from kickoff alone; it requires a valid stream URL.
 */
function hasPlayableStream(match) {
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

  const mins = minutesUntilKickoff(match.kickoff);
  let status = 'Scheduled';

  if (mins == null) {
    status = 'Scheduled';
  } else if (mins > 0) {
    // Before kickoff — never LIVE from time alone
    status = 'Scheduled';
  } else if (mins <= -MATCH_LIVE_DURATION_MIN) {
    status = 'END';
  } else {
    // After kickoff until +120m: stream presence decides LIVE vs preparing
    status = hasValidStream(match) ? 'LIVE' : 'PREPARING_STREAM';
  }

  if (status !== previous) {
    logEvent(events.STATUS_CHANGED, 'Match status changed', {
      matchId: match.matchId,
      from: previous,
      to: status,
      hasStreams: hasPlayableStream(match),
      hasValidStream: hasValidStream(match),
      kickoff: match.kickoff,
      minsUntilKickoff: mins,
      liveDurationMin: MATCH_LIVE_DURATION_MIN,
    });
  }

  return status;
}

function stripStreamsIfEnded(match, status) {
  if (status !== 'END') return match.streams || [];
  return [];
}

function enrichMatchState(match) {
  const status = resolveMatchStatus(match);
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
