const { logEvent, events } = require('../utils/logger');
const { minutesUntilKickoff, toYangon } = require('../utils/time');

/**
 * Final status for Flutter:
 * Scheduled | LIVE | END
 *
 * LIVE only when at least one stream URL exists.
 * Kickoff/FotMob "live" alone must NOT mark LIVE (no empty-stream live badges).
 *
 * END when finished, or kickoff was long ago with no streams.
 */
function hasPlayableStream(match) {
  return (match.streams || []).some((s) => s && String(s.url || '').trim());
}

function resolveMatchStatus(match, options = {}) {
  const previous = match.status || 'Scheduled';
  const hasValidStream = hasPlayableStream(match);
  const finished = Boolean(
    match.finished || match.fotmobFinished || options.forceEnd
  );
  const mins = minutesUntilKickoff(match.kickoff);

  let status = 'Scheduled';

  if (finished || options.forceEnd) {
    status = 'END';
  } else if (hasValidStream) {
    status = 'LIVE';
  } else if (mins != null && mins < -210) {
    // Kickoff > 3.5h ago and still no streams → treat as ended
    status = 'END';
  } else {
    // No stream URL yet — keep Scheduled even if kickoff already started
    status = 'Scheduled';
  }

  if (status !== previous) {
    logEvent(events.STATUS_CHANGED, 'Match status changed', {
      matchId: match.matchId,
      from: previous,
      to: status,
      hasStreams: hasValidStream,
      kickoff: match.kickoff,
    });
  }

  return status;
}

function enrichMatchState(match) {
  const status = resolveMatchStatus(match);
  const kickoff = toYangon(match.kickoff);
  const playable = (match.streams || []).filter((s) => s && String(s.url || '').trim());
  return {
    ...match,
    status,
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
