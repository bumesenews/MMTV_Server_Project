/**
 * Config + matches.json state tests (PART 4).
 * Run: node scripts/testConfigState.js
 */
const { DateTime } = require('luxon');
const {
  loadScraperConfig,
  STREAM_SEARCH_SLOTS,
  MATCH_URL_SEARCH_SLOTS,
  STREAM_MAX_ATTEMPTS,
  STREAM_SEARCH_STOP_AFTER_MIN,
  MATCH_URL_MAX_ATTEMPTS,
  SCRAPER_CONCURRENCY,
} = require('../src/utils/scraperConfig');
const {
  resolveMatchUrlSearchSlot,
  resolveStreamSearchSlot,
  isStreamSearchStopped,
  getCheckIntervalMinutes,
  toUtcUnixSeconds,
} = require('../src/utils/time');
const {
  extractJobKey,
  decideSourceExtract,
  nextSourceStateAfterAttempt,
  aggregateStreamStatus,
  aggregateValidationFields,
  STREAM_SOURCE_STATUS,
  MAX_POST_KICKOFF_ATTEMPTS,
} = require('../src/utils/streamExtractPolicy');
const { MATCH_URL_STATUS } = require('../src/utils/streamUrlHelper');
const {
  applySourceDiscoveryResult,
  needsMatchUrlDiscovery,
  finalizeMatchUrlStatus,
  matchUrlJobKey,
  aggregateMatchUrlFields,
  getSourceMatchUrlState,
  sourceHasSavedMatchUrl,
} = require('../src/utils/matchUrlDiscovery');
const { JobQueue, scraperConcurrency } = require('../src/utils/jobQueue');
const { StreamEngine } = require('../src/services/streamEngine');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const { enrichMatchState } = require('../src/services/statusService');
const { hasDataChanged } = require('../src/utils/compare');
const { TelegramService } = require('../src/services/telegram.service');
const { runAxiosThenPuppeteer } = require('../src/sources/httpStreamExtractor');

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

function kickoffIso(offsetMin) {
  return DateTime.now().setZone(ZONE).plus({ minutes: offsetMin }).toISO();
}

function slotAt(kickoffIsoStr, minutesUntil) {
  const kickSec = toUtcUnixSeconds(kickoffIsoStr);
  const nowSec = kickSec - minutesUntil * 60;
  return {
    matchUrl: resolveMatchUrlSearchSlot(kickoffIsoStr, nowSec),
    stream: resolveStreamSearchSlot(kickoffIsoStr, nowSec),
    stopped: isStreamSearchStopped(kickoffIsoStr, {}, nowSec),
  };
}

class FakeValidator {
  async validateMany(streams) {
    return (streams || []).map((s) => {
      const ok = Boolean(s?.url) && s._valid !== false;
      return {
        ...s,
        active: ok,
        validation: {
          ok,
          state: ok ? 'AVAILABLE' : 'HTTP_403',
          reason: ok ? 'ok' : 'HTTP_403',
        },
      };
    });
  }
  async fastHealthCheckMany(streams) {
    return this.validateMany(streams);
  }
  dedupeAndRank(streams) {
    return streams || [];
  }
}

function mockSource(name, extractFn) {
  return {
    name,
    config: { enabled: true, priority: 100, playbackHeaders: { Referer: 'https://soco.textliveupdaterz.com/' } },
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

function confirmedFixture({ id = 'm1', offsetMin = 0, sources = ['socolive'] } = {}) {
  const kickoff = kickoffIso(offsetMin);
  const matchUrlSearch = { slotsDone: { t30: true }, sources: {} };
  const sourcePages = {};
  for (const name of sources) {
    const url = `https://example.com/${name}/${id}`;
    matchUrlSearch.sources[name] = {
      matchUrl: url,
      status: MATCH_URL_STATUS.CONFIRMED,
      attempts: 1,
      slotsDone: { t30: true },
      confidence: 100,
    };
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

async function run() {
  console.log('\n=== Env configuration ===');
  {
    const cfg = loadScraperConfig({
      STREAM_SEARCH_INTERVAL_MINUTES: '5',
      STREAM_MAX_ATTEMPTS: '3',
      STREAM_POST_KICKOFF_MAX_MINUTES: '15',
      SCRAPER_CONCURRENCY: '2',
      MATCH_URL_PRE_KICKOFF_MINUTES: '60,45,30',
      MATCH_URL_EARLY_DISCOVERY: 'false',
    });
    assert('STREAM_SEARCH_INTERVAL_MINUTES=5', cfg.streamSearchIntervalMinutes === 5);
    assert('STREAM_MAX_ATTEMPTS=3', cfg.streamMaxAttempts === 3);
    assert('STREAM_POST_KICKOFF_MAX_MINUTES=15', cfg.streamPostKickoffMaxMinutes === 15);
    assert('SCRAPER_CONCURRENCY=2', cfg.scraperConcurrency === 2);
    assert('1GB default player tabs = TOM+HDTOM (2)', cfg.httpStreamMaxEmbeds === 2);
    assert(
      'HTTP_STREAM_MAX_EMBEDS=4 keeps all tabs',
      loadScraperConfig({ HTTP_STREAM_MAX_EMBEDS: '4' }).httpStreamMaxEmbeds === 4
    );
    assert(
      'LOW_MEMORY_MODE=false allows 6 player tabs',
      loadScraperConfig({ LOW_MEMORY_MODE: 'false' }).httpStreamMaxEmbeds === 6
    );
    assert(
      'MATCH_URL_PRE_KICKOFF_MINUTES=60,45,30',
      cfg.matchUrlPreKickoffMinutes.join(',') === '60,45,30'
    );
    assert('stream offsets are 0,5,10', cfg.streamAttemptOffsets.join(',') === '0,5,10');
    assert('defaults match exported constants', STREAM_MAX_ATTEMPTS === 3 && STREAM_SEARCH_STOP_AFTER_MIN === 15);
    assert('scraperConcurrency() reads env/config', scraperConcurrency() >= 1);
    assert('MAX_STREAM_RETRIES is not reused as STREAM_MAX_ATTEMPTS', STREAM_MAX_ATTEMPTS !== 1);

    const custom = loadScraperConfig({ MATCH_URL_PRE_KICKOFF_MINUTES: '20,10' });
    assert('custom Match URL schedule is env-driven', custom.matchUrlPreKickoffMinutes.join(',') === '20,10');
  }

  console.log('\n=== Match URL discovery schedule (20:00 kickoff) ===');
  {
    const kickoff = DateTime.fromObject(
      { year: 2026, month: 8, day: 15, hour: 20, minute: 0 },
      { zone: ZONE }
    ).toISO();
    const at1900 = slotAt(kickoff, 60);
    const at1915 = slotAt(kickoff, 45);
    const at1930 = slotAt(kickoff, 30);
    const at1945 = slotAt(kickoff, 15);
    const at2000 = slotAt(kickoff, 0);
    assert('19:00 → Match URL attempt 1 (t60)', at1900.matchUrl?.id === 't60' && at1900.matchUrl.attempt === 1);
    assert('19:15 → Match URL attempt 2 (t45)', at1915.matchUrl?.id === 't45' && at1915.matchUrl.attempt === 2);
    assert('19:30 → Match URL attempt 3 (t30)', at1930.matchUrl?.id === 't30');
    assert('19:45 → still t30 Match URL window (no extra attempt)', at1945.matchUrl?.id === 't30');
    assert('20:00 → no Match URL discovery', at2000.matchUrl == null);
    assert('max Match URL attempts is 3', MATCH_URL_MAX_ATTEMPTS === 3);
    assert('Match URL slots are only pre-kickoff', MATCH_URL_SEARCH_SLOTS.every((s) => s.maxInclusive > 0));
  }

  console.log('\n=== Stream search schedule (20:00 kickoff) ===');
  {
    const kickoff = DateTime.fromObject(
      { year: 2026, month: 8, day: 15, hour: 20, minute: 0 },
      { zone: ZONE }
    ).toISO();
    assert('11:00 → no Match URL slot yet, no stream extract', slotAt(kickoff, 9 * 60).matchUrl == null && slotAt(kickoff, 9 * 60).stream == null);
    assert('19:00 → Match URL t60, no stream extract yet', slotAt(kickoff, 60).matchUrl?.id === 't60' && slotAt(kickoff, 60).stream == null);
    assert('19:15 → Match URL t45, no stream extract yet', slotAt(kickoff, 45).matchUrl?.id === 't45' && slotAt(kickoff, 45).stream == null);
    assert('19:30 → stream extract from Match URL (t30)', slotAt(kickoff, 30).stream?.id === 't30');
    assert('19:45 → stream extract t15', slotAt(kickoff, 15).stream?.id === 't15');
    assert('20:00 → stream attempt at kickoff', slotAt(kickoff, 0).stream?.id === 't0');
    assert('20:05 → stream attempt +5', slotAt(kickoff, -5).stream?.id === 'tP5');
    assert('20:10 → stream attempt +10', slotAt(kickoff, -10).stream?.id === 'tP10');
    assert('20:15 → STOP', slotAt(kickoff, -15).stopped === true && slotAt(kickoff, -15).stream == null);
    assert(
      'stream slots include pre-kickoff extract',
      STREAM_SEARCH_SLOTS.some((s) => s.id === 't30' && s.postKickoff === false) &&
        STREAM_SEARCH_SLOTS.some((s) => s.id === 't0' && s.postKickoff === true)
    );
    assert(
      'poll interval inside window uses STREAM_SEARCH_INTERVAL_MINUTES',
      getCheckIntervalMinutes(kickoff, 'LIVE', toUtcUnixSeconds(kickoff)) === 5
    );
  }

  console.log('\n=== Job key + duplicate prevention ===');
  {
    const k1 = extractJobKey('match123', 'soco', 1);
    const k2 = extractJobKey('match123', 'soco', 2);
    const k1b = extractJobKey('match123', 'soco', { attempt: 1, id: 't0' });
    assert('attempt1 key shape', k1 === 'match123:soco:stream:attempt1');
    assert('attempt1 and attempt2 are different jobs', k1 !== k2);
    assert('same attempt from slot object matches', k1 === k1b);
    const q = new JobQueue({ concurrency: 2 });
    const seen = [];
    await q.run(
      [
        { key: k1, matchId: 'match123' },
        { key: k1, matchId: 'match123' },
        { key: k2, matchId: 'match123' },
      ],
      async (job) => {
        seen.push(job.key);
        return true;
      }
    );
    assert('same attempt never runs twice', seen.filter((k) => k === k1).length === 1);
    assert('attempt2 still runs', seen.includes(k2));
    const mk = matchUrlJobKey('match123', 'soco', { attempt: 1 });
    assert('match-url job key shape', mk === 'match123:soco:match-url:attempt1');
    assert('match-url and stream jobs are separate', mk !== k1);
  }

  console.log('\n=== 1 match / successful stream / status separation ===');
  {
    const engine = engineWith([
      mockSource('socolive', async () => [
        {
          source: 'socolive',
          url: 'https://live2.streambylivepulse.com/live/channel1.m3u8',
          headers: {
            Referer: 'https://soco.textliveupdaterz.com/',
            'User-Agent': 'Mozilla/5.0',
          },
        },
      ]),
    ]);
    const results = await engine.collectForFixtures([confirmedFixture({ id: 'one', offsetMin: 0 })]);
    const m = results[0];
    assert('1 match processed', results.length === 1);
    assert('match status LIVE (not streamStatus)', m.status === 'LIVE');
    assert('streamStatus AVAILABLE only after validation', m.streamStatus === 'AVAILABLE');
    assert('matchUrlStatus remains MATCH_CONFIRMED', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED);
    assert('validationStatus AVAILABLE', m.validationStatus === 'AVAILABLE');
    assert('streamHeaders saved', m.streamHeaders?.Referer === 'https://soco.textliveupdaterz.com/');
    assert('fotmob id preserved on match', m.fotmobId === 99 && m.leagueFotmobId === 47);
  }

  console.log('\n=== Failed stream / retry 2 / retry 3 / FAILED ===');
  {
    let n = 0;
    const engine = engineWith([
      mockSource('socolive', async () => {
        n += 1;
        if (n < 2) return [{ url: 'https://cdn.example/bad.m3u8', source: 'socolive', _valid: false }];
        return [{ url: 'https://cdn.example/ok.m3u8', source: 'socolive' }];
      }),
    ]);
    const f = confirmedFixture({ id: 'retry2', offsetMin: 0 });
    await engine.collectForFixtures([f]);
    const after1 = engine.lastCheckByMatch.has('retry2');
    assert('attempt 1 recorded', after1);

    const miss1 = nextSourceStateAfterAttempt({
      previous: { attempts: 0, postKickoffAttempts: 0 },
      slot: { id: 't0', postKickoff: true, attempt: 1 },
      validatedStreams: [],
      error: 'HTTP_403',
    });
    assert('failed attempt stays SEARCHING', miss1.status === STREAM_SOURCE_STATUS.SEARCHING);
    const found2 = nextSourceStateAfterAttempt({
      previous: miss1,
      slot: { id: 'tP5', postKickoff: true, attempt: 2 },
      validatedStreams: [{ url: 'https://cdn.example/ok.m3u8', validation: { ok: true } }],
    });
    assert('stream found on retry 2 → AVAILABLE', found2.status === STREAM_SOURCE_STATUS.AVAILABLE);

    const miss2 = nextSourceStateAfterAttempt({
      previous: miss1,
      slot: { id: 'tP5', postKickoff: true },
      validatedStreams: [],
    });
    const found3 = nextSourceStateAfterAttempt({
      previous: miss2,
      slot: { id: 'tP10', postKickoff: true, attempt: 3 },
      validatedStreams: [{ url: 'https://cdn.example/ok.m3u8', validation: { ok: true } }],
    });
    assert('stream found on retry 3 → AVAILABLE', found3.status === STREAM_SOURCE_STATUS.AVAILABLE);

    const fail3 = nextSourceStateAfterAttempt({
      previous: miss2,
      slot: { id: 'tP10', postKickoff: true },
      validatedStreams: [],
    });
    assert('3 failed attempts → FAILED', fail3.status === STREAM_SOURCE_STATUS.FAILED && fail3.postKickoffAttempts === MAX_POST_KICKOFF_ATTEMPTS);

    const skipFailed = decideSourceExtract({
      sourceName: 'socolive',
      streamSearch: { sources: { socolive: fail3 } },
      matchUrlState: { matchUrl: 'https://x', status: MATCH_URL_STATUS.CONFIRMED },
      slot: { id: 'tP10', postKickoff: true },
    });
    assert('FAILED source skipped permanently', skipFailed.skip === true);

    const skipAvail = decideSourceExtract({
      sourceName: 'socolive',
      streamSearch: { sources: { socolive: found2 } },
      matchUrlState: { matchUrl: 'https://x', status: MATCH_URL_STATUS.CONFIRMED },
      slot: { id: 'tP10', postKickoff: true },
    });
    assert('AVAILABLE source skipped on future attempts', skipAvail.skip === true);
  }

  console.log('\n=== +15m cancellation ===');
  {
    const q = new JobQueue({ concurrency: 1 });
    let started = 0;
    const results = await q.run(
      [
        { key: 'm15:soco:stream:attempt1', matchId: 'm15' },
        { key: 'm15:soco:stream:attempt2', matchId: 'm15' },
        { key: 'm15:cola:stream:attempt1', matchId: 'm15' },
        { key: 'other:soco:stream:attempt1', matchId: 'other' },
      ],
      async (job) => {
        started += 1;
        if (job.matchId === 'm15') q.cancelMatch('m15');
        await new Promise((r) => setTimeout(r, 20));
        return job.key;
      }
    );
    const stopped = results.filter((r) => r.reason === 'stopped');
    assert('+15 cancel removes pending jobs for that match', stopped.length >= 1);
    const kickoff = kickoffIso(-16);
    assert('+15 stop window active', isStreamSearchStopped(kickoff, {}));
    const engine = engineWith([
      mockSource('socolive', async () => {
        throw new Error('should not extract after stop');
      }),
    ]);
    const stoppedMatch = await engine.collectForFixtures([
      {
        ...confirmedFixture({ id: 'late', offsetMin: -16 }),
        streamSearch: {
          started: true,
          stopped: true,
          slotsDone: { t30: true },
          sources: {},
        },
      },
    ]);
    assert('+15 does not start a new stream search', stoppedMatch[0].streams.length === 0);

    let catchupCalls = 0;
    const catchupEngine = engineWith([
      mockSource('socolive', async () => {
        catchupCalls += 1;
        return [
          {
            source: 'socolive',
            url: 'https://cdn.example/catchup.m3u8',
            type: 'm3u8',
            _valid: true,
          },
        ];
      }),
    ]);
    const catchupMatch = await catchupEngine.collectForFixtures([
      {
        ...confirmedFixture({ id: 'espanyol', offsetMin: -16 }),
        streamSearch: { started: false, stopped: false, slotsDone: {}, sources: {} },
      },
    ]);
    assert(
      'never-started search still catch-up extracts after +15',
      catchupCalls >= 1 && (catchupMatch[0].streams || []).length >= 1
    );
  }

  console.log('\n=== No stream after +15m → not LIVE in Flutter ===');
  {
    const kickoff = kickoffIso(-16);
    const nowSec = toUtcUnixSeconds(kickoffIso(0));
    const ended = enrichMatchState(
      {
        matchId: 'no-stream',
        kickoff,
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        streams: [],
        status: 'LIVE',
        streamSearch: { started: true, stopped: true, slotsDone: { t30: true } },
      },
      { nowSec }
    );
    assert('no stream URL after +15m → END', ended.status === 'END');

    const missedWindow = enrichMatchState(
      {
        matchId: 'espanyol_levante_20260816',
        kickoff,
        homeTeam: 'Espanyol',
        awayTeam: 'Levante',
        streams: [],
        status: 'Scheduled',
        streamSearch: { started: false, stopped: false, slotsDone: {}, sources: {} },
      },
      { nowSec }
    );
    assert(
      'never-searched match after +15m stays LIVE for catch-up',
      missedWindow.status === 'LIVE'
    );

    const stillLive = enrichMatchState(
      {
        matchId: 'has-stream',
        kickoff,
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        streams: [{ source: 'socolive', url: 'https://cdn.example/live.m3u8', active: true }],
        status: 'LIVE',
      },
      { nowSec }
    );
    assert('stream URL after +15m stays LIVE', stillLive.status === 'LIVE');

    const searching = enrichMatchState(
      {
        matchId: 'searching',
        kickoff: kickoffIso(-10),
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        streams: [],
        status: 'LIVE',
      },
      { nowSec }
    );
    assert('inside 15m search window without stream stays LIVE', searching.status === 'LIVE');

    const locked = enrichMatchState(
      {
        matchId: 'locked',
        kickoff,
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        streams: [],
        status: 'LIVE',
        statusLocked: true,
      },
      { nowSec }
    );
    assert('admin-locked LIVE is preserved', locked.status === 'LIVE');
  }

  console.log('\n=== Match URL found at -60 / -45 / -30 / never ===');
  {
    const base = {
      matchId: 'url1',
      kickoff: kickoffIso(60),
      homeTeam: 'Inter',
      awayTeam: 'Juventus',
      sourcePages: {},
    };
    let m = applySourceDiscoveryResult(
      { ...base },
      'socolive',
      { matchUrl: 'https://socolivepp.tv/a', accepted: true, status: MATCH_URL_STATUS.CONFIRMED, confidence: 100 },
      { id: 't60', attempt: 1 },
      't1'
    );
    assert('Match URL found at −60m', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrl);
    assert(
      'stops discovery after URL saved',
      needsMatchUrlDiscovery(m, 'socolive', toUtcUnixSeconds(kickoffIso(45))) === false
    );

    m = applySourceDiscoveryResult({ ...base }, 'socolive', null, { id: 't60', attempt: 1 }, 't1');
    m = applySourceDiscoveryResult(m, 'socolive', {
      matchUrl: 'https://socolivepp.tv/b',
      accepted: true,
      status: MATCH_URL_STATUS.CONFIRMED,
      confidence: 90,
    }, { id: 't45', attempt: 2 }, 't2');
    assert('Match URL found at −45m', m.matchUrlAttempts === 2 && Boolean(m.matchUrl));

    m = applySourceDiscoveryResult({ ...base }, 'socolive', null, { id: 't60', attempt: 1 }, 't1');
    m = applySourceDiscoveryResult(m, 'socolive', null, { id: 't45', attempt: 2 }, 't2');
    m = applySourceDiscoveryResult(m, 'socolive', {
      matchUrl: 'https://socolivepp.tv/c',
      accepted: true,
      status: MATCH_URL_STATUS.CONFIRMED,
      confidence: 80,
    }, { id: 't30', attempt: 3 }, 't3');
    assert('Match URL found at −30m', m.matchUrlAttempts === 3 && Boolean(m.matchUrl));

    m = applySourceDiscoveryResult({ ...base }, 'socolive', null, { id: 't60', attempt: 1 }, 't1');
    m = applySourceDiscoveryResult(m, 'socolive', null, { id: 't45', attempt: 2 }, 't2');
    m = applySourceDiscoveryResult(m, 'socolive', null, { id: 't30', attempt: 3 }, 't3');
    m = finalizeMatchUrlStatus(m, toUtcUnixSeconds(kickoffIso(0)));
    assert(
      'Match URL never found before kickoff stays SEARCHING for catch-up',
      m.matchUrlStatus === MATCH_URL_STATUS.SEARCHING
    );
    m = finalizeMatchUrlStatus(m, toUtcUnixSeconds(m.kickoff) + 121 * 60);
    assert('Match URL never found after live window → MATCH_URL_FAILED', m.matchUrlStatus === MATCH_URL_STATUS.FAILED);
  }

  console.log('\n=== sourcePages follow discovery only ===');
  {
    const leaked = aggregateMatchUrlFields({
      matchId: 'leaked_xoilac',
      kickoff: kickoffIso(90),
      homeTeam: 'Racing Santander',
      awayTeam: 'Villarreal',
      sourcePages: {
        cakhia: 'https://cakhiazvm.tv/truc-tiep/racing-santander-vs-villarreal/',
        xoilac: 'https://xoilacxtr.tv/truc-tiep/racing-santander-vs-villarreal/',
      },
      matchUrlSearch: {
        sources: {
          cakhia: {
            matchUrl: 'https://cakhiazvm.tv/truc-tiep/racing-santander-vs-villarreal/',
            status: MATCH_URL_STATUS.CONFIRMED,
            attempts: 0,
            confidence: 100,
          },
          xoilac: {
            matchUrl: null,
            status: MATCH_URL_STATUS.NOT_FOUND,
            attempts: 0,
            confidence: 0,
          },
        },
      },
    });
    assert(
      'sister-site slug is not kept as an Xoilac Match URL',
      leaked.sourcePages.xoilac == null && leaked.sourcePages.cakhia != null
    );
    const xoilacState = getSourceMatchUrlState(leaked, 'xoilac');
    assert(
      'leaked Xoilac page is not treated as discovered',
      xoilacState.matchUrl == null && sourceHasSavedMatchUrl(xoilacState) === false
    );
    const extract = decideSourceExtract({
      sourceName: 'xoilac',
      streamSearch: { sources: {} },
      matchUrlState: xoilacState,
      slot: { id: 't30', postKickoff: false },
    });
    assert('do not extract Xoilac from a cloned slug', extract.reason === 'no_confirmed_match_url');
  }

  console.log('\n=== 10 matches × 4 sources + concurrency ===');
  {
    const names = ['cakhia', 'mitomtm', 'xoilac', 'socolive'];
    const sources = names.map((name) =>
      mockSource(name, async () => [{ source: name, url: `https://cdn.example/${name}.m3u8` }])
    );
    const engine = engineWith(sources);
    assert('extract queue concurrency is 2', engine.extractQueue.concurrency === 2);
    const fixtures = [];
    for (let i = 0; i < 10; i += 1) {
      fixtures.push(confirmedFixture({ id: `m${i}`, offsetMin: 0, sources: names }));
    }
    const results = await engine.collectForFixtures(fixtures);
    assert('10 matches processed', results.length === 10);
    assert(
      'queue never exceeded SCRAPER_CONCURRENCY',
      engine.extractQueue.maxActiveSeen <= SCRAPER_CONCURRENCY
    );
    assert(
      'successful streams validated',
      results.every((m) => m.streamStatus === 'AVAILABLE')
    );
    const { PuppeteerTaskQueue } = require('../src/browser/puppeteerManager');
    const pq = new PuppeteerTaskQueue(1);
    let max = 0;
    let current = 0;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        pq.run(async () => {
          current += 1;
          max = Math.max(max, current);
          await new Promise((r) => setTimeout(r, 15));
          current -= 1;
        })
      )
    );
    assert('20. Puppeteer task queue concurrency remains 1', max === 1 && pq.maxActiveSeen === 1);
  }

  console.log('\n=== Referer/UA + Axios→Puppeteer + browser cleanup ===');
  {
    let puppeteerLaunched = false;
    let closed = 0;
    const axiosFail = await runAxiosThenPuppeteer({
      axiosExtract: async () => [],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        try {
          return [
            {
              source: 'socolive',
              url: 'https://live2.streambylivepulse.com/live/channel1.m3u8',
              headers: {
                Referer: 'https://soco.textliveupdaterz.com/',
                'User-Agent': 'Mozilla/5.0',
              },
            },
          ];
        } finally {
          closed += 1;
        }
      },
      validate: async (streams) =>
        streams.map((s) => ({ ...s, active: true, validation: { ok: true, state: 'AVAILABLE' } })),
    });
    assert('Axios failure → Puppeteer fallback', puppeteerLaunched && axiosFail.method === 'puppeteer');
    assert('browser/page cleanup after attempt', closed === 1);
    assert(
      'required Referer present on extracted stream',
      axiosFail.streams[0].headers.Referer === 'https://soco.textliveupdaterz.com/'
    );

    puppeteerLaunched = false;
    const axiosOk = await runAxiosThenPuppeteer({
      axiosExtract: async () => [
        {
          url: 'https://cdn.example/ok.m3u8',
          source: 'socolive',
          headers: { Referer: 'https://soco.textliveupdaterz.com/' },
        },
      ],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [];
      },
      validate: async (streams) =>
        streams.map((s) => ({ ...s, active: true, validation: { ok: true } })),
    });
    assert('Axios success does not launch a second Puppeteer process', puppeteerLaunched === false && axiosOk.method === 'axios');
  }

  console.log('\n=== matches.json / GitHub / Telegram compatibility ===');
  {
    const kickoff = kickoffIso(0);
    const payload = generateFlutterJson([
      {
        matchId: 'inter_juventus_20260815',
        league: 'Serie A',
        fotmobId: 55,
        leagueFotmobId: 13,
        homeTeam: 'Inter',
        awayTeam: 'Juventus',
        date: DateTime.fromISO(kickoff, { setZone: true }).toFormat('yyyy-MM-dd'),
        time: DateTime.fromISO(kickoff, { setZone: true }).toFormat('HH:mm'),
        kickoff,
        status: 'LIVE',
        streams: [
          {
            source: 'socolive',
            url: 'https://live2.streambylivepulse.com/live/channel1.m3u8',
            active: true,
            validation: { ok: true, state: 'AVAILABLE' },
            headers: {
              Referer: 'https://soco.textliveupdaterz.com/',
              'User-Agent': 'Mozilla/5.0',
            },
          },
        ],
        originalNames: {},
        sourcePages: { socolive: 'https://socolivepp.tv/x' },
        matchUrl: 'https://socolivepp.tv/x',
        matchUrlStatus: MATCH_URL_STATUS.CONFIRMED,
        streamStatus: 'AVAILABLE',
        streamSearch: { sources: { socolive: { status: 'AVAILABLE', postKickoffAttempts: 1 } } },
      },
    ]);
    const m = payload.matches[0];
    const required = [
      'matchId', 'league', 'homeTeam', 'awayTeam', 'date', 'time', 'kickoff',
      'timezone', 'status', 'streams', 'fotmobMatchId', 'leagueId', 'leagueName',
      'matchUrl', 'matchUrlStatus', 'streamUrl', 'streamHeaders',
      'streamStatus', 'validationStatus', 'attempts',
    ];
    assert(
      'Flutter required + additive state fields present',
      required.every((k) => Object.prototype.hasOwnProperty.call(m, k))
    );
    assert('status remains matchStatus (LIVE)', m.status === 'LIVE' && m.streamStatus === 'AVAILABLE');
    assert('no duplicate matchStatus field', !Object.prototype.hasOwnProperty.call(m, 'matchStatus'));
    assert('streams[].headers still present', Boolean(m.streams[0].headers.Referer));

    const searching = aggregateValidationFields(
      { streams: [], streamSearch: { sources: { socolive: { status: 'SEARCHING', lastError: null } } } },
      'SEARCHING'
    );
    assert('SEARCHING uses validationStatus VALIDATING', searching.validationStatus === 'VALIDATING');
    const denied = aggregateValidationFields(
      { streams: [], streamSearch: { sources: { socolive: { status: 'SEARCHING', lastError: 'HTTP_403' } } } },
      'SEARCHING'
    );
    assert('HTTP_403 is a validation reason, not streamStatus', denied.validationStatus === 'HTTP_403' && denied.validationReason === 'HTTP_403');

    const same = { matches: payload.matches, timezone: 'Asia/Yangon' };
    const copy = JSON.parse(JSON.stringify(same));
    copy.generatedAt = new Date().toISOString();
    copy.matches[0].updatedAt = new Date().toISOString();
    assert('GitHub compare ignores volatile timestamps', hasDataChanged(same, copy) === false);
    copy.matches[0].streamStatus = 'FAILED';
    assert('GitHub uploads when generated JSON actually changes', hasDataChanged(same, copy) === true);

    const tg = new TelegramService({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
    const first = await tg.sendAlert('scraper_failed:soco', 'test');
    const second = await tg.sendAlert('scraper_failed:soco', 'test');
    assert('Telegram stays disabled when unconfigured', first.reason === 'not_configured');
    assert('unconfigured alerts do not send duplicates', second.reason === 'not_configured');
  }

  console.log('\n=== FotMob league icons ===');
  {
    const {
      resolveLeagueIcon,
      resolveLeagueLogoId,
    } = require('../src/utils/fotmobLogos');
    assert(
      'Club Friendlies uses page id 489 not feed id 915708',
      resolveLeagueLogoId({ league: 'Club Friendlies', leagueId: 915708 }) === 489
    );
    assert(
      'Basel fixture gets Club Friendlies logo URL',
      resolveLeagueIcon({
        league: 'Club Friendlies',
        leagueId: 915708,
        leagueIcon: null,
      }) === 'https://images.fotmob.com/image_resources/logo/leaguelogo/489.png'
    );
    const payload = generateFlutterJson([
      {
        matchId: 'basel_barcelona_20260816',
        league: 'Club Friendlies',
        leagueIcon: null,
        homeTeam: 'Basel',
        awayTeam: 'Barcelona',
        kickoff: DateTime.now().setZone(ZONE).plus({ hours: 1 }).toISO(),
        timezone: ZONE,
        status: 'Scheduled',
        leagueId: 915708,
        streams: [],
        originalNames: {},
        sourcePages: {},
      },
    ]);
    assert(
      'Flutter leagueIcon is filled for Club Friendlies',
      payload.matches[0].leagueIcon ===
        'https://images.fotmob.com/image_resources/logo/leaguelogo/489.png'
    );
  }

  console.log('\n=== Expire kickoff+2h (Basel 21:00 Yangon) ===');
  {
    const {
      isMatchExpired,
      filterExpiredMatches,
      syncMatchesForDelivery,
    } = require('../src/services/matchesSyncService');
    const kickoff = '2026-08-16T21:00:00.000+06:30';
    const match = {
      matchId: 'basel_barcelona_20260816',
      kickoff,
      status: 'LIVE',
      streams: [{ url: 'https://example.com/live.m3u8', source: 'socolive' }],
    };
    const kickSec = toUtcUnixSeconds(kickoff);
    assert('9:00 PM Yangon kickoff parses', kickSec != null);
    assert(
      'still kept at kickoff+2h exactly',
      isMatchExpired(match, kickSec + 7200) === false
    );
    assert(
      'removed after kickoff+2h+1s',
      isMatchExpired(match, kickSec + 7201) === true
    );
    assert(
      '11:38 AM Yangon (before 9:00 PM) does not expire',
      isMatchExpired(match, toUtcUnixSeconds('2026-08-16T11:38:00.000+06:30')) === false
    );
    const { matches: kept, removed } = filterExpiredMatches(
      [match, { matchId: 'later', kickoff: '2026-08-16T23:30:00.000+06:30' }],
      kickSec + 7201
    );
    assert(
      'expire drops only the 21:00 row',
      removed === 1 && kept.length === 1 && kept[0].matchId === 'later'
    );
    const sync = syncMatchesForDelivery([match], [match], { nowSec: kickSec + 7201 });
    assert(
      'sync removes expired even if scrape still returns it',
      sync.matches.length === 0
    );

    const preparingKick = '2026-08-16T23:30:00.000+06:30';
    const { enrichMatchState: enrich } = require('../src/services/statusService');
    const stale = enrich(
      {
        matchId: 'espanyol_levante_20260816',
        kickoff: preparingKick,
        status: 'Scheduled',
        streams: [],
        streamSearch: { started: false, stopped: false, slotsDone: {}, sources: {} },
      },
      { nowSec: toUtcUnixSeconds(preparingKick) - 10 * 60 }
    );
    assert(
      '11:30 PM Yangon at 11:20 PM is PREPARING_STREAM not Scheduled',
      stale.status === 'PREPARING_STREAM'
    );
    const liveNow = enrich(
      {
        matchId: 'espanyol_levante_20260816',
        kickoff: preparingKick,
        status: 'Scheduled',
        streams: [],
        streamSearch: { started: false, stopped: false, slotsDone: {}, sources: {} },
      },
      { nowSec: toUtcUnixSeconds(preparingKick) + 5 * 60 }
    );
    assert('11:30 PM Yangon at 11:35 PM is LIVE', liveNow.status === 'LIVE');
  }

  console.log('\n=== Collapse alias-renamed duplicate matches ===');
  {
    const { syncMatchesForDelivery } = require('../src/services/matchesSyncService');
    const kickoff = DateTime.now().setZone(ZONE).plus({ hours: 4 }).toISO();
    const nowSec = Math.floor(Date.now() / 1000);
    const oldRow = {
      matchId: 'fenerbahce_lyon_20260819',
      fotmobMatchId: 5987803,
      homeTeam: 'Fenerbahçe',
      awayTeam: 'Lyon',
      kickoff,
      league: 'UEFA Champions League',
      streams: [{ url: 'https://example.com/a.m3u8', source: 'cakhia' }],
    };
    const newRow = {
      matchId: 'fenerbahce_olympique_lyonnais_20260819',
      fotmobMatchId: 5987803,
      homeTeam: 'Fenerbahçe',
      awayTeam: 'Olympique Lyonnais',
      kickoff,
      league: 'UEFA Champions League',
      streams: [],
    };
    const sync = syncMatchesForDelivery([oldRow, newRow], [newRow], { nowSec });
    const ids = sync.matches.map((m) => m.matchId);
    assert(
      'Fenerbahce/Lyon alias twin collapsed to one row',
      sync.matches.length === 1 &&
        ids[0] === 'fenerbahce_olympique_lyonnais_20260819',
      JSON.stringify(ids)
    );
    assert(
      'collapsed row keeps the old stream URL',
      sync.matches[0].streams?.some((s) => s.url === 'https://example.com/a.m3u8'),
      JSON.stringify(sync.matches[0].streams)
    );

    const heidenheim = syncMatchesForDelivery(
      [
        {
          matchId: 'fc_heidenheim_bayern_munich_20260818',
          fotmobMatchId: 6000509,
          homeTeam: 'FC Heidenheim',
          awayTeam: 'Bayern Munich',
          kickoff: '2026-08-18T22:30:00.000+06:30',
          league: 'Club Friendlies',
        },
      ],
      [
        {
          matchId: '1_fc_heidenheim_bayern_munich_20260818',
          fotmobMatchId: 6000509,
          homeTeam: '1. FC Heidenheim',
          awayTeam: 'Bayern Munich',
          kickoff: '2026-08-18T22:30:00.000+06:30',
          league: 'Club Friendlies',
        },
      ],
      { nowSec: toUtcUnixSeconds('2026-08-18T21:26:00.000+06:30') }
    );
    assert(
      'Heidenheim alias twin merged onto new matchId',
      heidenheim.matches.length === 1 &&
        heidenheim.matches[0].matchId === '1_fc_heidenheim_bayern_munich_20260818',
      JSON.stringify(heidenheim.matches.map((m) => m.matchId))
    );

    const leaguesDoc = require('../config/leagues.json');
    const keepNorm = new (require('../src/utils/normalize').Normalizer)({
      leagues: leaguesDoc.allowedLeagues,
    });
    const keep = syncMatchesForDelivery(
      [
        {
          matchId: 'vietnam_malaysia_20260819',
          fotmobMatchId: 5844767,
          homeTeam: 'Vietnam',
          awayTeam: 'Malaysia',
          league: 'ASEAN Championship',
          kickoff: '2026-08-19T19:30:00.000+06:30',
        },
        {
          matchId: 'dinamo_zagreb_viking_20260819',
          fotmobMatchId: 5987800,
          homeTeam: 'Dinamo Zagreb',
          awayTeam: 'Viking',
          league: 'UEFA Champions League',
          leagueId: 937348,
          originalNames: {
            fotmob: {
              league: 'INT Champions League Qualification',
              country: 'INT',
              leagueId: 937348,
            },
          },
          kickoff: '2026-08-19T01:30:00.000+06:30',
        },
      ],
      [
        {
          matchId: 'fc_heidenheim_bayern_munich_20260818',
          fotmobMatchId: 6000509,
          homeTeam: 'FC Heidenheim',
          awayTeam: 'Bayern Munich',
          league: 'Club Friendlies',
          kickoff: '2026-08-18T22:30:00.000+06:30',
        },
      ],
      {
        nowSec: toUtcUnixSeconds('2026-08-18T22:00:00.000+06:30'),
        normalizer: keepNorm,
      }
    );
    const keepIds = keep.matches.map((m) => m.matchId).sort();
    assert(
      'partial scrape keeps tomorrow ASEAN + UCL rows',
      keep.matches.length === 3 &&
        keepIds.includes('vietnam_malaysia_20260819') &&
        keepIds.includes('dinamo_zagreb_viking_20260819') &&
        keepIds.includes('fc_heidenheim_bayern_munich_20260818'),
      JSON.stringify(keepIds)
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
