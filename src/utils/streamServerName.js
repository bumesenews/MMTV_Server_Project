const SOURCE_TOKENS = new Set(
  ['cakhia', 'xoilac', 'socolive', 'phut', '90phut', 'mitomtm', 'mitom', 'manual', 'stream'].map(
    (s) => s.toLowerCase()
  )
);

/** Prefer these server names when a site lists several unique options. */
const SERVER_NAME_PRIORITY = [
  'ROY',
  'HD ROY',
  'RIO',
  'HD RIO',
  'NICK',
  'HD NICK',
  'MAX',
  'JOHAN',
  'FULL HD MAX',
  'HD LINK',
];

function normalizeServerName(value) {
  const kept = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[\s·./]+/)
    .map((part) => part.trim())
    .filter((part) => part && !SOURCE_TOKENS.has(part.toLowerCase()));
  return (kept.join(' ') || String(value || '').replace(/\s+/g, ' ').trim()).toUpperCase();
}

function serverNameRank(name) {
  const key = normalizeServerName(name);
  const indexed = SERVER_NAME_PRIORITY.indexOf(key);
  return indexed >= 0 ? indexed : SERVER_NAME_PRIORITY.length + 1;
}

function sortServerCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const byRank = serverNameRank(a?.name) - serverNameRank(b?.name);
    if (byRank !== 0) return byRank;
    return (Number(a?.index) || 0) - (Number(b?.index) || 0);
  });
}

function streamServerName(stream) {
  return normalizeServerName(stream?.quality || stream?.name || '');
}

function selectedServerNameSet(streams) {
  const names = new Set();
  for (const stream of streams || []) {
    if (String(stream?.source || '').toLowerCase() === 'manual' || stream?.manualId) continue;
    const name = streamServerName(stream);
    if (name) names.add(name);
  }
  return names;
}

function isManualStream(stream) {
  if (!stream) return false;
  if (stream.manualId) return true;
  return String(stream.source || '').trim().toLowerCase() === 'manual';
}

/**
 * Public/final list: unique server names, max 1 auto stream per website, max 4 auto streams.
 * Manual/admin rows stay first and are not counted against the 4-site cap.
 */
function selectUniqueNamedStreams(streams, { maxAuto = 4 } = {}) {
  const manual = [];
  const auto = [];
  for (const stream of streams || []) {
    if (!stream || !String(stream.url || '').trim()) continue;
    if (isManualStream(stream)) manual.push(stream);
    else auto.push(stream);
  }

  const usedNames = new Set();
  const usedSources = new Set();
  const picked = [];
  for (const stream of auto) {
    if (picked.length >= maxAuto) break;
    const source = String(stream.source || '').trim().toLowerCase() || 'unknown';
    if (usedSources.has(source)) continue;
    const name = streamServerName(stream);
    if (!name || usedNames.has(name)) continue;
    usedNames.add(name);
    usedSources.add(source);
    picked.push(stream);
  }
  return [...manual, ...picked];
}

module.exports = {
  SERVER_NAME_PRIORITY,
  normalizeServerName,
  serverNameRank,
  sortServerCandidates,
  streamServerName,
  selectedServerNameSet,
  selectUniqueNamedStreams,
};
