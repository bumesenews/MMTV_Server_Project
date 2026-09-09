const { StreamValidator } = require('../../services/streamValidator');
const { flutterStreamName } = require('../../services/jsonGenerator');
const { GenericStreamingSource } = require('../../sources/genericStreamingSource');
const {
  mergePlaybackHeaders,
  playbackHeadersForClient,
} = require('../../utils/streamHeaders');
const {
  isValidatedStream,
  normalizeValidationReason,
  normalizeExtractError,
} = require('../../utils/streamExtractPolicy');
const { logger } = require('../../utils/logger');
const {
  looksLikeM3u8,
  resolveSourceFromUrl,
  needsMainLiveExtract,
} = require('./mainLiveExtractPolicy');

function mapExtractedStream(raw, { sourceName, matchUrl, sourceConfig }) {
  const headers = playbackHeadersForClient(
    mergePlaybackHeaders({
      streamHeaders: raw.headers || raw.streamHeaders || {},
      sourceConfig,
      matchPageUrl: matchUrl,
      streamUrl: raw.url,
    })
  );
  const name = flutterStreamName({ ...raw, source: sourceName });
  return {
    source: sourceName,
    type: String(raw.type || 'm3u8').trim() || 'm3u8',
    quality: name,
    name,
    url: String(raw.url || '').trim(),
    headers,
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
    return (checked || []).filter((s) => s && s.active && s.url && s.validation?.ok === true);
  };

  let streams = [];
  let error = null;
  try {
    streams = await source.extractStreams(url, { validateStreams });
    if (
      streams?.length &&
      !streams.every((s) => s.validation && typeof s.validation.ok === 'boolean')
    ) {
      streams = await validateStreams(streams);
    }
    streams = (streams || []).filter((s) => isValidatedStream(s));
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
  if (!String(current.matchUrl || '').trim()) {
    return { match: current, extraction: { skipped: true, reason: 'no_match_url' }, published: null };
  }
  if (looksLikeM3u8(current.matchUrl) && (current.streams || []).some((s) => s?.url)) {
    return { match: current, extraction: { skipped: true, reason: 'already_m3u8' }, published: null };
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
      extraction: { queued: true, reason: 'pipeline_busy' },
      published: null,
    };
  }

  ctx.mainLive.markExtractStatus(matchId, { status: 'SEARCHING', error: null });
  const extraction = await extractMainLiveStreams({
    pipeline: ctx.pipeline,
    matchUrl: current.matchUrl,
    sourceName: current.matchUrlSource,
  });
  const match = ctx.mainLive.applyExtractResult(matchId, extraction);
  const published = await ctx.publish.publishMainLive({ actor });
  return { match, extraction, published };
}

module.exports = {
  looksLikeM3u8,
  resolveSourceFromUrl,
  needsMainLiveExtract,
  extractMainLiveStreams,
  extractAndPublishMainLive,
};
