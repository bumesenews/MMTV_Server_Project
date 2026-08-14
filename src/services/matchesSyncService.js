const { logger } = require('../utils/logger');
const { toUtcUnixSeconds, MATCH_LIVE_DURATION_MIN } = require('../utils/time');
const { hasDataChanged, normalizeStreamUrl } = require('../utils/compare');
const { enrichMatchState } = require('./statusService');
const { isFalseEnglishPremierLabel } = require('../utils/normalize');

/** Seconds after kickoff before a match is removed from matches.json (2 hours). */
const MATCH_EXPIRE_AFTER_SEC = Number(
  process.env.MATCH_EXPIRE_AFTER_SEC || MATCH_LIVE_DURATION_MIN * 60 || 7200
);

/**
 * Kickoff → UTC epoch seconds (null if unparseable).
 */
function kickoffUnixSeconds(match) {
  return toUtcUnixSeconds(match?.kickoff);
}

/**
 * True when currentTime > kickoffTimestamp + 7200 (kickoff + 2 hours).
 */
function isMatchExpired(match, nowSec = Math.floor(Date.now() / 1000)) {
  const kick = kickoffUnixSeconds(match);
  if (kick == null) return false;
  return nowSec > kick + MATCH_EXPIRE_AFTER_SEC;
}

/**
 * Auto-cleanup: drop match objects past kickoff + 2 hours.
 */
function filterExpiredMatches(matches, nowSec = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(matches) ? matches : [];
  const kept = [];
  let removed = 0;
  for (const m of list) {
    if (isMatchExpired(m, nowSec)) {
      removed += 1;
      continue;
    }
    kept.push(m);
  }
  return { matches: kept, removed };
}

/**
 * Merge stream lists: keep existing, append new valid URLs, refresh metadata.
 */
function mergeStreamLists(existingStreams = [], incomingStreams = []) {
  const byKey = new Map();
  for (const s of existingStreams || []) {
    if (!s?.url) continue;
    byKey.set(normalizeStreamUrl(s.url), { ...s });
  }

  let added = 0;
  let updated = 0;

  for (const s of incomingStreams || []) {
    if (!s?.url) continue;
    // Skip streams explicitly marked inactive / failed validation
    if (s.active === false) continue;
    if (s.validation && s.validation.ok === false) continue;

    const key = normalizeStreamUrl(s.url);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...s, active: s.active !== false });
      added += 1;
      continue;
    }

    const next = {
      ...prev,
      ...s,
      url: prev.url || s.url,
      active: s.active !== false,
      headers: { ...(prev.headers || {}), ...(s.headers || {}) },
    };
    byKey.set(key, next);
    updated += 1;
  }

  return {
    streams: [...byKey.values()],
    added,
    updated,
  };
}

/**
 * Append / update incoming matches onto the cleaned existing list.
 * - Same matchId → merge streams + refresh fixture fields
 * - New matchId → append
 */
function mergeIncomingMatches(existingMatches, incomingMatches) {
  const byId = new Map();
  for (const m of existingMatches || []) {
    if (!m?.matchId) continue;
    byId.set(String(m.matchId), { ...m });
  }

  let streamsAdded = 0;
  let matchesAdded = 0;
  let matchesUpdated = 0;

  for (const raw of incomingMatches || []) {
    if (!raw?.matchId) continue;
    const id = String(raw.matchId);
    const incoming = enrichMatchState(raw);
    const prev = byId.get(id);

    if (!prev) {
      byId.set(id, incoming);
      matchesAdded += 1;
      streamsAdded += (incoming.streams || []).filter((s) => s?.url).length;
      continue;
    }

    const mergedStreams = mergeStreamLists(prev.streams || [], incoming.streams || []);
    streamsAdded += mergedStreams.added;

    const next = enrichMatchState({
      ...prev,
      ...incoming,
      // Preserve admin locks / pins when incoming scrape omits them
      manual: Boolean(prev.manual || incoming.manual),
      statusLocked: Boolean(prev.statusLocked || incoming.statusLocked),
      pinned: Boolean(prev.pinned || incoming.pinned),
      featured: Boolean(prev.featured || incoming.featured),
      streams: mergedStreams.streams,
      streamAttempts: {
        ...(prev.streamAttempts || {}),
        ...(incoming.streamAttempts || {}),
      },
      streamSearch: incoming.streamSearch || prev.streamSearch,
      sourcePages: {
        ...(prev.sourcePages || {}),
        ...(incoming.sourcePages || {}),
      },
      originalNames: {
        ...(prev.originalNames || {}),
        ...(incoming.originalNames || {}),
      },
    });

    byId.set(id, next);
    matchesUpdated += 1;
  }

  return {
    matches: [...byId.values()],
    streamsAdded,
    matchesAdded,
    matchesUpdated,
  };
}

/**
 * Repair league labels and drop rows still falsely tagged as EPL
 * (or repaired off EPL onto a non-allowlisted country league).
 * Stale matches.json kept wrong EPL rows even after FotMob stopped emitting them.
 */
function sanitizeLeagueLabels(matches, normalizer = null) {
  const list = Array.isArray(matches) ? matches : [];
  const out = [];
  let repaired = 0;
  let droppedFalseEpl = 0;

  for (const raw of list) {
    let m = raw;
    const wasFalseEpl = isFalseEnglishPremierLabel(m);
    if (normalizer?.repairMatchLeague) {
      const next = normalizer.repairMatchLeague(m);
      if (next?.league && next.league !== m.league) repaired += 1;
      m = next;
    }

    if (m.manual || m.statusLocked) {
      out.push(m);
      continue;
    }

    // Irreparable or still false EPL → drop
    if (isFalseEnglishPremierLabel(m)) {
      droppedFalseEpl += 1;
      continue;
    }

    // Was false EPL, repaired to a country PL that is not on the allow-list → drop
    // (do not keep AZE/EGY/… rows just because the label is no longer EPL).
    if (
      wasFalseEpl &&
      normalizer?.allowedLeagues &&
      m.league &&
      !normalizer.allowedLeagues.has(m.league)
    ) {
      droppedFalseEpl += 1;
      continue;
    }

    out.push(m);
  }

  return { matches: out, repaired, droppedFalseEpl };
}

/**
 * Full matches.json sync step (before local save + GitHub PUT):
 * 1) Read existing matches
 * 2) Remove expired (kickoff + 2h)
 * 3) Merge newly found valid streams / matches
 * 4) Repair false EPL league labels / drop irreparable ones
 * 5) Report whether content actually changed
 *
 * @param {object[]} existingMatches - from data/delivery/matches.json (or cache)
 * @param {object[]} incomingMatches - scraper / publish candidate list
 * @param {{ nowSec?: number, normalizer?: object }} [options]
 */
function syncMatchesForDelivery(existingMatches, incomingMatches, options = {}) {
  const nowSec =
    options.nowSec != null ? Number(options.nowSec) : Math.floor(Date.now() / 1000);

  const cleaned = filterExpiredMatches(existingMatches, nowSec);
  // Also drop expired rows from the incoming scrape set
  const incomingClean = filterExpiredMatches(incomingMatches, nowSec);

  const merged = mergeIncomingMatches(cleaned.matches, incomingClean.matches);
  const sanitized = sanitizeLeagueLabels(merged.matches, options.normalizer || null);

  // Final pass: enrich + drop anything that expired during merge edge cases
  const finalFiltered = filterExpiredMatches(
    (sanitized.matches || []).map((m) => enrichMatchState(m)),
    nowSec
  );

  const previousForCompare = (existingMatches || []).map((m) => enrichMatchState(m));
  const changed = hasDataChanged(
    { matches: previousForCompare },
    { matches: finalFiltered.matches }
  );

  const removed = cleaned.removed + incomingClean.removed + sanitized.droppedFalseEpl;

  logger.info('matches.json sync prepared', {
    existing: (existingMatches || []).length,
    incoming: (incomingMatches || []).length,
    removedExpired: removed,
    leaguesRepaired: sanitized.repaired,
    droppedFalseEpl: sanitized.droppedFalseEpl,
    matchesAdded: merged.matchesAdded,
    matchesUpdated: merged.matchesUpdated,
    streamsAdded: merged.streamsAdded,
    finalCount: finalFiltered.matches.length,
    changed,
  });

  return {
    matches: finalFiltered.matches,
    changed,
    removedExpired: removed,
    streamsAdded: merged.streamsAdded,
    matchesAdded: merged.matchesAdded,
    matchesUpdated: merged.matchesUpdated,
    leaguesRepaired: sanitized.repaired,
    droppedFalseEpl: sanitized.droppedFalseEpl,
  };
}

/**
 * Resolve the best local baseline for matches.json (delivery file, then cache).
 */
function readExistingMatches(cache) {
  if (!cache) return [];
  const delivery = typeof cache.getDelivery === 'function'
    ? cache.getDelivery('matches')
    : null;
  if (Array.isArray(delivery?.matches) && delivery.matches.length) {
    return delivery.matches;
  }
  const current = typeof cache.getCurrent === 'function' ? cache.getCurrent() : null;
  return Array.isArray(current?.matches) ? current.matches : [];
}

module.exports = {
  MATCH_EXPIRE_AFTER_SEC,
  kickoffUnixSeconds,
  isMatchExpired,
  filterExpiredMatches,
  mergeStreamLists,
  mergeIncomingMatches,
  sanitizeLeagueLabels,
  syncMatchesForDelivery,
  readExistingMatches,
};
