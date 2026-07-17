const { logger, logEvent, events } = require('../utils/logger');
const { getCheckIntervalMinutes, minutesUntilKickoff } = require('../utils/time');
const { StreamValidator } = require('./streamValidator');
const { MatchMerger } = require('./matchMerger');

/**
 * Production streaming extraction engine.
 * Discovers match pages ONCE per source, then extracts streams only when needed.
 */
class StreamEngine {
  constructor({ sources = [], validator, merger } = {}) {
    this.sources = sources.filter((s) => s && s.config?.enabled !== false);
    this.validator = validator || new StreamValidator();
    this.merger = merger || new MatchMerger(this.validator);
    this.lastCheckByMatch = new Map();
  }

  shouldCheck(match) {
    const status = match.status || 'Scheduled';
    const interval = getCheckIntervalMinutes(match.kickoff, status);
    if (interval == null) return false;

    const last = this.lastCheckByMatch.get(match.matchId);
    if (!last) return true;

    const elapsedMin = (Date.now() - last) / 60000;
    return elapsedMin >= interval;
  }

  markChecked(matchId) {
    this.lastCheckByMatch.set(matchId, Date.now());
  }

  shouldExtractStreams(fixture, { force = false } = {}) {
    if (fixture.status === 'LIVE') return true;
    const mins = minutesUntilKickoff(fixture.kickoff);
    // Even on force, only deep-extract near kickoff / live (Puppeteer is slow).
    // Soco / fixtures / highlights / channels still refresh every run.
    const windowMin = force ? 180 : 30;
    if (mins != null && mins <= windowMin) return true;
    return false;
  }

  /**
   * Process fixtures with one discovery pass per source (not per match).
   */
  async collectForFixtures(fixtures, { force = false } = {}) {
    const list = fixtures || [];
    if (!list.length) return [];

    // 1) Discover once per source
    const discovery = await this.discoverAll();
    const urlBySourceMatch = {};
    for (const [sourceName, matches] of Object.entries(discovery)) {
      urlBySourceMatch[sourceName] = new Map();
      for (const m of matches || []) {
        if (m.matchId && m.matchUrl) {
          urlBySourceMatch[sourceName].set(m.matchId, m);
        }
      }
    }

    const results = [];

    for (const fixture of list) {
      try {
        if (!force && !this.shouldCheck(fixture)) {
          results.push(fixture);
          continue;
        }

        const groups = [];
        const extract = this.shouldExtractStreams(fixture, { force });

        for (const source of this.sources) {
          try {
            const found = urlBySourceMatch[source.name]?.get(fixture.matchId);
            if (!found?.matchUrl) continue;

            let streams = [];
            if (extract) {
              streams = await source.extractStreams(found.matchUrl);
              streams = await this.validator.validateMany(streams);
              streams = this.validator.dedupeAndRank(streams);
            }

            groups.push({
              source: source.name,
              matchUrl: found.matchUrl,
              streams,
              originalNames: found.originalNames || {
                [source.name]: fixture.originalNames?.[source.name],
              },
              sourceLive: found.status === 'LIVE' || streams.some((s) => s.active),
            });
          } catch (err) {
            logEvent(events.SCRAPER_ERROR, 'Streaming source failed — continuing', {
              source: source.name,
              matchId: fixture.matchId,
              error: err.message,
            });
          }
        }

        const merged = this.merger.mergeMatch(fixture, groups);
        this.markChecked(fixture.matchId);
        results.push(merged);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Match stream collection failed', {
          matchId: fixture.matchId,
          error: err.message,
        });
        results.push(fixture);
      }
    }

    return results;
  }

  async discoverAll() {
    const bySource = {};
    for (const source of this.sources) {
      try {
        logger.info('Discovering matches once', { source: source.name });
        bySource[source.name] = await source.discoverMatches();
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Discover-all source failed', {
          source: source.name,
          error: err.message,
        });
        bySource[source.name] = [];
      }
    }
    return bySource;
  }
}

module.exports = { StreamEngine };
