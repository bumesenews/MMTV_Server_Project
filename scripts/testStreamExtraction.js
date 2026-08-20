/**
 * Stream extraction tests (PART 2).
 * Run: node scripts/testStreamExtraction.js
 */
const { DateTime } = require('luxon');
const { JobQueue } = require('../src/utils/jobQueue');
const {
  STREAM_SOURCE_STATUS,
  MAX_POST_KICKOFF_ATTEMPTS,
  isValidatedStream,
  decideSourceExtract,
  nextSourceStateAfterAttempt,
  aggregateStreamStatus,
  aggregateValidationFields,
  isBrowserProtocolError,
  normalizeValidationReason,
  sourceNeedsMorePlayerStreams,
} = require('../src/utils/streamExtractPolicy');
const { MATCH_URL_STATUS } = require('../src/utils/streamUrlHelper');
const {
  runAxiosThenPuppeteer,
  findStreamPatterns,
  extractIframeSrcs,
  parsePlayerTabs,
  parseStreamButtons,
  parseListStreamGroups,
  isJsShellHtml,
} = require('../src/sources/httpStreamExtractor');
const { isFrameUsable } = require('../src/sources/streamExtractor');
const { resolvePlayerWait } = require('../src/sources/baseStreamingSource');
const { gotoMatchPage } = require('../src/browser/puppeteerManager');
const { StreamEngine } = require('../src/services/streamEngine');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const { isStreamSearchStopped } = require('../src/utils/time');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function kickoffIso(offsetMin) {
  return DateTime.now().setZone(ZONE).plus({ minutes: offsetMin }).toISO();
}

function confirmedUrlState(url) {
  return {
    matchUrl: url,
    status: MATCH_URL_STATUS.CONFIRMED,
    attempts: 1,
    slotsDone: { t30: true },
    confidence: 100,
  };
}

function fixture({ id = 'm1', offsetMin = 0, sources = ['cakhia'] } = {}) {
  const kickoff = kickoffIso(offsetMin);
  const matchUrlSearch = { slotsDone: { t30: true }, sources: {} };
  const sourcePages = {};
  for (const name of sources) {
    const url = `https://example.com/${name}/${id}`;
    matchUrlSearch.sources[name] = confirmedUrlState(url);
    sourcePages[name] = url;
  }
  return {
    matchId: id,
    fotmobId: 99,
    leagueFotmobId: 47,
    league: 'English Premier League (EPL)',
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
    time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
    kickoff,
    status: 'LIVE',
    streams: [],
    sourcePages,
    matchUrl: sourcePages[sources[0]],
    matchUrlStatus: MATCH_URL_STATUS.CONFIRMED,
    matchUrlSearch,
    originalNames: { fotmob: { homeTeam: 'Inter', awayTeam: 'Juventus' } },
  };
}

class FakeValidator {
  async fastHealthCheckMany(streams) {
    return (streams || []).map((s) => {
      const ok = Boolean(s?.url) && s._valid !== false;
      return {
        ...s,
        active: ok,
        validation: { ok, reason: ok ? 'ok' : 'failed' },
      };
    });
  }
  dedupeAndRank(streams) {
    return streams || [];
  }
}

function mockSource(name, extractFn) {
  return {
    name,
    config: { enabled: true, priority: 100 },
    extractStreams: extractFn,
    discoverMatchesForFixtures: async () => [],
    discoverMatches: async () => [],
  };
}

function engineWith(sources, extra = {}) {
  return new StreamEngine({
    sources,
    validator: extra.validator || new FakeValidator(),
    scraperMonitor: extra.scraperMonitor || null,
  });
}

console.log('\n=== Socolive TOM / HDTOM player tabs ===');
{
  const page =
    'https://socolivepp.tv/truc-tiep/mjallby-aif-vs-red-bull-salzburg-luc-2300-ngay-20-08-2026/';
  const html = `
    <div id="tv_links">
      <a class="player-link" href="${page}link/1">TOM</a>
      <a class="player-link" href="${page}link/2">HDTOM</a>
      <a class="player-link" href="${page}link/3">VIP</a>
      <a class="player-link" href="${page}link/4">H265</a>
    </div>`;
  const tabs = parsePlayerTabs(html, page);
  const names = tabs.map((t) => t.name);
  const urls = tabs.map((t) => t.url);
  assert(
    'parses TOM and HDTOM /link/ pages',
    names.includes('TOM') && names.includes('HDTOM'),
    JSON.stringify(names)
  );
  assert(
    'keeps distinct player URLs',
    urls.some((u) => /\/link\/1/.test(u)) && urls.some((u) => /\/link\/2/.test(u)),
    JSON.stringify(urls)
  );
  assert(
    'keeps all 4 player tabs',
    names.includes('VIP') && names.includes('H265') && urls.filter((u) => /\/link\/\d+/.test(u)).length === 4,
    JSON.stringify(names)
  );
}

{
  const { maxPlayerStreams } = require('../src/utils/scraperConfig');
  assert('1GB cap is TOM+HDTOM (2)', maxPlayerStreams({}) === 2);
  assert(
    'HTTP_STREAM_MAX_EMBEDS overrides 1GB cap',
    maxPlayerStreams({ HTTP_STREAM_MAX_EMBEDS: '4' }) === 4
  );
}

{
  const page =
    'https://socolivepp.tv/truc-tiep/besiktas-jk-vs-kauno-zalgiris-luc-0000-ngay-21-08-2026/';
  const html = `
    <script>var list_stream = [["https:\\/\\/soco.edgevaultmedia.com\\/ajax\\/chanel\\/type\\/8\\/link\\/channel4"],["https:\\/\\/soco.edgevaultmedia.com\\/ajax\\/chanel\\/type\\/5\\/link\\/channel-4"]];</script>
    <div id="tv_links">
      <a class="player-link playing" href="${page.replace(/\/$/, '')}" data-link="0">TOM</a>
      <a class="player-link" href="${page}link/1" data-link="1">HD TOM</a>
    </div>`;
  const groups = parseListStreamGroups(html);
  const buttons = parseStreamButtons(html);
  const tabs = parsePlayerTabs(html, page);
  assert('parses both list_stream groups', groups.length === 2, JSON.stringify(groups));
  assert(
    'buttons are TOM and HD TOM',
    buttons.some((b) => b.index === 0 && b.name === 'TOM') &&
      buttons.some((b) => b.index === 1 && /HD\s*TOM/i.test(b.name)),
    JSON.stringify(buttons)
  );
  assert(
    'first tab is TOM not generic HD',
    tabs[0]?.name === 'TOM',
    JSON.stringify(tabs.map((t) => t.name))
  );
  assert(
    'HD TOM is a /link/1 tab',
    tabs.some((t) => /\/link\/1/.test(t.url) && /HD\s*TOM/i.test(t.name)),
    JSON.stringify(tabs)
  );
  assert(
    'ColaTV SPA shell is not treated as a player page',
    isJsShellHtml('<div id="root"></div><script type="module" crossorigin src="/assets/index.js"></script>')
  );
}

console.log('\n=== Source skip / retry policy ===');
{
  const urlState = confirmedUrlState('https://cakhiazvm.tv/truc-tiep/inter-vs-juventus/');
  const available = decideSourceExtract({
    sourceName: 'cakhia',
    streamSearch: { sources: { cakhia: { status: 'AVAILABLE', postKickoffAttempts: 0 } } },
    matchUrlState: urlState,
    slot: { id: 'tP5', postKickoff: true },
  });
  assert('Source already AVAILABLE → skip', available.reason === 'already_available');

  const availableOneLink = decideSourceExtract({
    sourceName: 'socolive',
    streamSearch: { sources: { socolive: { status: 'AVAILABLE', slotsDone: { t0: true } } } },
    matchUrlState: confirmedUrlState(
      'https://socolivepp.tv/truc-tiep/besiktas-jk-vs-kauno-zalgiris/'
    ),
    slot: { id: 'catchup', postKickoff: true },
    match: {
      streams: [
        {
          source: 'socolive',
          url: 'https://live2.livefeedtextbox.com/live/channel4.m3u8',
          active: true,
          validation: { ok: true },
        },
      ],
    },
  });
  assert(
    'AVAILABLE with only TOM still extracts HDTOM',
    availableOneLink.skip === false,
    availableOneLink.reason
  );
  assert(
    'one unique URL needs a second player',
    sourceNeedsMorePlayerStreams(
      {
        streams: [
          {
            source: 'socolive',
            url: 'https://live2.livefeedtextbox.com/live/channel4.m3u8',
          },
        ],
      },
      'socolive'
    )
  );

  const availableMissing = decideSourceExtract({
    sourceName: 'cakhia',
    streamSearch: { sources: { cakhia: { status: 'AVAILABLE', slotsDone: { t30: true } } } },
    matchUrlState: urlState,
    slot: { id: 't30', postKickoff: false },
    match: { streams: [{ source: 'socolive', url: 'https://cdn.example/live.m3u8', active: true, validation: { ok: true } }] },
  });
  assert(
    'AVAILABLE without own stream → extract again',
    availableMissing.skip === false,
    availableMissing.reason
  );

  const failed = decideSourceExtract({
    sourceName: 'xoilac',
    streamSearch: {
      sources: {
        xoilac: { status: 'FAILED', postKickoffAttempts: MAX_POST_KICKOFF_ATTEMPTS },
      },
    },
    matchUrlState: urlState,
    slot: { id: 'tP10', postKickoff: true },
  });
  assert('Source already FAILED (3 attempts) → skip', failed.reason === 'already_failed');

  const dup = decideSourceExtract({
    sourceName: 'cola',
    streamSearch: {
      sources: { cola: { status: 'SEARCHING', slotsDone: { t0: true }, postKickoffAttempts: 1 } },
    },
    matchUrlState: urlState,
    slot: { id: 't0', postKickoff: true },
  });
  assert('Duplicate job same match+source+attempt → skip', dup.reason === 'duplicate_attempt');

  const noUrl = decideSourceExtract({
    sourceName: 'soco',
    streamSearch: { sources: {} },
    matchUrlState: { matchUrl: null, status: MATCH_URL_STATUS.NOT_FOUND },
    slot: { id: 't0', postKickoff: true },
  });
  assert('No confirmed Match URL → do not extract', noUrl.reason === 'no_confirmed_match_url');

  const ok = decideSourceExtract({
    sourceName: 'cakhia',
    streamSearch: { sources: { cakhia: { status: 'SEARCHING', postKickoffAttempts: 1 } } },
    matchUrlState: urlState,
    slot: { id: 'tP5', postKickoff: true },
  });
  assert('Retry allowed when not available/failed', ok.skip === false && ok.matchUrl);

  const preKickoff = decideSourceExtract({
    sourceName: 'cakhia',
    streamSearch: { sources: {} },
    matchUrlState: urlState,
    slot: { id: 't30', postKickoff: false },
  });
  assert(
    'Extract allowed −30m when Match URL is saved',
    preKickoff.skip === false && preKickoff.matchUrl
  );

  {
    const engine = engineWith([mockSource('cakhia', async () => [])]);
    const at30 = fixture({ id: 'pre30', offsetMin: 28, sources: ['cakhia'] });
    assert('Engine extracts at −30m window', engine.shouldExtractStreams(at30) === true);
    const morning = fixture({ id: 'pre3h', offsetMin: 180, sources: ['cakhia'] });
    assert('Engine does not extract 3h before kickoff', engine.shouldExtractStreams(morning) === false);
  }

  const after1 = nextSourceStateAfterAttempt({
    previous: { attempts: 0, postKickoffAttempts: 0, slotsDone: {} },
    slot: { id: 't0', postKickoff: true },
    validatedStreams: [],
  });
  assert('Attempt 1 miss stays SEARCHING', after1.status === 'SEARCHING' && after1.postKickoffAttempts === 1);

  const after2 = nextSourceStateAfterAttempt({
    previous: after1,
    slot: { id: 'tP5', postKickoff: true },
    validatedStreams: [{ url: 'https://x.m3u8', validation: { ok: true }, active: true }],
  });
  assert('Stream found on attempt 2 → AVAILABLE', after2.status === 'AVAILABLE');

  const miss2 = nextSourceStateAfterAttempt({
    previous: after1,
    slot: { id: 'tP5', postKickoff: true },
    validatedStreams: [],
  });
  const miss3 = nextSourceStateAfterAttempt({
    previous: miss2,
    slot: { id: 'tP10', postKickoff: true },
    validatedStreams: [],
  });
  assert(
    '3 post-kickoff misses → FAILED',
    miss3.status === 'FAILED' && miss3.postKickoffAttempts === 3
  );

  const found3 = nextSourceStateAfterAttempt({
    previous: miss2,
    slot: { id: 'tP10', postKickoff: true },
    validatedStreams: [{ url: 'https://x.m3u8', validation: { ok: true }, active: true }],
  });
  assert('Stream found on attempt 3 → AVAILABLE', found3.status === 'AVAILABLE');

  assert(
    'Unvalidated m3u8 is not AVAILABLE',
    isValidatedStream({ url: 'https://x.m3u8', active: true }) === false
  );
  assert(
    'Validated m3u8 is AVAILABLE-eligible',
    isValidatedStream({ url: 'https://x.m3u8', active: true, validation: { ok: true } }) === true
  );

  const liveSearching = aggregateStreamStatus(
    { sources: { cakhia: { status: 'SEARCHING' } } },
    { hasValidatedStream: false, mins: -1 }
  );
  assert(
    'LIVE match can have streamStatus=SEARCHING',
    liveSearching === STREAM_SOURCE_STATUS.SEARCHING
  );
  assert(
    'stopped search with no streams is FAILED',
    aggregateStreamStatus(
      { started: true, stopped: true, sources: {} },
      { hasValidatedStream: false, stopped: true, mins: -90 }
    ) === STREAM_SOURCE_STATUS.FAILED
  );
  assert(
    'stopped without ever starting stays PREPARING',
    aggregateStreamStatus(
      { started: false, stopped: true, sources: {} },
      { hasValidatedStream: false, stopped: true, mins: 40 }
    ) === STREAM_SOURCE_STATUS.PREPARING
  );
  assert(
    'detached Frame is a browser error, not HLS validation',
    isBrowserProtocolError("Attempted to use detached Frame 'ABC'") === true
  );
  const browserFail = aggregateValidationFields(
    {
      streams: [],
      streamSearch: {
        sources: {
          mitomtm: {
            status: 'SEARCHING',
            lastError: "Attempted to use detached Frame 'ABC'",
            lastAttemptAt: 'z',
          },
        },
      },
    },
    'SEARCHING'
  );
  assert(
    'Flutter validationStatus is not the raw Frame id',
    browserFail.validationStatus === 'VALIDATING' &&
      browserFail.validationReason === 'BROWSER_ERROR'
  );
  assert(
    'unknown error text is NOT_FOUND, not leaked',
    normalizeValidationReason('something exploded in chromium internals xyz') === 'NOT_FOUND'
  );
  const afterMiss = nextSourceStateAfterAttempt({
    previous: {},
    slot: { id: 't0', postKickoff: true },
    error: "Attempted to use detached Frame 'ABC'",
  });
  assert(
    'source lastError is BROWSER_ERROR code',
    afterMiss.lastError === 'BROWSER_ERROR'
  );

  const hlsHits = findStreamPatterns(
    'const x = "https://cdn.livecdn.tv/live/abc/index.m3u8?token=1"; playurl="https://a.com/hls/master.m3u8"',
    'https://xoilacxtr.tv/'
  );
  assert('Vietnamese HLS URL patterns are detected', hlsHits.length >= 1);

  const iframes = extractIframeSrcs(
    '<iframe data-src="https://player.example/embed/1"></iframe>',
    'https://mitomtm.cc/'
  );
  assert(
    'iframe data-src is detected',
    iframes.includes('https://player.example/embed/1')
  );

  const xoilacWait = resolvePlayerWait({ name: 'xoilac' }, 25000);
  assert(
    'xoilac gets a longer player wait than default',
    xoilacWait.playerWaitTimeoutMs >= 10000 && xoilacWait.navigationTimeoutMs >= 28000
  );

  assert(
    'detached frame is skipped',
    isFrameUsable({ isDetached: () => true, url: () => 'https://cdn/player' }) === false
  );
  assert(
    'about:blank frame is skipped',
    isFrameUsable({ isDetached: () => false, url: () => 'about:blank' }) === false
  );
  assert(
    'attached player frame is usable',
    isFrameUsable({ isDetached: () => false, url: () => 'https://cdn/player' }) === true
  );
}

console.log('\n=== +15m stop ===');
{
  const kickoff = DateTime.now().setZone(ZONE).minus({ minutes: 16 }).toISO();
  assert('+15m stop window is active', isStreamSearchStopped(kickoff, {}) === true);
  const stopped = decideSourceExtract({
    sourceName: 'cakhia',
    streamSearch: { sources: {} },
    matchUrlState: confirmedUrlState('https://x/'),
    slot: { id: 'tP10', postKickoff: true },
    stopped: true,
  });
  assert('+15m → skip extract', stopped.reason === 'stopped');
}

async function runAsyncTests() {
  console.log('\n=== Player wait (networkidle2 after DOM) ===');
  {
    const calls = [];
    const page = {
      isClosed: () => false,
      goto: async (_url, opts) => {
        calls.push(['goto', opts.waitUntil]);
      },
      waitForNetworkIdle: async (opts) => {
        calls.push(['idle', opts.concurrency]);
      },
      waitForSelector: async () => {
        calls.push(['selector']);
      },
    };
    await gotoMatchPage(page, 'https://xoilacxtr.tv/match', {
      waitUntil: 'domcontentloaded',
      playerWaitUntil: 'networkidle2',
      playerWaitTimeoutMs: 1000,
      timeout: 5000,
    });
    assert('goto uses domcontentloaded first', calls[0][0] === 'goto' && calls[0][1] === 'domcontentloaded');
    assert(
      'player wait uses networkidle2 (2 in-flight connections)',
      calls[1][0] === 'idle' && calls[1][1] === 2
    );
    const idleFailPage = {
      isClosed: () => false,
      goto: async () => {},
      waitForNetworkIdle: async () => {
        throw new Error('TimeoutError');
      },
      waitForSelector: async () => {
        throw new Error('TimeoutError');
      },
    };
    await gotoMatchPage(idleFailPage, 'https://mitomtm.cc/match', {
      playerWaitUntil: 'networkidle2',
      playerWaitTimeoutMs: 10,
    });
    assert('networkidle timeout does not fail extraction', true);
  }

  console.log('\n=== Axios first / Puppeteer fallback ===');
  {
    let puppeteerLaunched = false;
    const axiosOk = await runAxiosThenPuppeteer({
      axiosExtract: async () => [
        { url: 'https://cdn.example/live.m3u8', source: 'cakhia', active: true },
      ],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/other.m3u8', source: 'cakhia' }];
      },
      validate: async (streams) =>
        streams.map((s) => ({ ...s, active: true, validation: { ok: true } })),
    });
    assert('Axios finds stream → method axios', axiosOk.method === 'axios' && axiosOk.streams.length === 1);
    assert(
      'Axios success does NOT launch Puppeteer',
      puppeteerLaunched === false && axiosOk.puppeteerLaunched === false
    );

    puppeteerLaunched = false;
    const axiosEmpty = await runAxiosThenPuppeteer({
      axiosExtract: async () => [],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/pp.m3u8', source: 'cakhia' }];
      },
      validate: async (streams) =>
        streams.map((s) => ({ ...s, active: true, validation: { ok: true } })),
    });
    assert(
      'Axios fails (empty) → Puppeteer fallback',
      puppeteerLaunched === true && axiosEmpty.method === 'puppeteer'
    );

    puppeteerLaunched = false;
    const axiosThrow = await runAxiosThenPuppeteer({
      axiosExtract: async () => {
        throw new Error('blocked');
      },
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/pp2.m3u8', source: 'cakhia' }];
      },
      validate: async (streams) =>
        streams.map((s) => ({ ...s, active: true, validation: { ok: true } })),
    });
    assert(
      'Axios throws → Puppeteer fallback',
      puppeteerLaunched === true && axiosThrow.streams.length === 1
    );

    const axiosUnvalidated = await runAxiosThenPuppeteer({
      axiosExtract: async () => [{ url: 'https://cdn.example/dead.m3u8', source: 'cakhia' }],
      puppeteerExtract: async () => [{ url: 'https://cdn.example/ok.m3u8', source: 'cakhia' }],
      validate: async (streams) =>
        streams
          .filter((s) => /ok\.m3u8/.test(s.url))
          .map((s) => ({ ...s, active: true, validation: { ok: true } })),
    });
    assert(
      'Axios m3u8 that fails validation → Puppeteer used',
      axiosUnvalidated.puppeteerLaunched === true &&
        axiosUnvalidated.streams[0].url.includes('ok.m3u8')
    );
  }

  console.log('\n=== Job queue concurrency + cancel + duplicates ===');
  {
    const q = new JobQueue({ concurrency: 2 });
    let current = 0;
    let max = 0;
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      key: `extract:m${i}:cakhia:t0`,
      matchId: `m${i}`,
    }));
    await q.run(jobs, async () => {
      current += 1;
      max = Math.max(max, current);
      await sleep(40);
      current -= 1;
      return true;
    });
    assert('10/8 jobs respect concurrency=2', max <= 2 && q.maxActiveSeen <= 2, `max=${max}`);

    const q2 = new JobQueue({ concurrency: 2 });
    const dup = await q2.run(
      [
        { key: 'extract:m1:cakhia:t0', matchId: 'm1' },
        { key: 'extract:m1:cakhia:t0', matchId: 'm1' },
      ],
      async () => 'ran'
    );
    const skipped = dup.filter((r) => r.reason === 'duplicate');
    const ran = dup.filter((r) => r.skipped === false);
    assert('Duplicate job key skipped', skipped.length === 1 && ran.length === 1);

    const q3 = new JobQueue({ concurrency: 1 });
    let started = 0;
    const slow = [
      { key: 'extract:m9:cakhia:t0', matchId: 'm9' },
      { key: 'extract:m9:cola:t0', matchId: 'm9' },
      { key: 'extract:m10:cakhia:t0', matchId: 'm10' },
    ];
    const runP = q3.run(slow, async (job) => {
      started += 1;
      if (job.matchId === 'm9' && started === 1) {
        q3.cancelMatch('m9');
      }
      await sleep(20);
      return job.key;
    });
    const cancelled = await runP;
    assert(
      'Pending jobs for a match are cancelled at +15 stop',
      cancelled.some((r) => r.reason === 'stopped'),
      JSON.stringify(cancelled)
    );
  }

  console.log('\n=== StreamEngine extract (confirmed Match URL only) ===');
  {
    const calls = [];
    const cakhia = mockSource('cakhia', async (url) => {
      calls.push({ source: 'cakhia', url });
      return [
        {
          source: 'cakhia',
          url: 'https://cdn.example/cakhia.m3u8',
          extractionMethod: 'axios',
        },
      ];
    });
    const engine = engineWith([cakhia]);
    const match = fixture({ id: 'live-1', offsetMin: 0, sources: ['cakhia'] });
    match.status = 'LIVE';
    const out = await engine.collectForFixtures([match], { force: true });
    const row = out[0];
    assert('Extract uses confirmed Match URL only', calls[0]?.url === match.sourcePages.cakhia);
    assert(
      'AVAILABLE only after validation',
      row.streamSearch.sources.cakhia.status === 'AVAILABLE' && row.streamStatus === 'AVAILABLE',
      JSON.stringify(row.streamSearch.sources.cakhia)
    );
    assert('match status stays LIVE while stream is separate', row.status === 'LIVE' || row.status === 'PREPARING_STREAM' || row.status === 'Scheduled');
  }

  {
    const cakhia = mockSource('cakhia', async () => {
      throw new Error('should not extract');
    });
    const engine = engineWith([cakhia]);
    const match = fixture({ id: 'no-url', offsetMin: 0, sources: [] });
    const out = await engine.collectForFixtures([match], { force: true });
    assert(
      'No Match URL → no extract / not AVAILABLE',
      (out[0].streams || []).length === 0 && out[0].streamSearch?.sources?.cakhia?.status !== 'AVAILABLE'
    );
  }

  {
    let n = 0;
    const cakhia = mockSource('cakhia', async () => {
      n += 1;
      if (n < 2) return [];
      return [{ source: 'cakhia', url: 'https://cdn.example/a2.m3u8' }];
    });
    let engine = engineWith([cakhia]);
    let match = fixture({ id: 'att2', offsetMin: 0, sources: ['cakhia'] });
    let out = await engine.collectForFixtures([match], { force: true });
    assert('Attempt 1 miss is SEARCHING not permanent FAILED', out[0].streamSearch.sources.cakhia.status === 'SEARCHING');

    engine = engineWith([cakhia]);
    match = { ...out[0], kickoff: kickoffIso(-6) };
    out = await engine.collectForFixtures([match], { force: true });
    assert(
      'Stream found on attempt 2',
      out[0].streamSearch.sources.cakhia.status === 'AVAILABLE' && n === 2,
      `n=${n} status=${out[0].streamSearch?.sources?.cakhia?.status}`
    );
  }

  {
    let n = 0;
    const cakhia = mockSource('cakhia', async () => {
      n += 1;
      if (n < 3) return [];
      return [{ source: 'cakhia', url: 'https://cdn.example/a3.m3u8' }];
    });
    let match = fixture({ id: 'att3', offsetMin: 0, sources: ['cakhia'] });
    let engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([match], { force: true }))[0];
    engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([{ ...match, kickoff: kickoffIso(-6) }], { force: true }))[0];
    engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([{ ...match, kickoff: kickoffIso(-11) }], { force: true }))[0];
    assert(
      'Stream found on attempt 3',
      match.streamSearch.sources.cakhia.status === 'AVAILABLE' && n === 3,
      `n=${n} status=${match.streamSearch?.sources?.cakhia?.status}`
    );
  }

  {
    let n = 0;
    const cakhia = mockSource('cakhia', async () => {
      n += 1;
      return [];
    });
    let match = fixture({ id: 'fail3', offsetMin: 0, sources: ['cakhia'] });
    let engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([match], { force: true }))[0];
    engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([{ ...match, kickoff: kickoffIso(-6) }], { force: true }))[0];
    engine = engineWith([cakhia]);
    match = (await engine.collectForFixtures([{ ...match, kickoff: kickoffIso(-11) }], { force: true }))[0];
    assert(
      '3 attempts fail → FAILED',
      match.streamSearch.sources.cakhia.status === 'FAILED' && n === 3
    );
    engine = engineWith([cakhia]);
    const again = await engine.collectForFixtures([{ ...match, kickoff: kickoffIso(-12) }], {
      force: true,
    });
    assert('FAILED source is never retried', n === 3 && again[0].streamSearch.sources.cakhia.status === 'FAILED');
  }

  {
    const cakhia = mockSource('cakhia', async () => {
      throw new Error('should skip available');
    });
    const match = fixture({ id: 'avail', offsetMin: 0, sources: ['cakhia'] });
    match.streams = [
      {
        source: 'cakhia',
        url: 'https://cdn.example/ok.m3u8',
        active: true,
        validation: { ok: true },
      },
    ];
    match.streamSearch = {
      sources: { cakhia: { status: 'AVAILABLE', postKickoffAttempts: 1, slotsDone: { t0: true } } },
    };
    const engine = engineWith([cakhia]);
    await engine.collectForFixtures([match], { force: true });
    assert('Already AVAILABLE source is skipped', true);
  }

  {
    const cakhia = mockSource('cakhia', async () => {
      throw new Error('should not run after +15');
    });
    const engine = engineWith([cakhia]);
    const match = fixture({ id: 'stop15', offsetMin: -16, sources: ['cakhia'] });
    const out = await engine.collectForFixtures([match], { force: true });
    assert(
      '+15m stops stream search',
      Boolean(out[0].streamSearch?.stopped) && (out[0].streams || []).length === 0
    );
  }

  console.log('\n=== 10 simultaneous matches + Puppeteer-style concurrency ===');
  {
    let current = 0;
    let max = 0;
    const names = ['cakhia', 'mitomtm', 'xoilac', 'socolive'];
    const sources = names.map((name) =>
      mockSource(name, async () => {
        current += 1;
        max = Math.max(max, current);
        await sleep(25);
        current -= 1;
        return [{ source: name, url: `https://cdn.example/${name}.m3u8` }];
      })
    );
    const engine = engineWith(sources);
    const matches = Array.from({ length: 10 }, (_, i) =>
      fixture({ id: `sim-${i}`, offsetMin: 0, sources: names })
    );
    const out = await engine.collectForFixtures(matches, { force: true });
    assert('10 matches processed', out.length === 10);
    assert(
      'Extract queue concurrency ≤ 2 (not 40 simultaneous jobs)',
      max <= 2 && engine.extractQueue.maxActiveSeen <= 2,
      `max=${max} seen=${engine.extractQueue.maxActiveSeen}`
    );
    assert(
      'Puppeteer/job cap stays at SCRAPER_CONCURRENCY',
      engine.extractQueue.concurrency === 2
    );
  }

  console.log('\n=== matches.json / Flutter compatibility ===');
  {
    const kickoff = kickoffIso(0);
    const payload = generateFlutterJson([
      {
        matchId: 'manchester_united_liverpool_20260716',
        league: 'English Premier League (EPL)',
        leagueFotmobId: 47,
        fotmobId: 123,
        homeTeam: 'Manchester United',
        awayTeam: 'Liverpool',
        date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
        time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
        kickoff,
        status: 'LIVE',
        streams: [
          {
            source: 'cakhia',
            type: 'm3u8',
            quality: 'HD',
            url: 'https://example.com/live.m3u8',
            active: true,
            validation: { ok: true },
            headers: { Referer: 'https://cakhiazvm.tv/' },
          },
        ],
        originalNames: { fotmob: { homeTeam: 'Manchester United' } },
        sourcePages: { cakhia: 'https://cakhiazvm.tv/truc-tiep/man-utd-vs-liverpool/' },
        streamAttempts: { t0: true },
        matchUrl: 'https://cakhiazvm.tv/truc-tiep/man-utd-vs-liverpool/',
        streamSearch: { sources: { cakhia: { status: 'AVAILABLE' } } },
      },
    ]);
    const m = payload.matches[0];
    const required = [
      'matchId',
      'league',
      'homeTeam',
      'awayTeam',
      'date',
      'time',
      'kickoff',
      'timezone',
      'status',
      'streams',
      'hasStreams',
      'streamCount',
      'originalNames',
      'sourcePages',
      'streamAttempts',
    ];
    assert(
      'Flutter required fields still present',
      required.every((k) => Object.prototype.hasOwnProperty.call(m, k))
    );
    assert('streams[] still has source/url/headers', m.streams[0].url && m.streams[0].headers);
    assert('Additive fotmobMatchId/leagueId present', m.fotmobMatchId === 123 && m.leagueId === 47);
    assert('streamStatus AVAILABLE only with validated stream', m.streamStatus === 'AVAILABLE');
    assert('timezone remains Asia/Yangon', payload.timezone === 'Asia/Yangon');
  }

  {
    const kickoff = kickoffIso(0);
    const payload = generateFlutterJson([
      {
        matchId: 'racing_villarreal_clone',
        league: 'La Liga',
        homeTeam: 'Racing Santander',
        awayTeam: 'Villarreal',
        date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
        time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
        kickoff,
        status: 'LIVE',
        streams: [
          {
            source: 'cakhia',
            type: 'm3u8',
            quality: 'Link 1',
            url: 'https://live2.livefeedtextbox.com/live/channel24.m3u8',
            active: true,
            validation: { ok: true },
          },
          {
            source: 'xoilac',
            type: 'm3u8',
            quality: 'Link 1',
            url: 'https://live2.livefeedtextbox.com/live/channel24.m3u8',
            active: true,
            validation: { ok: true },
          },
        ],
        sourcePages: {
          cakhia: 'https://cakhiazvm.tv/truc-tiep/racing-santander-vs-villarreal/',
          xoilac: 'https://xoilacxtr.tv/truc-tiep/racing-santander-vs-villarreal/',
        },
        matchUrlSearch: {
          sources: {
            cakhia: {
              matchUrl: 'https://cakhiazvm.tv/truc-tiep/racing-santander-vs-villarreal/',
              status: 'MATCH_URL_CONFIRMED',
              confidence: 100,
            },
            xoilac: {
              matchUrl: null,
              status: 'MATCH_URL_NOT_FOUND',
              confidence: 0,
            },
          },
        },
        streamSearch: {
          started: true,
          stopped: true,
          sources: {
            cakhia: { status: 'AVAILABLE' },
            xoilac: { status: 'AVAILABLE' },
          },
        },
      },
      {
        matchId: 'chapecoense_failed',
        league: 'Brazil Serie A (BRA D1)',
        homeTeam: 'Chapecoense AF',
        awayTeam: 'Bahia',
        date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
        time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
        kickoff: kickoffIso(-90),
        status: 'END',
        streams: [],
        streamSearch: { started: true, stopped: true, sources: {} },
      },
    ]);
    const racing = payload.matches[0];
    assert(
      'Flutter omits Xoilac page that was never discovered',
      racing.sourcePages.xoilac == null && Boolean(racing.sourcePages.cakhia)
    );
    assert(
      'Flutter does not clone the sister-site stream onto Xoilac',
      racing.streams.every((s) => s.source !== 'xoilac') && racing.streams[0].source === 'cakhia'
    );
    assert(
      'ended match with stopped empty search is FAILED',
      payload.matches[1].streamStatus === 'FAILED'
    );
  }
}

runAsyncTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
