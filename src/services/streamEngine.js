const { logger, logEvent, events } = require('../utils/logger');
const {
  getCheckIntervalMinutes,
  minutesUntilKickoff,
  resolveStreamSearchSlot,
  isStreamSearchStopped,
  STREAM_FIND_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  nowYangon,
} = require('../utils/time');
const { StreamValidator } = require('./streamValidator');
const { MatchMerger } = require('./matchMerger');
const { enrichMatchState } = require('./statusService');

const MAX_POST_KICKOFF_ATTEMPTS = 3;

/**
 * Production multi-source streaming extraction engine (matches.json).
 *
 * Kickoff-relative search slots (no fixed daily times):
 *  -30m, -15m, -5m, kickoff, +5m, +10m
 * Stop all searching at +15m (keep already-found valid streams).
 *
 * Per source: skip once AVAILABLE; failed sources may retry;
 * at most 3 post-kickoff attempts per source.
 * Match-by-match sequential processing; all enabled sources checked.
 */
class StreamEngine {
  constructor({ sources = [], validator, merger, scraperMonitor, onMatchUpdated } = {}) {
    this.sources = sources
      .filter((s) => s && s.config?.enabled !== false)
      .sort(
        (a, b) => Number(b.config?.priority || 0) - Number(a.config?.priority || 0)
      );
    this.validator = validator || new StreamValidator();
    this.merger = merger || new MatchMerger(this.validator);
    this.lastCheckByMatch = new Map();
    this.scraperMonitor = scraperMonitor || null;
    this.onMatchUpdated = typeof onMatchUpdated === 'function' ? onMatchUpdated : null;
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

  ensureStreamSearch(match) {
    const prev = match.streamSearch && typeof match.streamSearch === 'object'
      ? match.streamSearch
      : {};
    const sources = { ...(prev.sources || {}) };

    // Preserve AVAILABLE for sources that already have a valid stream on the match
    for (const s of match.streams || []) {
      const name = s?.source;
      if (!name || !s.url || s.active === false) continue;
      const existing = sources[name] || {};
      if (existing.status === 'AVAILABLE') continue;
      sources[name] = {
        status: 'AVAILABLE',
        attempts: Number(existing.attempts) || 1,
        postKickoffAttempts: Number(existing.postKickoffAttempts) || 0,
        lastError: null,
        updatedAt: existing.updatedAt || new Date().toISOString(),
      };
    }

    return {
      started: Boolean(prev.started) || Object.keys(sources).length > 0,
      stopped: Boolean(prev.stopped),
      stopTime: prev.stopTime || null,
      slotsDone: { ...(prev.slotsDone || {}) },
      sources,
    };
  }

  sourceState(streamSearch, sourceName) {
    const raw = streamSearch.sources?.[sourceName] || {};
    return {
      status: raw.status || 'PENDING',
      attempts: Number(raw.attempts) || 0,
      postKickoffAttempts: Number(raw.postKickoffAttempts) || 0,
      lastError: raw.lastError || null,
      updatedAt: raw.updatedAt || null,
    };
  }

  /**
   * Whether this match should deep-extract streams in the current kickoff slot.
   */
  shouldExtractStreams(fixture, { force = false } = {}) {
    if (isStreamSearchStopped(fixture.kickoff, fixture.streamSearch)) return false;

    const mins = minutesUntilKickoff(fixture.kickoff);
    if (mins == null) return false;
    if (mins > STREAM_FIND_LEAD_MIN) return false;
    if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) return false;

    if (force) return true;

    const slot = resolveStreamSearchSlot(fixture.kickoff);
    if (!slot) return false;

    const search = this.ensureStreamSearch(fixture);
    if (search.slotsDone?.[slot.id]) {
      // Re-run slot only if some sources are still not AVAILABLE
      const pending = this.sources.some((s) => {
        const st = this.sourceState(search, s.name);
        if (st.status === 'AVAILABLE') return false;
        if (slot.postKickoff && st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS) {
          return false;
        }
        return true;
      });
      return pending;
    }
    return true;
  }

  markSlotDone(streamSearch, slotId) {
    return {
      ...streamSearch,
      started: true,
      slotsDone: { ...streamSearch.slotsDone, [slotId]: true },
    };
  }

  markStopped(streamSearch) {
    return {
      ...streamSearch,
      started: true,
      stopped: true,
      stopTime: streamSearch.stopTime || nowYangon().toISO(),
    };
  }

  /**
   * Legacy streamAttempts flags kept for Flutter/backward compatibility.
   */
  syncLegacyAttempts(streamSearch, mins) {
    const attempts = {};
    const done = streamSearch.slotsDone || {};
    if (done.t30 || (mins != null && mins <= 30)) attempts.t30 = true;
    if (done.t15 || (mins != null && mins <= 15)) attempts.t15 = true;
    if (done.t5 || (mins != null && mins <= 5)) attempts.t5 = true;
    if (done.t0 || (mins != null && mins <= 0)) attempts.t0 = true;
    if (done.tP5 || (mins != null && mins <= -5)) attempts.tP5 = true;
    if (done.tP10 || (mins != null && mins <= -10)) attempts.tP10 = true;
    return attempts;
  }

  async persistProgress(match) {
    if (!this.onMatchUpdated) return;
    try {
      await this.onMatchUpdated(match);
    } catch (err) {
      logger.warn('onMatchUpdated failed', {
        matchId: match.matchId,
        error: err.message,
      });
    }
  }

  /**
   * Process fixtures match-by-match (sequential). Sources checked independently.
   */
  async collectForFixtures(fixtures, { force = false } = {}) {
    const list = fixtures || [];
    if (!list.length) return [];

    // One list-page fetch per source; match 15–20 due FotMob fixtures via URL helper
    const discovery = await this.discoverAll(list);
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

    // Match 1 → Match 2 → … (no unbounded parallel match launches)
    for (const fixture of list) {
      try {
        let base = enrichMatchState(fixture);
        let streamSearch = this.ensureStreamSearch(base);
        const mins = minutesUntilKickoff(base.kickoff);

        if (base.status === 'END') {
          streamSearch = this.markStopped(streamSearch);
          const ended = enrichMatchState({
            ...base,
            streamSearch,
            streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
          });
          this.markChecked(ended.matchId);
          results.push(ended);
          continue;
        }

        // Hard stop at kickoff + 15m
        if (isStreamSearchStopped(base.kickoff, streamSearch)) {
          streamSearch = this.markStopped(streamSearch);
          const stopped = enrichMatchState({
            ...base,
            streamSearch,
            streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
          });
          this.markChecked(stopped.matchId);
          results.push(stopped);
          continue;
        }

        if (!force && !this.shouldCheck(base)) {
          results.push(
            enrichMatchState({
              ...base,
              streamSearch,
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
            })
          );
          continue;
        }

        const extract = this.shouldExtractStreams(
          { ...base, streamSearch },
          { force }
        );
        const slot = resolveStreamSearchSlot(base.kickoff);

        if (!extract) {
          const idle = enrichMatchState({
            ...base,
            streamSearch: {
              ...streamSearch,
              started: streamSearch.started || mins != null && mins <= STREAM_FIND_LEAD_MIN,
            },
            streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
          });
          this.markChecked(idle.matchId);
          results.push(idle);
          continue;
        }

        streamSearch = {
          ...streamSearch,
          started: true,
          stopped: false,
        };

        let working = enrichMatchState({ ...base, streamSearch });

        // Check ALL enabled sources (do not stop after first success)
        for (const source of this.sources) {
          const st = this.sourceState(streamSearch, source.name);

          if (st.status === 'AVAILABLE') {
            continue;
          }

          if (slot?.postKickoff && st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS) {
            streamSearch.sources[source.name] = {
              ...st,
              status: 'FAILED',
              updatedAt: new Date().toISOString(),
            };
            continue;
          }

          const found = urlBySourceMatch[source.name]?.get(working.matchId);
          if (!found?.matchUrl) {
            streamSearch.sources[source.name] = {
              ...st,
              status: st.status === 'AVAILABLE' ? 'AVAILABLE' : 'FAILED',
              attempts: st.attempts + 1,
              postKickoffAttempts:
                st.postKickoffAttempts + (slot?.postKickoff ? 1 : 0),
              lastError: 'no_match_page',
              updatedAt: new Date().toISOString(),
            };
            continue;
          }

          streamSearch.sources[source.name] = {
            ...st,
            status: 'SEARCHING',
            updatedAt: new Date().toISOString(),
          };

          try {
            const validateStreams = async (raw) => {
              const checked = await this.validator.fastHealthCheckMany(raw);
              return checked.filter((s) => s && s.active && s.url);
            };

            let streams = await source.extractStreams(found.matchUrl, {
              validateStreams,
            });
            // Fallback health check for sources that ignore validateStreams
            if (
              streams?.length &&
              !streams.every((s) => s.validation && typeof s.validation.ok === 'boolean')
            ) {
              streams = await validateStreams(streams);
            }
            streams = (streams || []).filter((s) => s && s.active !== false && s.url);
            streams = this.validator.dedupeAndRank(streams);

            const attempts = st.attempts + 1;
            const postKickoffAttempts =
              st.postKickoffAttempts + (slot?.postKickoff ? 1 : 0);

            if (streams.length) {
              streamSearch.sources[source.name] = {
                status: 'AVAILABLE',
                attempts,
                postKickoffAttempts,
                lastError: null,
                updatedAt: new Date().toISOString(),
              };

              working = this.merger.mergeMatch(
                {
                  ...working,
                  streamSearch,
                  streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
                },
                [
                  {
                    source: source.name,
                    matchUrl: found.matchUrl,
                    streams,
                    originalNames: found.originalNames || {
                      [source.name]: working.originalNames?.[source.name],
                    },
                    sourceLive: working.status === 'LIVE',
                  },
                ]
              );
              working = enrichMatchState({
                ...working,
                streamSearch,
                streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
              });

              // Immediate save as soon as a verified stream is found
              await this.persistProgress(working);
            } else {
              streamSearch.sources[source.name] = {
                status: 'FAILED',
                attempts,
                postKickoffAttempts,
                lastError: 'no_valid_stream',
                updatedAt: new Date().toISOString(),
              };
              working = enrichMatchState({
                ...working,
                streamSearch,
                streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
              });
            }
          } catch (err) {
            logEvent(events.SCRAPER_ERROR, 'Streaming source failed — continuing', {
              source: source.name,
              matchId: working.matchId,
              error: err.message,
            });
            streamSearch.sources[source.name] = {
              ...this.sourceState(streamSearch, source.name),
              status: 'FAILED',
              attempts: st.attempts + 1,
              postKickoffAttempts:
                st.postKickoffAttempts + (slot?.postKickoff ? 1 : 0),
              lastError: err.message,
              updatedAt: new Date().toISOString(),
            };
            working = enrichMatchState({
              ...working,
              streamSearch,
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
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

        if (slot) {
          streamSearch = this.markSlotDone(streamSearch, slot.id);
        }

        // Stop flag when past +15 even mid-cycle
        if (isStreamSearchStopped(working.kickoff, streamSearch)) {
          streamSearch = this.markStopped(streamSearch);
        }

        const finalMatch = enrichMatchState({
          ...working,
          streamSearch,
          streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
        });

        this.markChecked(finalMatch.matchId);
        results.push(finalMatch);
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

  /**
   * Discover match pages once per source.
   * Prefers multi-match Axios list + FotMob URL matching when available.
   */
  async discoverAll(fixtures = []) {
    const bySource = {};
    for (const source of this.sources) {
      try {
        logger.info('Discovering matches once', {
          source: source.name,
          fixtures: (fixtures || []).length,
        });

        let found = [];
        if (
          typeof source.discoverMatchesForFixtures === 'function' &&
          (fixtures || []).length
        ) {
          found = await source.discoverMatchesForFixtures(fixtures);
        } else {
          found = await source.discoverMatches();
        }

        bySource[source.name] = found || [];
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

module.exports = { StreamEngine, MAX_POST_KICKOFF_ATTEMPTS };
