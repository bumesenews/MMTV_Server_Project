const { applyAdminMatchUrl } = require('./matchUrlDiscovery');

function emptyAdminMatchDoc() {
  return { version: 1, matches: [] };
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
  const byId = new Map();
  for (const entry of listAdminEntries(remote)) {
    const n = normalizeAdminEntry(entry);
    if (n) byId.set(n.matchId, n);
  }
  for (const entry of listAdminEntries(local)) {
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
  const rest = listAdminEntries(doc).filter((e) => e.matchId !== entry.matchId);
  return { version: 1, matches: [...rest, entry] };
}

function removeAdminEntry(doc, matchId) {
  const id = String(matchId || '').trim();
  return {
    version: 1,
    matches: listAdminEntries(doc).filter((e) => e.matchId !== id),
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

function applyAdminMatchDocToMatches(matches = [], doc) {
  const byId = new Map(listAdminEntries(doc).map((e) => [e.matchId, e]));
  if (!byId.size) return matches;
  return (matches || []).map((m) => {
    const entry = byId.get(m.matchId);
    return entry ? applyAdminEntryToFixture(m, entry) : m;
  });
}

module.exports = {
  emptyAdminMatchDoc,
  adminMatchFileName,
  listAdminEntries,
  normalizeAdminEntry,
  mergeAdminMatchDocs,
  upsertAdminEntry,
  removeAdminEntry,
  findAdminEntry,
  adminManualStream,
  applyAdminEntryToFixture,
  applyAdminMatchDocToMatches,
};
