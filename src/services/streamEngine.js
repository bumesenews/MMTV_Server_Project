const { logger, logEvent, events } = require('../utils/logger');
const {
  getCheckIntervalMinutes,
  minutesUntilKickoff,
  resolveStreamSearchSlot,
  resolveAnyMatchUrlSlot,
  isStreamSearchStopped,
  STREAM_EXTRACT_LEAD_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  MATCH_LIVE_DURATION_MIN,
  nowYangon,
  nowUtcUnixSeconds,
} = require('../utils/time');
const { StreamValidator } = require('./streamValidator');
const { MatchMerger } = require('./matchMerger');
const { enrichMatchState } = require('./statusService');
const {
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  skipDiscoveryKeepKnown,
  finalizeMatchUrlStatus,
  getSourceMatchUrlState,
  sourceHasSavedMatchUrl,
  matchUrlJobKey,
  isTransientDiscoverError,
} = require('../utils/matchUrlDiscovery');
const { JobQueue, scraperConcurrency } = require('../utils/jobQueue');
const {
  STREAM_SOURCE_STATUS,
  MAX_POST_KICKOFF_ATTEMPTS,
  extractJobKey,
  isValidatedStream,
  sourceHasValidatedStream,
  decideSourceExtract,
  nextSourceStateAfterAttempt,
  aggregateStreamStatus,
  firstValidatedStreamUrl,
  firstValidatedStreamHeaders,
  aggregateValidationFields,
  maxSourceAttempts,
  normalizeValidationReason,
  normalizeExtractError,
  isKnownValidationReason,
  isBrowserProtocolError,
  readSourceExtractState,
  sourceNeedsMorePlayerStreams,
} = require('../utils/streamExtractPolicy');

/**
 * Production multi-source streaming extraction engine (matches.json).
 *
 * Kickoff-relative search slots (no fixed daily times):
 *  Match URL: −60 / −45 / −30 (max 3 per source)
 *  Stream extract: −30 / −15 / −5 / kickoff / +5 / +10
 * Stop all searching at +15m (keep already-found valid streams).
 *
 * Per source: skip once AVAILABLE; permanently FAILED after 3 post-kickoff attempts;
 * extract jobs queued at SCRAPER_CONCURRENCY (default 2).
 * Match-by-match sequential processing; all enabled sources checked.
 */
class StreamEngine {
  constructor({ sources = [], validator, merger, scraperMonitor, onMatchUpdated } = {}) {
    this.sources = sources
      .filter((s) => s && s.config?.enabled !== false)
      .sort(
        (a, b) => Number(b.config?.priority || 0) - Number(a.config?.priority || 0)
      );
    const sourceConfigs = {};
    for (const src of this.sources) {
      if (src?.name) sourceConfigs[src.name] = src.config || {};
    }
    this.validator = validator || new StreamValidator({ sourceConfigs });
    this.merger = merger || new MatchMerger(this.validator);
    this.lastCheckByMatch = new Map();
    this.scraperMonitor = scraperMonitor || null;
    this.onMatchUpdated = typeof onMatchUpdated === 'function' ? onMatchUpdated : null;
    this.extractQueue = new JobQueue({ concurrency: scraperConcurrency() });
    this._matchApplyLocks = new Map();
    this.lastDiscoverMeta = {};
    this._activeMatchUrlJobs = new Set();
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

    // Preserve AVAILABLE only for sources that already have a *validated* stream
    for (const s of match.streams || []) {
      const name = s?.source;
      if (!name || !isValidatedStream(s)) continue;
      const existing = sources[name] || {};
      if (existing.status === STREAM_SOURCE_STATUS.AVAILABLE) continue;
      sources[name] = {
        status: STREAM_SOURCE_STATUS.AVAILABLE,
        attempts: Number(existing.attempts) || 1,
        postKickoffAttempts: Number(existing.postKickoffAttempts) || 0,
        lastError: null,
        lastAttemptAt: existing.lastAttemptAt || null,
        updatedAt: existing.updatedAt || new Date().toISOString(),
        slotsDone: { ...(existing.slotsDone || {}) },
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
    return readSourceExtractState(streamSearch, sourceName);
  }

  /**
   * Pipeline hung through −30..+15 with no extract started.
   * Allow one catch-up search until kickoff+2h.
   */
  missedExtractCatchup(fixture) {
    const search = fixture?.streamSearch && typeof fixture.streamSearch === 'object'
      ? fixture.streamSearch
      : {};
    if (search.started || search.stopped) return false;
    const mins = minutesUntilKickoff(fixture?.kickoff);
    if (mins == null) return false;
    if (mins > STREAM_EXTRACT_LEAD_MIN) return false;
    if (mins > -STREAM_SEARCH_STOP_AFTER_MIN) return false;
    return mins > -MATCH_LIVE_DURATION_MIN;
  }

  /**
   * Match URL arrived after the +15 extract stop — still pull m3u8 while LIVE.
   */
  lateUrlExtractCatchup(fixture) {
    const mins = minutesUntilKickoff(fixture?.kickoff);
    if (mins == null || mins > 0) return false;
    if (mins <= -MATCH_LIVE_DURATION_MIN) return false;
    return this.sources.some((s) => {
      if (!sourceHasSavedMatchUrl(getSourceMatchUrlState(fixture, s.name))) return false;
      const st = readSourceExtractState(fixture?.streamSearch, s.name);
      if (
        st.status === STREAM_SOURCE_STATUS.FAILED &&
        st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS
      ) {
        return false;
      }
      return !sourceHasValidatedStream(fixture, s.name);
    });
  }

  /**
   * Source already has a playable URL but not TOM + HDTOM (or max player tabs).
   * Re-extract while the match is still LIVE.
   */
  incompletePlayerCatchup(fixture) {
    const mins = minutesUntilKickoff(fixture?.kickoff);
    if (mins == null || mins > STREAM_EXTRACT_LEAD_MIN) return false;
    if (mins <= -MATCH_LIVE_DURATION_MIN) return false;
    return this.sources.some((s) => {
      if (!sourceHasSavedMatchUrl(getSourceMatchUrlState(fixture, s.name))) return false;
      const st = readSourceExtractState(fixture?.streamSearch, s.name);
      if (
        st.status === STREAM_SOURCE_STATUS.FAILED &&
        st.postKickoffAttempts >= MAX_POST_KICKOFF_ATTEMPTS
      ) {
        return false;
      }
      return sourceNeedsMorePlayerStreams(fixture, s.name);
    });
  }

  catchupSlot() {
    return {
      id: 'catchup',
      attempt: 1,
      postKickoff: true,
      minExclusive: -MATCH_LIVE_DURATION_MIN,
      maxInclusive: -STREAM_SEARCH_STOP_AFTER_MIN,
    };
  }

  /**
   * Whether this match should deep-extract streams in the current kickoff slot.
   */
  shouldExtractStreams(fixture, { force = false } = {}) {
    const mins = minutesUntilKickoff(fixture.kickoff);
    if (mins == null) return false;
    if (mins > STREAM_EXTRACT_LEAD_MIN) return false;
    if (mins <= -MATCH_LIVE_DURATION_MIN) return false;

    const catchup =
      this.missedExtractCatchup(fixture) ||
      this.lateUrlExtractCatchup(fixture) ||
      this.incompletePlayerCatchup(fixture);
    if (!catchup) {
      if (isStreamSearchStopped(fixture.kickoff, fixture.streamSearch)) return false;
      if (mins <= -STREAM_SEARCH_STOP_AFTER_MIN) return false;
    }

    if (force) return true;

    const slot = resolveStreamSearchSlot(fixture.kickoff) || (catchup ? this.catchupSlot() : null);
    if (!slot) return false;

    const search = this.ensureStreamSearch(fixture);
    return this.sources.some((s) => {
      const decision = decideSourceExtract({
        sourceName: s.name,
        streamSearch: search,
        matchUrlState: getSourceMatchUrlState(fixture, s.name),
        slot,
        stopped: false,
        force,
        match: fixture,
      });
      return !decision.skip;
    });
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

    // One list-page fetch per source — −60/−45/−30 for fixtures
    // that do not already have a saved Match URL. No stream extract here.
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

    const resultsById = new Map();
    const jobs = [];
    const order = [];

    for (const fixture of list) {
      try {
        let base = enrichMatchState(fixture);
        base = this.applyDiscoveryToFixture(base, urlBySourceMatch);
        const beforePages = fixture.sourcePages || {};
        const afterPages = base.sourcePages || {};
        const matchUrlSaved = Object.keys(afterPages).some(
          (name) => afterPages[name] && afterPages[name] !== beforePages[name]
        );
        if (matchUrlSaved) {
          await this.persistProgress(base);
        }
        let streamSearch = this.ensureStreamSearch(base);
        const mins = minutesUntilKickoff(base.kickoff);
        order.push(base.matchId);

        if (base.status === 'END') {
          streamSearch = this.markStopped(streamSearch);
          this.extractQueue.cancelMatch(base.matchId);
          const ended = this.stampStreamFields(
            enrichMatchState({
              ...base,
              streamSearch,
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
            }),
            mins
          );
          this.markChecked(ended.matchId);
          resultsById.set(ended.matchId, ended);
          continue;
        }

        const stillNeedUrl = this.sources.some((s) =>
          needsMatchUrlDiscovery(base, s.name, nowUtcUnixSeconds())
        );
        const allowLateExtract =
          this.missedExtractCatchup({ ...base, streamSearch }) ||
          this.lateUrlExtractCatchup({ ...base, streamSearch }) ||
          this.incompletePlayerCatchup({ ...base, streamSearch }) ||
          stillNeedUrl;
        if (
          isStreamSearchStopped(base.kickoff, streamSearch) &&
          !allowLateExtract
        ) {
          streamSearch = this.markStopped(streamSearch);
          this.extractQueue.cancelMatch(base.matchId);
          const stopped = this.stampStreamFields(
            enrichMatchState({
              ...base,
              streamSearch,
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
            }),
            mins
          );
          this.markChecked(stopped.matchId);
          resultsById.set(stopped.matchId, stopped);
          continue;
        }

        if (!force && !this.shouldCheck(base)) {
          const idle = this.stampStreamFields(
            enrichMatchState({
              ...base,
              streamSearch,
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
            }),
            mins
          );
          resultsById.set(idle.matchId, idle);
          continue;
        }

        const extract = this.shouldExtractStreams(
          { ...base, streamSearch },
          { force }
        );
        const slot =
          resolveStreamSearchSlot(base.kickoff) ||
          ((this.missedExtractCatchup({ ...base, streamSearch }) ||
            this.lateUrlExtractCatchup({ ...base, streamSearch }) ||
            this.incompletePlayerCatchup({ ...base, streamSearch }))
            ? this.catchupSlot()
            : null);

        if (!extract) {
          const idle = this.stampStreamFields(
            enrichMatchState({
              ...base,
              streamSearch: {
                ...streamSearch,
                started:
                  streamSearch.started || (mins != null && mins <= STREAM_EXTRACT_LEAD_MIN),
              },
              streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
            }),
            mins
          );
          this.markChecked(idle.matchId);
          resultsById.set(idle.matchId, idle);
          continue;
        }

        streamSearch = {
          ...streamSearch,
          started: true,
          stopped: false,
          sources: { ...(streamSearch.sources || {}) },
        };

        for (const source of this.sources) {
          const urlState = getSourceMatchUrlState(base, source.name);
          const found = urlBySourceMatch[source.name]?.get(base.matchId);
          const matchUrl = urlState.matchUrl || found?.matchUrl || null;
          const decision = decideSourceExtract({
            sourceName: source.name,
            streamSearch,
            matchUrlState: {
              ...urlState,
              matchUrl,
            },
            slot,
            stopped: false,
            force,
            match: base,
          });

          if (decision.markFailed) {
            streamSearch.sources[source.name] = {
              ...this.sourceState(streamSearch, source.name),
              status: STREAM_SOURCE_STATUS.FAILED,
              updatedAt: new Date().toISOString(),
            };
            continue;
          }

          if (decision.skip) {
            continue;
          }

          const prev = this.sourceState(streamSearch, source.name);
          const attempt = (Number(prev.attempts) || 0) + 1;
          streamSearch.sources[source.name] = {
            ...prev,
            status: STREAM_SOURCE_STATUS.SEARCHING,
            updatedAt: new Date().toISOString(),
          };

          jobs.push({
            key: extractJobKey(base.matchId, source.name, slot?.id || attempt),
            matchId: base.matchId,
            source,
            matchUrl: decision.matchUrl,
            slot,
            attempt,
            originalNames: found?.originalNames || null,
          });
        }

        const working = this.stampStreamFields(
          enrichMatchState({
            ...base,
            streamSearch,
            streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
          }),
          mins
        );
        resultsById.set(working.matchId, working);
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Match stream collection failed', {
          matchId: fixture.matchId,
          error: err.message,
        });
        resultsById.set(fixture.matchId, enrichMatchState(fixture));
        order.push(fixture.matchId);
      }
    }

    if (jobs.length) {
      logger.info('Stream extract queue start', {
        jobs: jobs.length,
        concurrency: this.extractQueue.concurrency,
        matches: resultsById.size,
      });
      await this.extractQueue.run(jobs, (job) => this.runExtractJob(job, resultsById));
    }

    const results = [];
    const seen = new Set();
    for (const id of order) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const match = resultsById.get(id);
      if (!match) continue;
      const mins = minutesUntilKickoff(match.kickoff);
      let streamSearch = match.streamSearch || this.ensureStreamSearch(match);
      const slot = resolveStreamSearchSlot(match.kickoff);
      const extractedThisSlot = Boolean(
        slot?.id &&
          Object.values(streamSearch.sources || {}).some((s) => s?.slotsDone?.[slot.id])
      );
      if (extractedThisSlot) streamSearch = this.markSlotDone(streamSearch, slot.id);
      if (isStreamSearchStopped(match.kickoff, streamSearch)) {
        streamSearch = this.markStopped(streamSearch);
      }
      const finalMatch = this.stampStreamFields(
        enrichMatchState({
          ...match,
          streamSearch,
          streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
        }),
        mins
      );
      this.markChecked(finalMatch.matchId);
      results.push(finalMatch);
    }

    return results;
  }

  stampStreamFields(match, mins = minutesUntilKickoff(match?.kickoff)) {
    const hasValidated = (match?.streams || []).some((s) => isValidatedStream(s));
    const streamSearch = match?.streamSearch || {};
    let lastAttemptAt = match.lastAttemptAt || null;
    for (const src of Object.values(streamSearch.sources || {})) {
      if (src?.lastAttemptAt && (!lastAttemptAt || src.lastAttemptAt > lastAttemptAt)) {
        lastAttemptAt = src.lastAttemptAt;
      }
    }
    const streamStatus = aggregateStreamStatus(streamSearch, {
      hasValidatedStream: hasValidated,
      stopped: Boolean(streamSearch.stopped),
      mins,
    });
    const validation = aggregateValidationFields(
      { ...match, streamSearch },
      streamStatus
    );
    const first = (match?.streams || []).find((s) => isValidatedStream(s));
    return {
      ...match,
      streamStatus,
      streamUrl: firstValidatedStreamUrl(match),
      streamHeaders: firstValidatedStreamHeaders(match),
      lastAttemptAt,
      attempts: maxSourceAttempts(streamSearch),
      validationStatus: validation.validationStatus,
      validationReason: validation.validationReason,
      source: first?.source || match.source || null,
    };
  }

  async withMatchLock(matchId, fn) {
    const prev = this._matchApplyLocks.get(matchId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this._matchApplyLocks.set(
      matchId,
      prev.then(
        () => gate,
        () => gate
      )
    );
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async runExtractJob(job, resultsById) {
    const { matchId, source, matchUrl, slot } = job;
    if (this.extractQueue.isCancelled(matchId)) {
      return { skipped: true, reason: 'stopped' };
    }

    const current = resultsById.get(matchId);
    if (!current) return { skipped: true, reason: 'missing_match' };

    const catchupJob = slot?.id === 'catchup';
    const pastLiveWindow = (() => {
      const mins = minutesUntilKickoff(current.kickoff);
      return mins != null && mins <= -MATCH_LIVE_DURATION_MIN;
    })();
    if (pastLiveWindow) {
      this.extractQueue.cancelMatch(matchId);
      return { skipped: true, reason: 'stopped' };
    }
    if (
      !catchupJob &&
      (current.streamSearch?.stopped ||
        isStreamSearchStopped(current.kickoff, current.streamSearch))
    ) {
      this.extractQueue.cancelMatch(matchId);
      return { skipped: true, reason: 'stopped' };
    }

    let lastValidationReason = null;
    const validateStreams = async (raw) => {
      let checked;
      if (typeof this.validator.validateMany === 'function') {
        checked = await this.validator.validateMany(raw, {
          sourceConfig: source.config,
        });
      } else {
        checked = await this.validator.fastHealthCheckMany(raw);
      }
      const failed = (checked || []).find(
        (s) => s?.validation && s.validation.ok === false
      );
      if (failed) {
        lastValidationReason = normalizeValidationReason(
          failed.validation.state || failed.validation.reason
        );
      }
      return (checked || []).filter(
        (s) => s && s.active && s.url && s.validation?.ok === true
      );
    };

    let streams = [];
    let error = null;
    let extractionMethod = null;
    try {
      if (
        this.extractQueue.isCancelled(matchId) ||
        pastLiveWindow ||
        (!catchupJob &&
          (current.streamSearch?.stopped ||
            isStreamSearchStopped(current.kickoff, current.streamSearch)))
      ) {
        this.extractQueue.cancelMatch(matchId);
        return { skipped: true, reason: 'stopped' };
      }
      streams = await source.extractStreams(matchUrl, {
        validateStreams,
        shouldAbort: () => {
          const latest = resultsById.get(matchId) || current;
          if (this.extractQueue.isCancelled(matchId)) {
            return true;
          }
          if (catchupJob) {
            const mins = minutesUntilKickoff(latest.kickoff);
            return mins != null && mins <= -MATCH_LIVE_DURATION_MIN;
          }
          if (latest.streamSearch?.stopped) return true;
          return isStreamSearchStopped(latest.kickoff, latest.streamSearch);
        },
      });
      if (
        streams?.length &&
        !streams.every((s) => s.validation && typeof s.validation.ok === 'boolean')
      ) {
        streams = await validateStreams(streams);
      }
      streams = (streams || []).filter((s) => isValidatedStream(s));
      streams = this.validator.dedupeAndRank(streams);
      extractionMethod = streams[0]?.extractionMethod || null;
      if (!streams.length) {
        error = lastValidationReason || error;
      }
    } catch (err) {
      error = normalizeExtractError(err);
      logEvent(events.SCRAPER_ERROR, 'Streaming source failed — continuing', {
        source: source.name,
        matchId,
        error: err.message,
      });
      const validationLike =
        isKnownValidationReason(err.message) || isBrowserProtocolError(err);
      if (this.scraperMonitor && !validationLike) {
        await this.scraperMonitor
          .notifySourceFailed(source.name, err, {
            url: matchUrl || source.baseUrl,
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
          // ignore
        }
      }
    }

    await this.withMatchLock(matchId, async () => {
      const working = resultsById.get(matchId) || current;
      if (
        !catchupJob &&
        isStreamSearchStopped(working.kickoff, working.streamSearch) &&
        !streams.length
      ) {
        this.extractQueue.cancelMatch(matchId);
        return;
      }

      const mins = minutesUntilKickoff(working.kickoff);
      const streamSearch = {
        ...(working.streamSearch || this.ensureStreamSearch(working)),
        sources: { ...((working.streamSearch && working.streamSearch.sources) || {}) },
      };
      const previous = this.sourceState(streamSearch, source.name);
      streamSearch.sources[source.name] = nextSourceStateAfterAttempt({
        previous,
        slot,
        validatedStreams: streams,
        error,
        extractionMethod,
      });

      let next = {
        ...working,
        streamSearch,
        streamAttempts: this.syncLegacyAttempts(streamSearch, mins),
      };

      if (streams.length) {
        next = this.merger.mergeMatch(next, [
          {
            source: source.name,
            matchUrl,
            streams,
            originalNames: job.originalNames || {
              [source.name]: working.originalNames?.[source.name],
            },
            sourceLive: working.status === 'LIVE',
          },
        ]);
      }

      next = this.stampStreamFields(enrichMatchState(next), mins);
      resultsById.set(matchId, next);

      if (streams.length) {
        await this.persistProgress(next);
      }
    });

    return { matchId, source: source.name, streams: streams.length, error };
  }

  /**
   * Stamp Match URL state from this cycle's discovery (or keep previously saved URLs).
   */
  applyDiscoveryToFixture(fixture, urlBySourceMatch = {}) {
    const nowIso = new Date().toISOString();
    const nowSec = nowUtcUnixSeconds();
    const slot = resolveAnyMatchUrlSlot(fixture.kickoff, nowSec);
    let next = fixture;

    for (const source of this.sources) {
      const found = urlBySourceMatch[source.name]?.get(fixture.matchId);
        if (needsMatchUrlDiscovery(next, source.name, nowSec)) {
          if (!found && this.lastDiscoverMeta[source.name]?.transient) {
            next = skipDiscoveryKeepKnown(next, source.name);
            continue;
          }
          const jobKey = matchUrlJobKey(next.matchId, source.name, slot);
          if (this._activeMatchUrlJobs.has(jobKey)) {
            next = skipDiscoveryKeepKnown(next, source.name);
            continue;
          }
          this._activeMatchUrlJobs.add(jobKey);
          try {
            next = applySourceDiscoveryResult(
              next,
              source.name,
              found
                ? {
                    matchUrl: found.matchUrl,
                    status: found.matchUrlStatus,
                    confidence: found.confidence,
                    accepted: true,
                  }
                : null,
              slot,
              nowIso
            );
          } finally {
            this._activeMatchUrlJobs.delete(jobKey);
          }
        } else {
        next = skipDiscoveryKeepKnown(next, source.name);
      }
    }

    return finalizeMatchUrlStatus(next, nowSec);
  }

  /**
   * Discover match pages once per source.
   * Skips Today-page scrape when no fixture is in a Match URL slot
   * (−60 / −45 / −30) or when that source already has a saved Match URL.
   */
  async discoverAll(fixtures = []) {
    const bySource = {};
    const nowSec = nowUtcUnixSeconds();
    this.lastDiscoverMeta = {};

    for (const source of this.sources) {
      try {
        const known = [];
        const due = [];
        for (const f of fixtures || []) {
          const st = getSourceMatchUrlState(f, source.name);
          if (sourceHasSavedMatchUrl(st)) {
            known.push({
              matchId: f.matchId,
              matchUrl: st.matchUrl,
              matchUrlStatus: st.status,
              confidence: st.confidence,
              source: source.name,
              originalNames: f.originalNames,
            });
            continue;
          }
          if (needsMatchUrlDiscovery(f, source.name, nowSec)) {
            due.push(f);
          }
        }

        if (!due.length) {
          logger.info('Skipping Today-page scrape — no Match URL search due', {
            source: source.name,
            known: known.length,
          });
          bySource[source.name] = known;
          continue;
        }

        logger.info('Discovering Match URLs (Today page)', {
          source: source.name,
          due: due.length,
          known: known.length,
        });

        let found = [];
        if (typeof source.discoverMatchesForFixtures === 'function') {
          found = await source.discoverMatchesForFixtures(due);
        } else {
          found = await source.discoverMatches();
        }

        const merged = [...known];
        const seen = new Set(known.map((k) => k.matchId));
        for (const m of found || []) {
          if (m?.matchId && m.matchUrl && !seen.has(m.matchId)) {
            merged.push(m);
            seen.add(m.matchId);
          }
        }
        bySource[source.name] = merged;
        this.lastDiscoverMeta[source.name] = {
          failed: false,
          transient: false,
          matched: merged.length,
        };
        this.scraperMonitor?.recordSourceResult(source.name, {
          ok: true,
          url: source.baseUrl || source.config?.domains?.[0],
        });
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Discover-all source failed', {
          source: source.name,
          error: err.message,
        });
        this.lastDiscoverMeta[source.name] = {
          failed: true,
          transient: isTransientDiscoverError(err),
          error: err.message,
        };
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
