const { logEvent, events } = require('../utils/logger');
const { StreamValidator } = require('./streamValidator');
const { enrichMatchState } = require('./statusService');

class MatchMerger {
  constructor(validator = new StreamValidator()) {
    this.validator = validator;
  }

  /**
   * Merge fixture base with streams from multiple sources.
   */
  mergeMatch(fixture, streamGroups = []) {
    const originalNames = { ...(fixture.originalNames || {}) };
    const sourcePages = { ...(fixture.sourcePages || {}) };
    let streams = [...(fixture.streams || [])];

    for (const group of streamGroups) {
      if (!group) continue;
      if (group.originalNames) {
        Object.assign(originalNames, group.originalNames);
      }
      if (group.matchUrl && group.source) {
        sourcePages[group.source] = group.matchUrl;
      }
      if (Array.isArray(group.streams)) {
        streams.push(...group.streams);
      }
      if (group.sourceLive) {
        fixture.sourceLive = true;
      }
    }

    streams = this.validator.dedupeAndRank(streams);

    if (streamGroups.length > 1) {
      logEvent(events.DUPLICATE_MERGED, 'Merged multi-source streams', {
        matchId: fixture.matchId,
        sources: streamGroups.map((g) => g.source).filter(Boolean),
        streamCount: streams.length,
      });
    }

    const merged = {
      ...fixture,
      originalNames,
      sourcePages,
      streams,
    };

    return enrichMatchState(merged);
  }

  mergeFixtures(fixtures) {
    const map = new Map();
    for (const f of fixtures || []) {
      if (!f?.matchId) continue;
      if (!map.has(f.matchId)) {
        map.set(f.matchId, { ...f, streams: [...(f.streams || [])] });
        continue;
      }

      const existing = map.get(f.matchId);
      const merged = this.mergeMatch(existing, [
        {
          source: f.source,
          streams: f.streams || [],
          originalNames: f.originalNames,
          matchUrl: f.matchUrl,
          sourceLive: f.status === 'LIVE',
        },
      ]);
      map.set(f.matchId, merged);
      logEvent(events.DUPLICATE_MERGED, 'Duplicate fixture merged', {
        matchId: f.matchId,
      });
    }
    return [...map.values()];
  }
}

module.exports = { MatchMerger };
