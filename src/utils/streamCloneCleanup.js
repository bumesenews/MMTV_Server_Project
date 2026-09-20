const { normalizeStreamUrl } = require('./compare');
const { getSourceMatchUrlState, sourceHasSavedMatchUrl } = require('./matchUrlDiscovery');

const SOURCE_NAME_TOKENS = new Set(
  ['cakhia', 'xoilac', 'socolive', 'phut', '90phut', 'mitomtm', 'mitom', 'manual', 'stream'].map(
    (s) => s.toLowerCase()
  )
);

function isManualStream(stream) {
  if (!stream) return false;
  if (stream.manualId) return true;
  return String(stream.source || '').trim().toLowerCase() === 'manual';
}

function streamReferer(stream) {
  const headers = stream?.streamHeaders || stream?.headers || {};
  return String(headers.Referer || headers.referer || '').trim();
}

function refererHost(stream) {
  try {
    return new URL(streamReferer(stream)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function headerFingerprint(stream) {
  const headers = stream?.streamHeaders || stream?.headers || {};
  const ua = String(headers['User-Agent'] || headers['user-agent'] || '').trim();
  const referer = streamReferer(stream).toLowerCase().replace(/\/$/, '');
  const origin = String(headers.Origin || headers.origin || '').trim().toLowerCase();
  return `${ua}|${referer}|${origin}`;
}

function strippedButtonName(stream) {
  const quality = String(stream?.quality || '').trim();
  const name = String(stream?.name || '').trim();
  const raw = quality || name;
  const kept = raw
    .split(/[\s·./]+/)
    .map((part) => part.trim())
    .filter((part) => part && !SOURCE_NAME_TOKENS.has(part.toLowerCase()));
  return (kept.join(' ') || raw || 'HD').toUpperCase();
}

function hasExtractProvenance(stream) {
  return Boolean(
    stream?.via || stream?.matchPageUrl || stream?.embedUrl || stream?.extractionMethod
  );
}

function pageBlob(stream) {
  return `${stream?.matchPageUrl || ''} ${stream?.embedUrl || ''}`.toLowerCase();
}

/** True when match/embed page clearly belongs to a different source site. */
function provenanceMismatchesSource(stream) {
  const source = String(stream?.source || '').trim().toLowerCase();
  const blob = pageBlob(stream);
  const host = refererHost(stream);
  const hay = `${blob} ${host}`;
  if (!source || !hay.trim()) return false;
  if (source === 'socolive') {
    return /xl365|cakhia|xoilac|90phut|(?:^|\.)phut\./i.test(hay) && !/soco|socolive/i.test(hay);
  }
  if (source === 'cakhia' || source === 'xoilac' || source === 'phut' || source === '90phut') {
    return /soco\.|socolive/i.test(hay) && !/cakhia|xoilac|phut|xl365/i.test(hay);
  }
  return false;
}

function refererClearlyWrongForSource(stream) {
  const source = String(stream?.source || '').trim().toLowerCase();
  const host = refererHost(stream);
  if (!source || !host) return false;
  if (source === 'socolive') {
    return /xl365|cakhia|xoilac|hexvaridstreamnode/i.test(host) && !/soco|socolive|textlive/i.test(host);
  }
  if (source === 'cakhia' || source === 'xoilac' || source === 'phut' || source === '90phut') {
    return /soco\.|socolivepp|textliveupdaterz/i.test(host);
  }
  return false;
}

function cloneClusterKey(stream) {
  return `${normalizeStreamUrl(stream?.url)}::${headerFingerprint(stream)}::${strippedButtonName(stream)}`;
}

function sourceHasOwnMatchUrl(match, sourceName) {
  if (!match) return false;
  return sourceHasSavedMatchUrl(getSourceMatchUrlState(match, sourceName));
}

/**
 * Remove rows that are copies of one extract with only `source` rewritten.
 *
 * Strong clone fingerprint (historical expandStreamsForAvailableSources):
 * - same URL, same headers, same button name
 * - 3+ different sources
 * - and/or referer/page metadata that cannot belong to that source
 * - and/or a source with no saved Match URL copying another source that does
 *
 * Never drops:
 * - manual/admin streams
 * - two sources that share a URL but have different headers or names
 * - two sources that share a URL with matching per-source provenance
 */
function stripHistoricalClones(streams, match = null) {
  const list = (streams || []).filter((s) => s && String(s.url || '').trim());
  const keep = [];
  const drop = new Set();

  const auto = [];
  for (const stream of list) {
    if (isManualStream(stream)) keep.push(stream);
    else auto.push(stream);
  }

  const byCluster = new Map();
  for (const stream of auto) {
    const key = cloneClusterKey(stream);
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(stream);
  }

  for (const cluster of byCluster.values()) {
    const sources = new Set(
      cluster.map((s) => String(s.source || '').trim().toLowerCase()).filter(Boolean)
    );
    const isExpandClone =
      cluster.length >= 3 && sources.size >= 3 && new Set(cluster.map(headerFingerprint)).size === 1;

    if (isExpandClone) {
      const matching = cluster.filter(
        (s) =>
          hasExtractProvenance(s) &&
          !provenanceMismatchesSource(s) &&
          !refererClearlyWrongForSource(s)
      );
      const winner =
        matching[0] || cluster.find((s) => !refererClearlyWrongForSource(s)) || cluster[0];
      for (const stream of cluster) {
        if (stream !== winner) drop.add(stream);
      }
      continue;
    }

    for (const stream of cluster) {
      if (refererClearlyWrongForSource(stream) || provenanceMismatchesSource(stream)) {
        const siblingFits = cluster.some(
          (other) =>
            other !== stream &&
            !refererClearlyWrongForSource(other) &&
            !provenanceMismatchesSource(other)
        );
        if (siblingFits) drop.add(stream);
      }
    }

    if (match) {
      for (const stream of cluster) {
        if (drop.has(stream) || isManualStream(stream)) continue;
        if (hasExtractProvenance(stream) && !provenanceMismatchesSource(stream)) continue;
        if (sourceHasOwnMatchUrl(match, stream.source)) continue;
        const twinWithUrl = cluster.some(
          (other) => other !== stream && sourceHasOwnMatchUrl(match, other.source)
        );
        if (twinWithUrl) drop.add(stream);
      }
    }
  }

  for (const stream of auto) {
    if (!drop.has(stream)) keep.push(stream);
  }
  return keep;
}

function sortManualFirst(streams) {
  return [...(streams || [])].sort((a, b) => {
    const am = isManualStream(a) ? 0 : 1;
    const bm = isManualStream(b) ? 0 : 1;
    return am - bm;
  });
}

function finalizeStreamList(streams, match = null) {
  return sortManualFirst(stripHistoricalClones(streams, match));
}

module.exports = {
  isManualStream,
  stripHistoricalClones,
  sortManualFirst,
  finalizeStreamList,
  headerFingerprint,
  strippedButtonName,
};
