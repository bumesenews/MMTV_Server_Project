/**
 * Stream validation tests (PART 3).
 * Run: node scripts/testStreamValidation.js
 */
const { DateTime } = require('luxon');
const {
  mergePlaybackHeaders,
  sourceOnlyPlaybackHeaders,
  redactHeadersForLog,
  headerPresence,
  PLAYBACK_UA_MOBILE,
} = require('../src/utils/streamHeaders');
const {
  StreamValidator,
  VALIDATION_STATE,
  parseHlsPlaylist,
} = require('../src/services/streamValidator');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const {
  nextSourceStateAfterAttempt,
  STREAM_SOURCE_STATUS,
  MAX_POST_KICKOFF_ATTEMPTS,
} = require('../src/utils/streamExtractPolicy');
const { DEFAULT_UA } = require('../src/browser/puppeteerManager');
const { MATCH_URL_STATUS } = require('../src/utils/streamUrlHelper');

const ZONE = 'Asia/Yangon';
let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mediaPlaylist() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'segment0.ts',
    '#EXTINF:4.0,',
    'segment1.ts',
  ].join('\n');
}

function masterPlaylist(mediaUrl = 'https://cdn.example/media.m3u8') {
  return [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
    mediaUrl,
  ].join('\n');
}

function emptyPlaylist() {
  return '#EXTM3U\n';
}

function okResponse(data, extra = {}) {
  return {
    status: extra.status || 200,
    headers: { 'content-type': extra.contentType || 'application/vnd.apple.mpegurl' },
    data,
  };
}

function makeHttp(handler) {
  const calls = [];
  return {
    calls,
    async get(url, opts = {}) {
      calls.push({ url, headers: { ...(opts.headers || {}) } });
      const result = await handler(url, opts, calls);
      if (result && result.throw) {
        const err = new Error(result.throw.message || 'error');
        err.code = result.throw.code || 'ECONNABORTED';
        throw err;
      }
      return {
        status: result.status ?? 200,
        headers: {
          'content-type': result.contentType || 'application/vnd.apple.mpegurl',
          ...(result.headers || {}),
        },
        data: result.data ?? '',
      };
    },
  };
}

function stream(url, extra = {}) {
  return {
    source: extra.source || 'socolive',
    url,
    quality: 'HD',
    headers: extra.headers || {},
    matchPageUrl: extra.matchPageUrl || 'https://socolivepp.tv/truc-tiep/demo/',
  };
}

const SOCO_CONFIG = {
  name: 'socolive',
  type: 'streaming',
  domains: ['https://socolivepp.tv'],
  playbackHeaders: {
    'User-Agent': PLAYBACK_UA_MOBILE,
    Referer: 'https://soco.textliveupdaterz.com/',
  },
};

async function run() {
  console.log('\n=== Header merge priority ===');
  {
    const merged = mergePlaybackHeaders({
      streamHeaders: {
        Referer: 'https://socolivepp.tv/truc-tiep/demo/',
        'User-Agent': DEFAULT_UA,
      },
      sourceConfig: SOCO_CONFIG,
      matchPageUrl: 'https://socolivepp.tv/truc-tiep/demo/',
    });
    assert(
      'source Referer beats guessed match-page Referer',
      merged.Referer === 'https://soco.textliveupdaterz.com/'
    );
    assert(
      'source User-Agent beats default desktop UA',
      merged['User-Agent'] === PLAYBACK_UA_MOBILE
    );

    const captured = mergePlaybackHeaders({
      streamHeaders: { Referer: 'https://embed.cdn.example/player/' },
      sourceConfig: SOCO_CONFIG,
      matchPageUrl: 'https://socolivepp.tv/truc-tiep/demo/',
    });
    assert(
      'captured stream Referer overrides source',
      captured.Referer === 'https://embed.cdn.example/player/'
    );

    const fromHeadersField = mergePlaybackHeaders({
      sourceConfig: {
        headers: { Referer: 'https://legacy.example/', 'User-Agent': PLAYBACK_UA_MOBILE },
      },
    });
    assert(
      'reuses source.headers when playbackHeaders is absent',
      fromHeadersField.Referer === 'https://legacy.example/'
    );

    const redacted = redactHeadersForLog({
      Referer: 'https://soco.textliveupdaterz.com/',
      Cookie: 'secret=token-value',
      Authorization: 'Bearer abc',
      'User-Agent': PLAYBACK_UA_MOBILE,
    });
    assert('logs do not print cookie values', redacted.Cookie === 'configured');
    assert('logs do not print tokens', redacted.Authorization === 'configured');
    assert('Referer logged as configured', redacted.Referer === 'configured');
    assert('headerPresence reports configured', headerPresence(merged, 'Referer') === 'configured');
  }

  console.log('\n=== 1. m3u8 works without headers ===');
  {
    const http = makeHttp(async () => okResponse(mediaPlaylist()));
    const validator = new StreamValidator({ http, sourceConfigs: { open: {} } });
    const result = await validator.validate(
      stream('https://cdn.example/open.m3u8', { source: 'open', headers: {} }),
      { sourceConfig: {} }
    );
    assert('AVAILABLE without required headers', result.validation.state === VALIDATION_STATE.AVAILABLE);
    assert('validation.ok true', result.validation.ok === true);
    assert('HTTP 200 is not enough by itself — HLS body required', /#EXTM3U/.test(mediaPlaylist()));
  }

  console.log('\n=== 2. m3u8 requires Referer ===');
  {
    const http = makeHttp(async (_url, opts) => {
      if (opts.headers?.Referer === 'https://soco.textliveupdaterz.com/') {
        return okResponse(mediaPlaylist());
      }
      return { status: 403, data: 'Forbidden', contentType: 'text/html' };
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://live2.streambylivepulse.com/live/channel1.m3u8'), {
      sourceConfig: SOCO_CONFIG,
    });
    assert('AVAILABLE with source Referer', result.validation.ok === true);
    assert(
      'saved Referer is playback Referer',
      result.streamHeaders.Referer === 'https://soco.textliveupdaterz.com/'
    );
    assert(
      'request used Referer',
      http.calls[0].headers.Referer === 'https://soco.textliveupdaterz.com/'
    );
  }

  console.log('\n=== 3. m3u8 requires User-Agent ===');
  {
    const http = makeHttp(async (_url, opts) => {
      if (opts.headers?.['User-Agent'] === PLAYBACK_UA_MOBILE) return okResponse(mediaPlaylist());
      return { status: 403, data: 'Forbidden' };
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/ua.m3u8'), {
      sourceConfig: { playbackHeaders: { 'User-Agent': PLAYBACK_UA_MOBILE } },
    });
    assert('AVAILABLE with required User-Agent', result.validation.ok === true);
    assert('saved UA is mobile playback UA', result.streamHeaders['User-Agent'] === PLAYBACK_UA_MOBILE);
  }

  console.log('\n=== 4. m3u8 requires Referer + User-Agent ===');
  {
    const http = makeHttp(async (_url, opts) => {
      const h = opts.headers || {};
      if (
        h.Referer === 'https://soco.textliveupdaterz.com/' &&
        h['User-Agent'] === PLAYBACK_UA_MOBILE
      ) {
        return okResponse(mediaPlaylist());
      }
      return { status: 403, data: 'Forbidden' };
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(
      stream('https://live2.streambylivepulse.com/live/channel1.m3u8'),
      { sourceConfig: SOCO_CONFIG }
    );
    assert('AVAILABLE with Referer + UA', result.validation.state === VALIDATION_STATE.AVAILABLE);
    assert(
      'Flutter headers include both',
      result.streamHeaders.Referer === 'https://soco.textliveupdaterz.com/' &&
        result.streamHeaders['User-Agent'] === PLAYBACK_UA_MOBILE
    );
  }

  console.log('\n=== 5. m3u8 requires Origin ===');
  {
    const origin = 'https://soco.textliveupdaterz.com';
    const http = makeHttp(async (_url, opts) => {
      if (opts.headers?.Origin === origin) return okResponse(mediaPlaylist());
      return { status: 403, data: 'Forbidden' };
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/origin.m3u8'), {
      sourceConfig: {
        playbackHeaders: {
          Referer: `${origin}/`,
          Origin: origin,
          'User-Agent': PLAYBACK_UA_MOBILE,
        },
      },
    });
    assert('AVAILABLE with Origin', result.validation.ok === true);
    assert('saved Origin for Flutter', result.streamHeaders.Origin === origin);
    assert('request sent Origin', http.calls[0].headers.Origin === origin);
  }

  console.log('\n=== 6. 403 without headers, success with source headers ===');
  {
    const http = makeHttp(async (_url, opts) => {
      const h = opts.headers || {};
      if (
        h.Referer === 'https://soco.textliveupdaterz.com/' &&
        h['User-Agent'] === PLAYBACK_UA_MOBILE
      ) {
        return okResponse(mediaPlaylist());
      }
      return { status: 403, data: 'Denied' };
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(
      stream('https://live2.streambylivepulse.com/live/channel1.m3u8', {
        headers: {
          Referer: 'https://wrong.example/',
          'User-Agent': 'BadBot/1.0',
        },
      }),
      { sourceConfig: SOCO_CONFIG }
    );
    assert('retries after 403 and becomes AVAILABLE', result.validation.ok === true);
    assert('retriedWithSourceHeaders', result.validation.retriedWithSourceHeaders === true);
    assert('at least two GETs (wrong headers then source headers)', http.calls.length >= 2);
    assert(
      'retry used source Referer',
      http.calls[1].headers.Referer === 'https://soco.textliveupdaterz.com/'
    );
    assert(
      'does not mark INVALID before header-aware retry',
      result.validation.state === VALIDATION_STATE.AVAILABLE
    );
  }

  console.log('\n=== 7. invalid m3u8 ===');
  {
    const http = makeHttp(async () => ({
      status: 200,
      data: '<html>not a playlist</html>',
      contentType: 'text/html',
    }));
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/live.m3u8'), {
      sourceConfig: SOCO_CONFIG,
    });
    assert('.m3u8 suffix is not enough', result.validation.ok === false);
    assert('state NOT_HLS', result.validation.state === VALIDATION_STATE.NOT_HLS);
    assert('HTTP 200 alone is not AVAILABLE', result.active === false);
  }

  console.log('\n=== 8. empty playlist ===');
  {
    const http = makeHttp(async () => okResponse(emptyPlaylist()));
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/empty.m3u8'));
    assert('EMPTY_PLAYLIST', result.validation.state === VALIDATION_STATE.EMPTY_PLAYLIST);
    assert('not AVAILABLE', result.validation.ok === false);
  }

  console.log('\n=== 9. valid master playlist ===');
  {
    const mediaUrl = 'https://cdn.example/720.m3u8';
    const http = makeHttp(async (url) => {
      if (url === mediaUrl) return okResponse(mediaPlaylist());
      return okResponse(masterPlaylist(mediaUrl));
    });
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/master.m3u8'));
    assert('master AVAILABLE', result.validation.ok === true);
    assert('playlistType master', result.validation.playlistType === 'master');
    assert('resolved media playlist', http.calls.some((c) => c.url === mediaUrl));
  }

  console.log('\n=== 10. valid media playlist ===');
  {
    const parsed = parseHlsPlaylist(mediaPlaylist(), 'https://cdn.example/media.m3u8');
    assert('parser sees media segments', parsed.kind === 'media' && parsed.segments.length >= 2);
    const http = makeHttp(async () => okResponse(mediaPlaylist()));
    const validator = new StreamValidator({ http });
    const result = await validator.validate(stream('https://cdn.example/media.m3u8'));
    assert('media AVAILABLE', result.validation.state === VALIDATION_STATE.AVAILABLE);
    assert('playlistType media', result.validation.playlistType === 'media');
  }

  console.log('\n=== 11. dead stream ===');
  {
    const http404 = makeHttp(async () => ({ status: 404, data: 'not found', contentType: 'text/plain' }));
    const dead404 = await new StreamValidator({ http: http404 }).validate(
      stream('https://cdn.example/gone.m3u8')
    );
    assert('HTTP_404', dead404.validation.state === VALIDATION_STATE.HTTP_404);

    const httpTimeout = makeHttp(async () => ({ throw: { code: 'ECONNABORTED', message: 'timeout' } }));
    const timed = await new StreamValidator({ http: httpTimeout }).validate(
      stream('https://cdn.example/hang.m3u8')
    );
    assert('TIMEOUT', timed.validation.state === VALIDATION_STATE.TIMEOUT);

    const noSeg = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n',
      'https://cdn.example/noseg.m3u8'
    );
    assert('NO_SEGMENTS for media without URIs', noSeg.state === VALIDATION_STATE.NO_SEGMENTS);
  }

  console.log('\n=== 12. Flutter receives required playback headers ===');
  {
    const kickoff = DateTime.now().setZone(ZONE).toISO();
    const payload = generateFlutterJson([
      {
        matchId: 'inter_juventus_20260815',
        league: 'Serie A',
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
        time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
        kickoff,
        status: 'LIVE',
        streams: [
          {
            source: 'socolive',
            type: 'm3u8',
            quality: 'HD',
            url: 'https://live2.streambylivepulse.com/live/channel1.m3u8',
            active: true,
            validation: { ok: true, state: 'AVAILABLE' },
            headers: {
              'User-Agent': PLAYBACK_UA_MOBILE,
              Referer: 'https://soco.textliveupdaterz.com/',
              Origin: 'https://soco.textliveupdaterz.com',
            },
            streamHeaders: {
              'User-Agent': PLAYBACK_UA_MOBILE,
              Referer: 'https://soco.textliveupdaterz.com/',
              Origin: 'https://soco.textliveupdaterz.com',
            },
          },
        ],
        originalNames: {},
        sourcePages: { socolive: 'https://socolivepp.tv/truc-tiep/inter-juventus/' },
        streamAttempts: {},
        streamStatus: 'AVAILABLE',
        streamUrl: 'https://live2.streambylivepulse.com/live/channel1.m3u8',
      },
    ]);
    const m = payload.matches[0];
    assert('streams[].headers.Referer present', m.streams[0].headers.Referer === 'https://soco.textliveupdaterz.com/');
    assert('streams[].headers.User-Agent present', m.streams[0].headers['User-Agent'] === PLAYBACK_UA_MOBILE);
    assert('streams[].headers.Origin present', m.streams[0].headers.Origin === 'https://soco.textliveupdaterz.com');
    assert(
      'streams[].streamHeaders matches playback headers',
      m.streams[0].streamHeaders.Referer === m.streams[0].headers.Referer
    );
    assert('match.streamUrl present', m.streamUrl.includes('channel1.m3u8'));
    assert(
      'match.streamHeaders present for Flutter',
      m.streamHeaders?.Referer === 'https://soco.textliveupdaterz.com/' &&
        m.streamHeaders?.['User-Agent'] === PLAYBACK_UA_MOBILE
    );
    assert('Flutter streamStatus remains AVAILABLE', m.streamStatus === 'AVAILABLE');
    assert(
      'existing Flutter fields still present',
      ['matchId', 'league', 'homeTeam', 'awayTeam', 'date', 'time', 'kickoff', 'timezone', 'status', 'streams'].every(
        (k) => Object.prototype.hasOwnProperty.call(m, k)
      )
    );
  }

  console.log('\n=== Retry policy: validation miss is not permanent FAILED ===');
  {
    const afterKickoff = nextSourceStateAfterAttempt({
      previous: { attempts: 0, postKickoffAttempts: 0 },
      slot: { id: 't0', postKickoff: true },
      validatedStreams: [],
      error: 'HTTP_403',
    });
    assert(
      'kickoff miss stays SEARCHING',
      afterKickoff.status === STREAM_SOURCE_STATUS.SEARCHING &&
        afterKickoff.postKickoffAttempts === 1
    );

    const exhausted = nextSourceStateAfterAttempt({
      previous: { attempts: 2, postKickoffAttempts: 2 },
      slot: { id: 't10', postKickoff: true },
      validatedStreams: [],
    });
    assert(
      `FAILED only after ${MAX_POST_KICKOFF_ATTEMPTS} post-kickoff attempts`,
      exhausted.status === STREAM_SOURCE_STATUS.FAILED &&
        exhausted.postKickoffAttempts === MAX_POST_KICKOFF_ATTEMPTS
    );

    const recovered = nextSourceStateAfterAttempt({
      previous: { attempts: 2, postKickoffAttempts: 2, status: STREAM_SOURCE_STATUS.SEARCHING },
      slot: { id: 't10', postKickoff: true },
      validatedStreams: [{ url: 'https://cdn.example/live.m3u8', validation: { ok: true } }],
    });
    assert('AVAILABLE when a later attempt validates', recovered.status === STREAM_SOURCE_STATUS.AVAILABLE);
  }

  console.log('\n=== Source-only retry headers ===');
  {
    const retry = sourceOnlyPlaybackHeaders(SOCO_CONFIG, 'https://socolivepp.tv/truc-tiep/x/');
    assert(
      'source-only retry keeps configured Referer',
      retry.Referer === 'https://soco.textliveupdaterz.com/'
    );
  }

  console.log('\n=== CDN Referer fallback after 403 ===');
  {
    const xoilacCfg = {
      name: 'xoilac',
      domains: ['https://xoilacxtr.tv'],
      playbackHeaders: {
        'User-Agent': PLAYBACK_UA_MOBILE,
        Referer: 'https://xoilacxtr.tv/',
      },
    };
    const referers = [];
    const validator = new StreamValidator({
      sourceConfigs: { xoilac: xoilacCfg, socolive: SOCO_CONFIG },
      http: {
        get: async (url, opts) => {
          referers.push(opts.headers.Referer);
          if (opts.headers.Referer === 'https://soco.textliveupdaterz.com/') {
            return {
              status: 200,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
              data: mediaPlaylist(),
            };
          }
          return { status: 403, headers: {}, data: 'denied' };
        },
      },
    });
    const result = await validator.validate(
      {
        url: 'https://live2.livefeedtextbox.com/live/channel1.m3u8',
        source: 'xoilac',
        matchPageUrl: 'https://xoilacxtr.tv/truc-tiep/malaysia-vs-viet-nam/',
      },
      { sourceConfig: xoilacCfg }
    );
    assert('Xoilac 403 then Socolive Referer becomes AVAILABLE', result.validation.ok === true);
    assert(
      'Flutter gets the working Referer',
      result.headers.Referer === 'https://soco.textliveupdaterz.com/'
    );
    assert('tried more than one Referer', referers.length >= 2);
  }

  console.log('\n=== Keep one stream per source even when CDN URL matches ===');
  {
    const validator = new StreamValidator();
    const url = 'https://live2.livefeedtextbox.com/live/channel22.m3u8';
    const ranked = validator.dedupeAndRank([
      { source: 'socolive', url, quality: 'Link 1', active: true, validation: { ok: true, playlistHash: 'abc' } },
      { source: 'cakhia', url, quality: 'Link 1', active: true, validation: { ok: true, playlistHash: 'abc' } },
      { source: 'xoilac', url, quality: 'Link 1', active: true, validation: { ok: true, playlistHash: 'abc' } },
      { source: 'socolive', url, quality: 'Link 2', active: true, validation: { ok: true, playlistHash: 'abc' } },
    ]);
    const sources = ranked.map((s) => s.source).sort();
    assert('three sources kept', ranked.length === 3, `got ${ranked.length}`);
    assert(
      'socolive/cakhia/xoilac all present',
      sources.join(',') === 'cakhia,socolive,xoilac'
    );
    const twoLabels = validator.dedupeAndRank([
      { source: 'socolive', url: `${url}?cdn=tom`, quality: 'TOM', active: true, validation: { ok: true, playlistHash: 'abc' } },
      { source: 'socolive', url: `${url}?cdn=hdtom`, quality: 'HDTOM', active: true, validation: { ok: true, playlistHash: 'abc' } },
    ]);
    assert(
      'TOM and HDTOM stay both when play URLs differ',
      twoLabels.length === 2,
      `got ${twoLabels.length}`
    );

    const { mergeStreamLists } = require('../src/services/matchesSyncService');
    const merged = mergeStreamLists(
      [{ source: 'socolive', url, active: true }],
      [{ source: 'cakhia', url, active: true }]
    );
    assert('sync merge adds second source', merged.streams.length === 2 && merged.added === 1);

    const pages = {
      socolive: 'https://socolivepp.tv/truc-tiep/basel-vs-barcelona/',
      cakhia: 'https://cakhiazvm.tv/truc-tiep/basel-vs-barcelona/',
      xoilac: 'https://xoilacxtr.tv/truc-tiep/basel-vs-barcelona/',
    };
    const matchUrlSearch = {
      sources: {
        socolive: { matchUrl: pages.socolive, status: MATCH_URL_STATUS.CONFIRMED, attempts: 1, confidence: 100 },
        cakhia: { matchUrl: pages.cakhia, status: MATCH_URL_STATUS.CONFIRMED, attempts: 1, confidence: 100 },
        xoilac: { matchUrl: pages.xoilac, status: MATCH_URL_STATUS.CONFIRMED, attempts: 1, confidence: 100 },
      },
    };
    const payload = generateFlutterJson([
      {
        matchId: 'basel_barcelona_20260816',
        league: 'Club Friendlies',
        homeTeam: 'Basel',
        awayTeam: 'Barcelona',
        date: '2026-08-16',
        time: '21:00',
        kickoff: DateTime.now().setZone(ZONE).toISO(),
        status: 'LIVE',
        streams: ranked,
        streamStatus: 'AVAILABLE',
        sourcePages: pages,
        matchUrlSearch,
      },
    ]);
    assert('Flutter streamCount is 3', payload.matches[0].streamCount === 3);
    assert(
      'Flutter names include source',
      payload.matches[0].streams.every((s) => String(s.name).includes(s.source.charAt(0).toUpperCase() + s.source.slice(1)))
    );

    const collapsed = generateFlutterJson([
      {
        matchId: 'basel_barcelona_collapsed_20260816',
        league: 'Club Friendlies',
        homeTeam: 'Basel',
        awayTeam: 'Barcelona',
        date: '2026-08-16',
        time: '21:00',
        kickoff: DateTime.now().setZone(ZONE).toISO(),
        status: 'LIVE',
        streams: [
          { source: 'socolive', url, quality: 'Link 1', active: true, validation: { ok: true } },
        ],
        sourcePages: pages,
        matchUrlSearch,
        streamSearch: {
          sources: {
            cakhia: { status: 'AVAILABLE' },
            socolive: { status: 'AVAILABLE' },
            xoilac: { status: 'AVAILABLE' },
          },
        },
        streamStatus: 'AVAILABLE',
      },
    ]);
    assert(
      'collapsed match still publishes 3 Flutter links',
      collapsed.matches[0].streamCount === 3,
      `got ${collapsed.matches[0].streamCount}`
    );
  }
}

run()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
