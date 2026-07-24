const { logger, logEvent, events } = require('../utils/logger');
const {
  getCheckIntervalMinutes,
  minutesUntilKickoff,
  STREAM_FIND_LEAD_MIN,
  STREAM_RETRY_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
} = require('../utils/time');
const { StreamValidator } = require('./streamValidator');
const { MatchMerger } = require('./matchMerger');
const { enrichMatchState, hasValidStream } = require('./statusService');

/**
 * Production multi-source streaming extraction engine (matches.json).
 *
 * Stream URL discovery is gated by fixture kickoff time:
 *  - first find at T−30m (e.g. 05:00 for 05:30 kickoff)
 *  - retry at T−15m if still missing
 *  - keep / refresh during LIVE until T+120m
 *  - stop after T+120m (status END clears streams in statusService)
 */
class StreamEngine {
  constructor({ sources = [], validator, merger, scraperMonitor } = {}) {
    this.sources = sources
      .filter((s) => s && s.config?.enabled !== false)
      .sort(
        (a, b) => Number(b.config?.priority || 0) - Number(a.config?.priority || 0)
      );
    this.validator = validator || new StreamValidator();
    this.merger = merger || new MatchMerger(this.validator);
    this.lastCheckByMatch = new Map();
    this.scraperMonitor = scraperMonitor || null;
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

  /**
   * Deep-extract streaming URLs only in the fixture-time windows.
   */
  shouldExtractStreams(fixture, { force = false } = {}) {
    const mins = minutesUntilKickoff(fixture.kickoff);
    if (mins == null) return false;

    // After live window → never extract (END)
    if (mins <= -MATCH_LIVE_DURATION_MIN) return false;

    // Too early → wait until T−30
    if (mins > STREAM_FIND_LEAD_MIN) return false;

    const hasStreams = hasValidStream(fixture);
    const attempts = fixture.streamAttempts || {};

    // T−30 .. T−15: first find window
    if (mins > STREAM_RETRY_LEAD_MIN) {
      if (force) return true;
      return !hasStreams || !attempts.t30;
    }

    // T−15 .. kickoff: retry window
    if (mins > 0) {
      if (force) return true;
      return !hasStreams || !attempts.t15;
    }

    // After kickoff .. +120m: keep extracting until a valid stream exists (PREPARING_STREAM → LIVE)
    if (force) return true;
    return !hasStreams;
  }

  markStreamAttempt(fixture, mins) {
    const attempts = { ...(fixture.streamAttempts || {}) };
    if (mins != null && mins <= STREAM_FIND_LEAD_MIN && mins > STREAM_RETRY_LEAD_MIN) {
      attempts.t30 = true;
    }
    if (mins != null && mins <= STREAM_RETRY_LEAD_MIN && mins > 0) {
      attempts.t15 = true;
      attempts.t30 = true;
    }
    if (mins != null && mins <= 0) {
      attempts.t15 = true;
      attempts.t30 = true;
    }
    return attempts;
  }

  /**
   * Process fixtures with one discovery pass per source (not per match).
   */
  async collectForFixtures(fixtures, { force = false } = {}) {
    const list = fixtures || [];
    if (!list.length) return [];

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
        // Always re-resolve fixture-time status (Scheduled/LIVE/END)
        const base = enrichMatchState(fixture);

        if (base.status === 'END') {
          this.markChecked(base.matchId);
          results.push(base);
          continue;
        }

        if (!force && !this.shouldCheck(base)) {
          results.push(base);
          continue;
        }

        const groups = [];
        const extract = this.shouldExtractStreams(base, { force });
        const mins = minutesUntilKickoff(base.kickoff);

        for (const source of this.sources) {
          try {
            const found = urlBySourceMatch[source.name]?.get(base.matchId);
            if (!found?.matchUrl) continue;

            let streams = [];
            if (extract) {
              streams = await source.extractStreams(found.matchUrl);
              streams = await this.validator.validateMany(streams);
              streams = this.validator.dedupeAndRank(streams);
            } else if (Array.isArray(base.streams) && base.streams.length) {
              // Keep existing streams when not in an extract window
              continue;
            }

            groups.push({
              source: source.name,
              matchUrl: found.matchUrl,
              streams,
              originalNames: found.originalNames || {
                [source.name]: base.originalNames?.[source.name],
              },
              sourceLive: base.status === 'LIVE',
            });
          } catch (err) {
            logEvent(events.SCRAPER_ERROR, 'Streaming source failed — continuing', {
              source: source.name,
              matchId: base.matchId,
              error: err.message,
            });
            if (this.scraperMonitor) {
              await this.scraperMonitor
                .notifySourceFailed(source.name, err, {
                  url: found?.matchUrl || source.baseUrl,
                })
                .catch(() => {});
            }
            const mgr = source?.browser;
            if (
              mgr &&
              typeof mgr.restart === 'function' &&
              typeof mgr.isConnected === 'function' &&
              !mgr.isConnected()
            ) {
              try {
                await mgr.restart({ force: true });
              } catch {
                // ignore restart errors
              }
            }
          }
        }

        const withAttempts = {
          ...base,
          streamAttempts: extract
            ? this.markStreamAttempt(base, mins)
            : base.streamAttempts || {},
        };

        const merged = groups.length
          ? this.merger.mergeMatch(withAttempts, groups)
          : enrichMatchState(withAttempts);

        this.markChecked(merged.matchId);
        results.push(merged);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Match stream collection failed', {
          matchId: fixture.matchId,
          error: err.message,
        });
        results.push(enrichMatchState(fixture));
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
        this.scraperMonitor?.recordSourceResult(source.name, {
          ok: true,
          url: source.baseUrl || source.config?.domains?.[0],
        });
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Discover-all source failed', {
          source: source.name,
          error: err.message,
        });
        bySource[source.name] = [];
        if (this.scraperMonitor) {
          await this.scraperMonitor
            .notifySourceFailed(source.name, err, {
              url: source.baseUrl || source.config?.domains?.[0],
            })
            .catch(() => {});
        }
      }
    }
    return bySource;
  }
}

module.exports = { StreamEngine };
