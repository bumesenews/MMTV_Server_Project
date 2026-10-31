const { StreamValidator } = require('../../services/streamValidator');
const { flutterStreamName } = require('../../services/jsonGenerator');
const { GenericStreamingSource } = require('../../sources/genericStreamingSource');
const {
  mergePlaybackHeaders,
  playbackHeadersForClient,
  fillOriginFromReferer,
  pickPlaybackHeaders,
} = require('../../utils/streamHeaders');
const {
  isKeptAfterValidation,
  normalizeValidationReason,
  normalizeExtractError,
} = require('../../utils/streamExtractPolicy');
const { logger } = require('../../utils/logger');
const {
  looksLikeM3u8,
  resolveSourceFromUrl,
  mainLiveExtractPlan,
  urlExtractPlan,
  matchUrlEntries,
  needsMainLiveExtract,
} = require('./mainLiveExtractPolicy');

/**
 * Same header shape as matches.json streams: User-Agent, Referer, Origin, Cookie.
 * Browser-captured values win when present; source playbackHeaders fill gaps
 * (especially Cookie) so MainLive does not publish cookie-less CDN playlists.
 */
function mapExtractedStream(raw, { sourceName, matchUrl, sourceConfig }) {
  const incoming = raw.headers || raw.streamHeaders || {};
  const baseline = mergePlaybackHeaders({
    streamHeaders: incoming,
    sourceConfig,
    matchPageUrl: matchUrl,
    streamUrl: raw.url,
  });
  const preferred = raw.keepPlaybackHeaders
    ? { ...baseline, ...pickPlaybackHeaders(incoming) }
    : baseline;
  const headers = playbackHeadersForClient(fillOriginFromReferer(preferred));
  const name = flutterStreamName({ ...raw, source: sourceName });
  return {
    source: sourceName,
    type: String(raw.type || 'm3u8').trim() || 'm3u8',
    quality: name,
    name,
    url: String(raw.url || '').trim(),
    headers,
    streamHeaders: headers,
    active: raw.active !== false,
    extractionMethod: raw.extractionMethod || null,
  };
}

/**
 * Pull validated m3u8s from an admin-entered streaming match page.
 */
async function extractMainLiveStreams({ pipeline, matchUrl, sourceName } = {}) {
  const url = String(matchUrl || '').trim();
  if (!url) {
    return { ok: false, error: 'Match URL is required', source: sourceName || null, streams: [] };
  }
  if (looksLikeM3u8(url)) {
    return {
      ok: true,
      source: sourceName || 'manual',
      streams: [
        mapExtractedStream(
          { url, quality: 'HD', name: 'HD', source: sourceName || 'manual' },
          { sourceName: sourceName || 'manual', matchUrl: url, sourceConfig: {} }
        ),
      ],
      error: null,
    };
  }

  const config = await pipeline.configLoader.load();
  const sources = pipeline.buildStreamingSources(config.sources);
  let source = resolveSourceFromUrl(sources, url, sourceName);
  if (!source) {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
    source = new GenericStreamingSource({
      name: sourceName || 'generic',
      config: {
        name: sourceName || 'generic',
        type: 'streaming',
        enabled: true,
        domains: origin ? [origin] : [],
      },
      browserManager: pipeline.browser,
      normalizer: pipeline.normalizer,
    });
  }

  const validator = new StreamValidator({
    sourceConfigs: { [source.name]: source.config || {} },
  });
  let lastValidationReason = null;
  const validateStreams = async (raw) => {
    const checked = await validator.validateMany(raw, {
      sourceConfig: source.config,
    });
    const failed = (checked || []).find((s) => s?.validation && s.validation.ok === false);
    if (failed) {
      lastValidationReason = normalizeValidationReason(
        failed.validation.state || failed.validation.reason
      );
    }
    return (checked || []).filter((s) => isKeptAfterValidation(s));
  };

  let streams = [];
  let error = null;
  try {
    streams = await source.extractStreams(url, {
      validateStreams,
      capturePlaybackHeaders: true,
    });
    if (
      streams?.length &&
      !streams.every((s) => s.validation && typeof s.validation.ok === 'boolean')
    ) {
      streams = await validateStreams(streams);
    }
    streams = (streams || []).filter((s) => isKeptAfterValidation(s));
    streams = validator.dedupeAndRank(streams);
    if (!streams.length) {
      error = lastValidationReason || 'NOT_FOUND';
    }
  } catch (err) {
    error = normalizeExtractError(err) || err.message || 'EXTRACT_FAILED';
    logger.warn('MainLive match URL extract failed', {
      url,
      source: source.name,
      error: err.message,
    });
  }

  const mapped = streams.map((s) =>
    mapExtractedStream(s, {
      sourceName: source.name,
      matchUrl: url,
      sourceConfig: source.config || {},
    })
  );

  return {
    ok: mapped.length > 0,
    source: source.name,
    streams: mapped,
    error: mapped.length ? null : error,
  };
}

/**
 * Save is already done. Extract m3u8 and republish mainlive.json when found.
 * If the matches pipeline owns Chromium, queue for the next drain.
 */
async function extractAndPublishMainLive(ctx, matchId, { actor = 'admin', force = true } = {}) {
  const current = ctx.mainLive.get(matchId);
  if (!current) throw new Error('MainLive match not found');
  const entries = matchUrlEntries(current);
  if (!entries.length) {
    return { match: current, extraction: { skipped: true, reason: 'no_match_url' }, published: null };
  }

  const planned = entries.map((entry) => ({
    entry,
    plan: urlExtractPlan(current, entry, { force }),
  }));
  const due = planned.filter((item) => item.plan.due);
  if (!due.length) {
    const reason = planned.find((item) => item.plan.reason === 'before_lead')?.plan.reason
      || planned[0]?.plan.reason
      || 'not_due';
    const match =
      reason === 'before_lead'
        ? ctx.mainLive.markExtractStatus(matchId, {
            status: 'SCHEDULED',
            error: null,
            touchExtractAt: false,
          })
        : current;
    return {
      match,
      extraction: { skipped: true, reason },
      published: null,
    };
  }

  if (ctx.pipeline?.running) {
    ctx.pipeline._pendingMainLiveExtract = true;
    const match = ctx.mainLive.markExtractStatus(matchId, {
      status: 'SEARCHING',
      error: null,
      queued: true,
    });
    return {
      match,
      extraction: { queued: true, reason: 'pipeline_busy', urls: due.map((item) => item.entry.url) },
      published: null,
    };
  }

  let match = current;
  const results = [];
  for (const item of due) {
    ctx.mainLive.markExtractStatus(matchId, { status: 'SEARCHING', error: null, url: item.entry.url });
    const extraction = await extractMainLiveStreams({
      pipeline: ctx.pipeline,
      matchUrl: item.entry.url,
      sourceName: item.entry.source,
    });
    extraction.matchUrl = item.entry.url;
    match = ctx.mainLive.applyExtractResult(matchId, extraction);
    results.push(extraction);
  }
  const published = await ctx.publish.publishMainLive({ actor });
  const extraction = {
    ok: results.some((item) => item.ok),
    streams: results.flatMap((item) => item.streams || []),
    urls: due.map((item) => item.entry.url),
    error: results.every((item) => item.ok) ? null : results.find((item) => !item.ok)?.error || null,
  };
  return { match, extraction, published };
}

module.exports = {
  looksLikeM3u8,
  resolveSourceFromUrl,
  mainLiveExtractPlan,
  urlExtractPlan,
  matchUrlEntries,
  needsMainLiveExtract,
  mapExtractedStream,
  extractMainLiveStreams,
  extractAndPublishMainLive,
};
