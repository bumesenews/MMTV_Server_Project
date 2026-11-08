const { logEvent, events } = require('../utils/logger');
const {
  toYangon,
  toUtcUnixSeconds,
  nowUtcUnixSeconds,
  MATCH_URL_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
} = require('../utils/time');

/**
 * Final status for Flutter matches.json:
 * Scheduled | PREPARING_STREAM | LIVE | END
 *
 * Driven by fixture kickoff vs current time (UTC unix seconds):
 * - current < kickoff − MATCH_URL_LEAD_MIN, no stream URL → Scheduled
 * - kickoff − lead ≤ current < kickoff + 2h, no stream URL → PREPARING_STREAM
 * - a stream URL exists and current < kickoff + 2h → LIVE
 * - kickoff + 30m ≤ current < kickoff + 2h, no stream URL, and the stream
 *   search already ran on a saved match page → END
 * - current ≥ kickoff + 2h → END (streams stripped)
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
    const preparingFrom = kickSec - MATCH_URL_LEAD_MIN * 60;
    const liveUntil = kickSec + MATCH_LIVE_DURATION_MIN * 60;

    if (nowSec >= liveUntil) {
      status = 'END';
    } else if (hasPlayableStream(match)) {
      status = 'LIVE';
    } else if (nowSec < preparingFrom) {
      status = 'Scheduled';
    } else {
      const searchStopAt = kickSec + STREAM_SEARCH_STOP_AFTER_MIN * 60;
      const searchTried = Boolean(
        match.streamSearch?.started || match.streamSearch?.stopped
      );
      const hasMatchPage = Boolean(String(match.matchUrl || '').trim());
      // Search finished on a saved match page and no playlist was found.
      if (nowSec >= searchStopAt && hasMatchPage && searchTried) {
        status = 'END';
      } else {
        status = 'PREPARING_STREAM';
      }
    }
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
      preparingLeadMin: MATCH_URL_LEAD_MIN,
      searchStopAfterMin: STREAM_SEARCH_STOP_AFTER_MIN,
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
