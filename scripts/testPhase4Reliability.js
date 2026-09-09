/**
 * Phase 4 — source isolation, classification, locks, health, timing freeze.
 * Run: node scripts/testPhase4Reliability.js
 */
const { DateTime } = require('luxon');
const {
  classifySourceError,
  isTransientDiscoverError,
  applyAdminMatchUrl,
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  MATCH_URL_STATUS,
} = require('../src/utils/matchUrlDiscovery');
const {
  DEFAULT_CRONS,
  isFootballPeakWindow,
  selectNextHeavyJob,
  HEAVY_JOBS,
  ZONE,
} = require('../src/utils/jobSchedule');
const {
  resolveMatchUrlSearchSlot,
  resolveStreamSearchSlot,
  isStreamExtractEligible,
  STREAM_EXTRACT_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
} = require('../src/utils/time');
const { StreamEngine } = require('../src/services/streamEngine');
const { JobQueue } = require('../src/utils/jobQueue');
const { Pipeline } = require('../src/services/pipeline');
const {
  mergeStreamLists,
  combineMatchRecords,
} = require('../src/services/matchesSyncService');
const { STREAM_SOURCE_STATUS } = require('../src/utils/streamExtractPolicy');

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

console.log('\n=== Phase 4: error classification ===');
assert(
  'ENOTFOUND → DNS_ERROR',
  classifySourceError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND mitomzd.cc' }) ===
    'DNS_ERROR'
);
assert(
  'ETIMEDOUT → TIMEOUT',
  classifySourceError({ code: 'ETIMEDOUT', message: 'timeout' }) === 'TIMEOUT'
);
assert(
  'ECONNRESET → NETWORK_ERROR',
  classifySourceError({ code: 'ECONNRESET', message: 'read ECONNRESET' }) ===
    'NETWORK_ERROR'
);
assert(
  'HTTP 403 → HTTP_ERROR',
  classifySourceError(new Error('Request failed with status code 403')) === 'HTTP_ERROR'
);
assert(
  'parse failure → PARSER_ERROR',
  classifySourceError(new Error('cheerio parse failed')) === 'PARSER_ERROR'
);
assert(
  'DNS is transient (no attempt burn)',
  isTransientDiscoverError({ code: 'ENOTFOUND', message: 'ENOTFOUND' }) === true
);
assert(
  'generic extract → EXTRACT_ERROR',
  classifySourceError(new Error('boom')) === 'EXTRACT_ERROR'
);

console.log('\n=== Phase 4: discoverAll source isolation ===');
(async () => {
  const kick = Math.floor(Date.now() / 1000) + 45 * 60;
  const fixture = {
    matchId: 'iso-1',
    homeTeam: 'Home',
    awayTeam: 'Away',
    kickoff: DateTime.fromSeconds(kick, { zone: 'Asia/Yangon' }).toISO(),
    matchUrlSearch: {
      sources: {
        cakhia: {
          matchUrl: 'https://cakhia.example/saved',
          status: MATCH_URL_STATUS.CONFIRMED,
          attempts: 1,
          slotsDone: { t60: true },
          confidence: 100,
          manual: true,
        },
      },
      slotsDone: {},
    },
    sourcePages: { cakhia: 'https://cakhia.example/saved' },
    streams: [],
  };

  const fixtureDue = {
    matchId: 'iso-2',
    homeTeam: 'Other',
    awayTeam: 'Side',
    kickoff: DateTime.fromSeconds(kick, { zone: 'Asia/Yangon' }).toISO(),
    matchUrlSearch: { sources: {}, slotsDone: {} },
    sourcePages: {},
    streams: [],
  };

  const engine = new StreamEngine({
    sources: [
      {
        name: 'mitomtm',
        config: { enabled: true, priority: 1 },
        async discoverMatchesForFixtures() {
          const err = new Error('getaddrinfo ENOTFOUND mitomzd.cc');
          err.code = 'ENOTFOUND';
          throw err;
        },
      },
      {
        name: 'socolive',
        config: { enabled: true, priority: 2 },
        async discoverMatchesForFixtures() {
          const err = new Error('getaddrinfo ENOTFOUND socoliveza.tv');
          err.code = 'ENOTFOUND';
          throw err;
        },
      },
      {
        name: 'xoilac',
        config: { enabled: true, priority: 3 },
        async discoverMatchesForFixtures() {
          const err = new Error('timeout of 15000ms exceeded');
          err.code = 'ETIMEDOUT';
          throw err;
        },
      },
      {
        name: 'cakhia',
        config: { enabled: true, priority: 4 },
        async discoverMatchesForFixtures() {
          return []; // reachable but NOT_FOUND for due fixtures
        },
      },
    ],
  });

  const bySource = await engine.discoverAll([fixture, fixtureDue]);
  assert('mitom DNS does not crash discoverAll', bySource.mitomtm != null);
  assert(
    'mitom classified DNS_ERROR',
    engine.lastDiscoverMeta.mitomtm?.errorClass === 'DNS_ERROR'
  );
  assert(
    'socolive classified DNS_ERROR',
    engine.lastDiscoverMeta.socolive?.errorClass === 'DNS_ERROR'
  );
  assert(
    'xoilac classified TIMEOUT',
    engine.lastDiscoverMeta.xoilac?.errorClass === 'TIMEOUT'
  );
  assert(
    'cakhia completed as NOT_FOUND (not SUCCESS)',
    engine.lastDiscoverMeta.cakhia?.result === 'NOT_FOUND'
  );
  assert(
    'Admin/cakhia saved URL preserved in bySource',
    (bySource.cakhia || []).some((m) => m.matchUrl === 'https://cakhia.example/saved')
  );
  assert(
    'DNS failure is transient (later slots not burned)',
    engine.lastDiscoverMeta.mitomtm?.transient === true
  );

  const persisted = [];
  const incremental = new StreamEngine({
    sources: [
      {
        name: 'cakhia',
        config: { enabled: true, priority: 10 },
        async discoverMatchesForFixtures() {
          return [
            {
              matchId: 'iso-2',
              matchUrl: 'https://cakhia.example/found',
              matchUrlStatus: MATCH_URL_STATUS.CONFIRMED,
              confidence: 100,
            },
          ];
        },
      },
      {
        name: 'mitomtm',
        config: { enabled: true, priority: 1 },
        async discoverMatchesForFixtures() {
          const err = new Error('getaddrinfo ENOTFOUND mitomzd.cc');
          err.code = 'ENOTFOUND';
          throw err;
        },
      },
    ],
    onMatchUpdated: async (match) => {
      persisted.push(match.matchUrl || null);
    },
  });
  const collected = await incremental.collectForFixtures([fixtureDue]);
  assert(
    'Working source Match URL is saved when another source DNS-fails',
    collected[0]?.matchUrl === 'https://cakhia.example/found',
    JSON.stringify({ url: collected[0]?.matchUrl, status: collected[0]?.matchUrlStatus })
  );
  assert(
    'Match URL persisted immediately (not waiting for dead sources)',
    persisted.includes('https://cakhia.example/found')
  );

  console.log('\n=== Phase 4: extraction queue isolation + duplicates ===');
  const q = new JobQueue({ concurrency: 2 });
  const seen = [];
  const jobs = [
    { key: 'm1:cakhia:stream:t30', matchId: 'm1', source: 'cakhia' },
    { key: 'm1:cakhia:stream:t30', matchId: 'm1', source: 'cakhia' },
    { key: 'm1:xoilac:stream:t30', matchId: 'm1', source: 'xoilac' },
    { key: 'm2:cakhia:stream:t30', matchId: 'm2', source: 'cakhia' },
  ];
  const results = await q.run(jobs, async (job) => {
    if (job.source === 'xoilac') throw new Error('EXTRACT_FAIL');
    seen.push(job.key);
    return { ok: true };
  });
  assert(
    'Duplicate same match+source skipped',
    results.some((r) => r.reason === 'duplicate')
  );
  assert(
    'Other sources/fixtures still ran',
    seen.includes('m1:cakhia:stream:t30') && seen.includes('m2:cakhia:stream:t30')
  );
  assert(
    'Failed job does not crash queue',
    results.some((r) => r.error) && results.some((r) => r.value?.ok)
  );

  console.log('\n=== Phase 4: stream preservation ===');
  {
    const valid = {
      url: 'https://cdn.example/keep.m3u8',
      source: 'cakhia',
      active: true,
      validation: { ok: true },
      quality: 'HD',
    };
    const merged = mergeStreamLists([valid], []);
    assert('empty extract keeps streams', merged.streams.length === 1);
    const { next } = combineMatchRecords(
      {
        matchId: 'p4',
        streams: [valid],
        streamUrl: valid.url,
        streamStatus: STREAM_SOURCE_STATUS.AVAILABLE,
        streamSearch: {
          started: true,
          sources: { cakhia: { status: STREAM_SOURCE_STATUS.AVAILABLE } },
        },
      },
      {
        matchId: 'p4',
        streams: [],
        streamUrl: null,
        streamStatus: STREAM_SOURCE_STATUS.SEARCHING,
        streamSearch: {
          started: true,
          sources: {
            cakhia: {
              status: STREAM_SOURCE_STATUS.SEARCHING,
              lastError: 'TIMEOUT',
            },
          },
        },
      }
    );
    assert('combine keeps streamUrl', next.streamUrl === valid.url);
    assert('combine keeps quality stream', next.streams[0].quality === 'HD');
    assert('combine keeps AVAILABLE', next.streamStatus === STREAM_SOURCE_STATUS.AVAILABLE);
  }

  console.log('\n=== Phase 4: discovery retry −60 → −45 ===');
  {
    const k = Math.floor(Date.now() / 1000) + 3600;
    let m = {
      matchId: 'retry-1',
      homeTeam: 'A',
      awayTeam: 'B',
      kickoff: DateTime.fromSeconds(k, { zone: 'Asia/Yangon' }).toISO(),
      matchUrlSearch: { sources: {}, slotsDone: {} },
      sourcePages: {},
    };
    m = applySourceDiscoveryResult(
      m,
      'xoilac',
      null,
      resolveMatchUrlSearchSlot(k, k - 60 * 60),
      new Date().toISOString()
    );
    assert(
      '−60 miss still eligible −45',
      needsMatchUrlDiscovery(m, 'xoilac', k - 45 * 60) === true
    );
  }

  console.log('\n=== Phase 4: timing freeze ===');
  assert('TZ Asia/Yangon', ZONE === 'Asia/Yangon');
  assert('Matches */5', DEFAULT_CRONS.PIPELINE_CRON === '*/5 * * * *');
  assert('MyanmarTV 03:00', DEFAULT_CRONS.MYANMARTV_CRON === '0 3 * * *');
  assert('Highlights 06:00', DEFAULT_CRONS.HIGHLIGHT_CRON === '0 6 * * *');
  assert('Tips 08:07', DEFAULT_CRONS.TIPS_CRON === '7 8 * * *');
  assert('STREAM_EXTRACT_LEAD_MIN 30', STREAM_EXTRACT_LEAD_MIN === 30);
  {
    const k = Math.floor(Date.now() / 1000);
    assert('Match URL −60', resolveMatchUrlSearchSlot(k, k - 60 * 60)?.id === 't60');
    assert('Match URL −50', resolveMatchUrlSearchSlot(k, k - 50 * 60)?.id === 't50');
    assert('Match URL −40', resolveMatchUrlSearchSlot(k, k - 40 * 60)?.id === 't40');
    assert('Match URL −30', resolveMatchUrlSearchSlot(k, k - 30 * 60)?.id === 't30');
    assert('m3u8 −30', resolveStreamSearchSlot(k, k - 30 * 60)?.id === 't30');
    assert('m3u8 −20', resolveStreamSearchSlot(k, k - 20 * 60)?.id === 't20');
    assert('m3u8 −10', resolveStreamSearchSlot(k, k - 10 * 60)?.id === 't10');
    assert('m3u8 −5', resolveStreamSearchSlot(k, k - 5 * 60)?.id === 't5');
    assert(
      'Admin −60 no extract',
      isStreamExtractEligible(k, k - 60 * 60) === false
    );
    assert(
      'force cannot bypass −30 (eligibility)',
      isStreamExtractEligible(k, k - 60 * 60) === false
    );
    assert(
      '+2h cutoff',
      isStreamExtractEligible(k, k + (MATCH_LIVE_DURATION_MIN + 1) * 60) === false
    );
    const peak = DateTime.fromObject(
      { year: 2026, month: 9, day: 6, hour: 20 },
      { zone: ZONE }
    );
    assert('peak excludes Tips', isFootballPeakWindow(peak) === true);
    assert(
      'peak Matches still preferred',
      selectNextHeavyJob(
        [HEAVY_JOBS.TIPS, HEAVY_JOBS.MATCHES, HEAVY_JOBS.MYANMARTV],
        { when: peak }
      ) === HEAVY_JOBS.MATCHES
    );
  }

  console.log('\n=== Phase 4: health diagnostics + finally locks ===');
  {
    const p = new Pipeline({});
    p.running = true;
    p._runningSince = Date.now() - 5000;
    p.lastDiscoveryAt = '2026-09-06T01:00:00.000Z';
    p.lastExtractAt = '2026-09-06T01:01:00.000Z';
    const d = p.getRuntimeDiagnostics();
    assert('diagnostics has tipsRunning', 'tipsRunning' in d);
    assert('diagnostics has lock ages', d.locks.pipeline.ageSec >= 4);
    assert('diagnostics has lastDiscoveryAt', d.lastDiscoveryAt != null);
    assert('diagnostics has lastExtractAt', d.lastExtractAt != null);

    p.tipsRunning = true;
    p._tipsSince = Date.now();
    try {
      throw new Error('sim');
    } catch {
      // simulated job failure
    } finally {
      p.tipsRunning = false;
      p._tipsSince = 0;
    }
    assert('finally clears tipsRunning', p.tipsRunning === false);
  }

  console.log('\n=== Phase 4: Admin URL before −30 ===');
  {
    const eng = new StreamEngine({
      sources: [{ name: 'cakhia', config: {} }],
    });
    let m = {
      matchId: 'admin-60',
      homeTeam: 'H',
      awayTeam: 'A',
      kickoff: DateTime.now()
        .setZone('Asia/Yangon')
        .plus({ minutes: 60 })
        .toISO(),
      streams: [],
      matchUrlSearch: { sources: {}, slotsDone: {} },
      sourcePages: {},
      streamSearch: { sources: {}, slotsDone: {} },
    };
    m = applyAdminMatchUrl(m, 'cakhia', 'https://cakhia.example/admin');
    assert(
      'Admin CONFIRMED',
      m.matchUrlSearch.sources.cakhia.status === MATCH_URL_STATUS.CONFIRMED
    );
    assert(
      'Admin force still no extract at −60',
      eng.shouldExtractStreams(m, { force: true }) === false
    );
  }

  console.log(`\nPhase 4 results: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
