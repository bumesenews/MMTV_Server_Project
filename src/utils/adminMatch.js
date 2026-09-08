const { applyAdminMatchUrl } = require('./matchUrlDiscovery');

function emptyAdminMatchDoc() {
  return {
    version: 1,
    generatedAt: null,
    timezone: 'Asia/Yangon',
    matchCount: 0,
    matches: [],
    meta: { feed: 'admin-match' },
  };
}

/** Full former matches.json row (fixture + matchUrl + streams + h2h), not a sparse override. */
function isFullAdminMatch(m) {
  return Boolean(
    m &&
      (m.homeTeam ||
        m.awayTeam ||
        m.kickoff ||
        m.h2h !== undefined ||
        m.matchUrlSearch ||
        m.sourcePages)
  );
}

function toAdminMatchDoc(content) {
  const matches = Array.isArray(content?.matches) ? content.matches : [];
  const meta =
    content?.meta && typeof content.meta === 'object' ? { ...content.meta } : {};
  meta.feed = 'admin-match';
  return {
    version: content?.version || 1,
    generatedAt: content?.generatedAt || null,
    timezone: content?.timezone || 'Asia/Yangon',
    matchCount: content?.matchCount ?? matches.length,
    matches,
    meta,
  };
}

/** File name under GITHUB_CONFIG_PATH. Default: admin-match.json */
function adminMatchFileName(env = process.env) {
  const raw = String(env.GITHUB_ADMIN_MATCH_PATH || 'admin-match.json').trim().replace(/^\/+/, '');
  const base = String(env.GITHUB_CONFIG_PATH || 'config').replace(/\/+$/, '');
  if (raw.startsWith(`${base}/`)) return raw.slice(base.length + 1);
  return raw || 'admin-match.json';
}

function listAdminEntries(doc) {
  const raw = doc?.matches;
  if (Array.isArray(raw)) {
    return raw.filter((e) => e && e.matchId);
  }
  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter((e) => e && e.matchId);
  }
  return [];
}

function normalizeAdminEntry(input = {}) {
  const matchId = String(input.matchId || '').trim();
  if (!matchId) return null;
  const matchUrl = String(input.matchUrl || input.url || '').trim();
  const streamUrl = String(input.streamUrl || '').trim();
  const source = String(input.source || '').trim().toLowerCase();
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {};
  return {
    matchId,
    source: source || '',
    matchUrl,
    streamUrl,
    quality: String(input.quality || input.streamName || 'HD').trim() || 'HD',
    headers: {
      'User-Agent': String(headers['User-Agent'] || headers.userAgent || '').trim(),
      Referer: String(headers.Referer || headers.referer || '').trim(),
      ...(headers.Origin || headers.origin
        ? { Origin: String(headers.Origin || headers.origin).trim() }
        : {}),
      ...(headers.Cookie || headers.cookie
        ? { Cookie: String(headers.Cookie || headers.cookie).trim() }
        : {}),
    },
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function mergeAdminMatchDocs(local, remote) {
  const localMatches = listAdminEntries(local);
  const remoteMatches = listAdminEntries(remote);
  if (!localMatches.length && !remoteMatches.length) {
    return toAdminMatchDoc(local || remote || emptyAdminMatchDoc());
  }
  if (!localMatches.length) return toAdminMatchDoc(remote);
  if (!remoteMatches.length) return toAdminMatchDoc(local);

  const localFull = localMatches.some(isFullAdminMatch);
  const remoteFull = remoteMatches.some(isFullAdminMatch);
  if (localFull || remoteFull) {
    const byId = new Map();
    for (const m of remoteMatches) {
      if (m?.matchId) byId.set(m.matchId, m);
    }
    for (const m of localMatches) {
      if (!m?.matchId) continue;
      if (isFullAdminMatch(m)) {
        byId.set(m.matchId, m);
        continue;
      }
      const prev = byId.get(m.matchId);
      const overlay = normalizeAdminEntry(m);
      byId.set(
        m.matchId,
        prev && overlay ? applyAdminEntryToFixture(prev, overlay) : m
      );
    }
    const base = localFull ? local : remote;
    return toAdminMatchDoc({ ...base, matches: [...byId.values()] });
  }

  const byId = new Map();
  for (const entry of remoteMatches) {
    const n = normalizeAdminEntry(entry);
    if (n) byId.set(n.matchId, n);
  }
  for (const entry of localMatches) {
    const n = normalizeAdminEntry(entry);
    if (n) byId.set(n.matchId, n);
  }
  return { version: 1, matches: [...byId.values()] };
}

function upsertAdminEntry(doc, input) {
  const entry = normalizeAdminEntry({
    ...input,
    updatedAt: new Date().toISOString(),
  });
  if (!entry) throw new Error('matchId is required');
  const matches = listAdminEntries(doc);
  const idx = matches.findIndex((e) => e.matchId === entry.matchId);
  if (idx >= 0 && isFullAdminMatch(matches[idx])) {
    const next = matches.slice();
    next[idx] = applyAdminEntryToFixture(matches[idx], entry);
    return toAdminMatchDoc({ ...doc, matches: next, matchCount: next.length });
  }
  const rest = matches.filter((e) => e.matchId !== entry.matchId);
  if (matches.some(isFullAdminMatch)) {
    const next = [...rest, { matchId: entry.matchId, ...entry }];
    return toAdminMatchDoc({ ...doc, matches: next, matchCount: next.length });
  }
  return { version: 1, matches: [...rest, entry] };
}

function removeAdminEntry(doc, matchId) {
  const id = String(matchId || '').trim();
  const matches = listAdminEntries(doc);
  if (matches.some(isFullAdminMatch)) {
    const next = matches.map((m) => {
      if (m.matchId !== id) return m;
      const copy = { ...m };
      delete copy.adminManual;
      delete copy.adminSkipExtract;
      return copy;
    });
    return toAdminMatchDoc({ ...doc, matches: next, matchCount: next.length });
  }
  return {
    version: 1,
    matches: matches.filter((e) => e.matchId !== id),
  };
}

function findAdminEntry(doc, matchId) {
  const id = String(matchId || '').trim();
  return listAdminEntries(doc).find((e) => e.matchId === id) || null;
}

function adminManualStream(entry) {
  if (!entry?.streamUrl) return null;
  return {
    source: 'manual',
    type: 'm3u8',
    quality: entry.quality || 'HD',
    name: entry.quality || 'HD',
    url: entry.streamUrl,
    headers: entry.headers || { 'User-Agent': '', Referer: '' },
    streamHeaders: entry.headers || { 'User-Agent': '', Referer: '' },
    active: true,
    priority: 1000,
    adminStream: true,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Stamp an existing FotMob fixture with admin-match.json (no new scraper).
 */
function applyAdminEntryToFixture(fixture, entry) {
  if (!fixture || !entry) return fixture;
  let next = fixture;
  const source = entry.source || fixture.matchUrlSource || 'cakhia';
  if (entry.matchUrl) {
    next = applyAdminMatchUrl(next, source, entry.matchUrl);
  }
  const stream = adminManualStream(entry);
  if (stream) {
    const others = (next.streams || []).filter((s) => !s.adminStream);
    next = {
      ...next,
      streams: [stream, ...others],
      streamUrl: stream.url,
      streamHeaders: stream.headers,
      adminSkipExtract: true,
    };
  }
  return {
    ...next,
    adminManual: {
      matchUrl: entry.matchUrl || '',
      streamUrl: entry.streamUrl || '',
      source,
    },
  };
}

function hasText(value) {
  return Boolean(String(value || '').trim());
}

/**
 * Keep AUTO Match URL / stream from a previous admin-match.json row.
 * Does not mark the fixture manual — discovery can still improve it.
 */
function applyStickyStoredMatch(fixture, stored) {
  if (!fixture || !stored || !isFullAdminMatch(stored)) return fixture;
  const next = { ...fixture };
  if (!hasText(next.matchUrl) && hasText(stored.matchUrl)) {
    next.matchUrl = stored.matchUrl;
    next.matchUrlStatus = stored.matchUrlStatus || next.matchUrlStatus || 'MATCH_URL_CONFIRMED';
    next.matchUrlSource = stored.matchUrlSource || next.matchUrlSource || null;
    next.matchUrlAttempts = Math.max(
      Number(next.matchUrlAttempts) || 0,
      Number(stored.matchUrlAttempts) || 0
    );
    next.lastMatchUrlAttemptAt =
      next.lastMatchUrlAttemptAt || stored.lastMatchUrlAttemptAt || null;
    const nextPages = next.sourcePages && typeof next.sourcePages === 'object'
      ? next.sourcePages
      : {};
    const prevPages = stored.sourcePages && typeof stored.sourcePages === 'object'
      ? stored.sourcePages
      : {};
    if (!Object.keys(nextPages).length && Object.keys(prevPages).length) {
      next.sourcePages = { ...prevPages };
    }
    if (stored.matchUrlSearch && typeof stored.matchUrlSearch === 'object') {
      next.matchUrlSearch = next.matchUrlSearch && typeof next.matchUrlSearch === 'object'
        ? {
            ...stored.matchUrlSearch,
            ...next.matchUrlSearch,
            sources: {
              ...(stored.matchUrlSearch.sources || {}),
              ...(next.matchUrlSearch.sources || {}),
            },
          }
        : stored.matchUrlSearch;
    }
  }
  if (!hasText(next.streamUrl) && hasText(stored.streamUrl)) {
    next.streamUrl = stored.streamUrl;
    next.streamHeaders = next.streamHeaders || stored.streamHeaders || null;
    next.streamStatus = next.streamStatus || stored.streamStatus || null;
  }
  if (!(next.streams || []).length && (stored.streams || []).length) {
    next.streams = stored.streams;
  }
  return next;
}

function preserveDiscoveredFields(previousDoc, nextDoc) {
  const prevById = new Map(
    listAdminEntries(previousDoc).map((m) => [m.matchId, m])
  );
  const matches = listAdminEntries(nextDoc).map((m) => {
    const prev = prevById.get(m.matchId);
    return prev ? applyStickyStoredMatch(m, prev) : m;
  });
  return toAdminMatchDoc({ ...nextDoc, matches, matchCount: matches.length });
}

function extractOverrideEntry(stored) {
  if (!stored?.matchId) return null;
  const manual = stored.adminManual;
  if (manual && (manual.matchUrl || manual.streamUrl)) {
    return normalizeAdminEntry({
      matchId: stored.matchId,
      source: manual.source || stored.matchUrlSource || stored.source,
      matchUrl: manual.matchUrl,
      streamUrl: manual.streamUrl,
      quality: stored.quality,
      headers: stored.streamHeaders || stored.headers,
    });
  }
  if (!isFullAdminMatch(stored) && (stored.matchUrl || stored.streamUrl)) {
    return normalizeAdminEntry(stored);
  }
  return null;
}

function listOverrideEntries(doc) {
  return listAdminEntries(doc).map(extractOverrideEntry).filter(Boolean);
}

function applyAdminMatchDocToMatches(matches = [], doc) {
  const storedById = new Map(
    listAdminEntries(doc).map((e) => [e.matchId, e])
  );
  const overrideById = new Map(
    listOverrideEntries(doc).map((e) => [e.matchId, e])
  );
  if (!storedById.size) return matches;
  return (matches || []).map((m) => {
    const stored = storedById.get(m.matchId);
    let next = stored ? applyStickyStoredMatch(m, stored) : m;
    const entry = overrideById.get(m.matchId);
    return entry ? applyAdminEntryToFixture(next, entry) : next;
  });
}

module.exports = {
  emptyAdminMatchDoc,
  isFullAdminMatch,
  toAdminMatchDoc,
  adminMatchFileName,
  listAdminEntries,
  listOverrideEntries,
  extractOverrideEntry,
  normalizeAdminEntry,
  mergeAdminMatchDocs,
  upsertAdminEntry,
  removeAdminEntry,
  findAdminEntry,
  adminManualStream,
  applyAdminEntryToFixture,
  applyStickyStoredMatch,
  preserveDiscoveredFields,
  applyAdminMatchDocToMatches,
};
