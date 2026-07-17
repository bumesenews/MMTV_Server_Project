const { logEvent, events } = require('../utils/logger');
const { isKickoffStarted, minutesUntilKickoff, toYangon } = require('../utils/time');

/**
 * Final status:
 * Scheduled | LIVE | END
 *
 * LIVE when:
 * - valid stream exists OR source reports live OR kickoff started
 *
 * END when:
 * - match finished OR (kickoff long ago and no valid stream)
 */
function resolveMatchStatus(match, options = {}) {
  const previous = match.status || 'Scheduled';
  const hasValidStream = (match.streams || []).some(
    (s) => s.active || s.validation?.ok
  );
  const sourceLive = Boolean(match.sourceLive || /live/i.test(match.sourceStatus || ''));
  const finished = Boolean(match.finished || previous === 'END');
  const kickoffStarted = isKickoffStarted(match.kickoff);
  const mins = minutesUntilKickoff(match.kickoff);

  let status = 'Scheduled';

  if (finished) {
    status = 'END';
  } else if (hasValidStream || sourceLive || kickoffStarted) {
    // If kickoff was > 3.5h ago and no streams, treat as END
    if (mins !== null && mins < -210 && !hasValidStream && !sourceLive) {
      status = 'END';
    } else {
      status = 'LIVE';
    }
  } else {
    status = 'Scheduled';
  }

  // Hard END from FotMob finished flag
  if (match.fotmobFinished) status = 'END';

  if (options.forceEnd) status = 'END';

  if (status !== previous) {
    logEvent(events.STATUS_CHANGED, 'Match status changed', {
      matchId: match.matchId,
      from: previous,
      to: status,
      kickoff: match.kickoff,
    });
  }

  return status;
}

function enrichMatchState(match) {
  const status = resolveMatchStatus(match);
  const kickoff = toYangon(match.kickoff);
  return {
    ...match,
    status,
    timezone: 'Asia/Yangon',
    hasStreams: (match.streams || []).some((s) => s.active),
    streamCount: (match.streams || []).filter((s) => s.active).length,
    updatedAt: new Date().toISOString(),
    kickoffYangon: kickoff ? kickoff.toISO() : match.kickoff,
  };
}

module.exports = {
  resolveMatchStatus,
  enrichMatchState,
};
