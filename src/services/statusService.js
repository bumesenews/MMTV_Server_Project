const { logEvent, events } = require('../utils/logger');
const {
  minutesUntilKickoff,
  toYangon,
  resolveFixtureStatus,
  MATCH_LIVE_DURATION_MIN,
} = require('../utils/time');

/**
 * Final status for Flutter matches.json:
 * Scheduled | LIVE | END
 *
 * Driven by fixture kickoff date/time (FotMob), NOT streaming-site status.
 * - Before kickoff → Scheduled
 * - Kickoff until +120 minutes → LIVE
 * - After +120 minutes → END (streams stripped)
 */
function hasPlayableStream(match) {
  return (match.streams || []).some((s) => s && String(s.url || '').trim());
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

  const status = resolveFixtureStatus(match.kickoff);

  if (status !== previous) {
    logEvent(events.STATUS_CHANGED, 'Match status changed', {
      matchId: match.matchId,
      from: previous,
      to: status,
      hasStreams: hasPlayableStream(match),
      kickoff: match.kickoff,
      minsUntilKickoff: minutesUntilKickoff(match.kickoff),
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
};
