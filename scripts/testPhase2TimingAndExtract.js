/**
 * Phase 2 — Match URL discovery timing, Admin extract gate, stream preservation.
 * Run: node scripts/testPhase2TimingAndExtract.js
 * Timezone: Asia/Yangon (kickoff-relative).
 */
const { DateTime } = require('luxon');
const {
  minutesUntilKickoff,
  isStreamExtractEligible,
  resolveMatchUrlSearchSlot,
  resolveStreamSearchSlot,
  resolveMatchUrlLiveSlot,
  STREAM_EXTRACT_LEAD_MIN,
  MATCH_LIVE_DURATION_MIN,
  STREAM_SEARCH_STOP_AFTER_MIN,
  MATCH_URL_SEARCH_SLOTS,
  STREAM_SEARCH_SLOTS,
} = require('../src/utils/time');
const {
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  applyAdminMatchUrl,
  MATCH_URL_STATUS,
} = require('../src/utils/matchUrlDiscovery');
const { StreamEngine } = require('../src/services/streamEngine');
const {
  mergeStreamLists,
  combineMatchRecords,
} = require('../src/services/matchesSyncService');
const {
  nextSourceStateAfterAttempt,
  STREAM_SOURCE_STATUS,
} = require('../src/utils/streamExtractPolicy');

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

function kickSecFromNow(minsUntilKick) {
  return Math.floor(DateTime.now().setZone(ZONE).toSeconds()) + minsUntilKick * 60;
}

function fixtureAt(minsUntilKick, extra = {}) {
  const kick = kickSecFromNow(minsUntilKick);
  const iso = DateTime.fromSeconds(kick, { zone: ZONE }).toISO();
  return {
    matchId: `m-${minsUntilKick}`,
    homeTeam: 'Home FC',
    awayTeam: 'Away FC',
    kickoff: iso,
    status: minsUntilKick <= 0 ? 'LIVE' : 'Scheduled',
    streams: [],
    sourcePages: {},
    matchUrlSearch: { sources: {}, slotsDone: {} },
    streamSearch: { sources: {}, slotsDone: {}, started: false, stopped: false },
    ...extra,
  };
}

function engineStub() {
  return new StreamEngine({
    sources: [{ name: 'cakhia', config: {} }],
    normalizer: { repairMatchLeague: (m) => m },
  });
}

console.log('\n=== Phase 2: slot config ===');
assert(
  'Match URL slots include −60/−45/−30',
  MATCH_URL_SEARCH_SLOTS.some((s) => s.id === 't60') &&
    MATCH_URL_SEARCH_SLOTS.some((s) => s.id === 't45') &&
    MATCH_URL_SEARCH_SLOTS.some((s) => s.id === 't30')
);
assert(
  'Extract slots include −30/−15/−5 and post-kickoff',
  STREAM_SEARCH_SLOTS.some((s) => s.id === 't30') &&
    STREAM_SEARCH_SLOTS.some((s) => s.id === 't15') &&
    STREAM_SEARCH_SLOTS.some((s) => s.id === 't5') &&
    STREAM_SEARCH_SLOTS.some((s) => s.postKickoff)
);
assert('STREAM_EXTRACT_LEAD_MIN is 30', STREAM_EXTRACT_LEAD_MIN === 30);

console.log('\n=== Phase 2: discovery slot resolution ===');
{
  const k = kickSecFromNow(0);
  assert('Discovery at −60', resolveMatchUrlSearchSlot(k, k - 60 * 60)?.id === 't60');
  assert('Discovery at −45', resolveMatchUrlSearchSlot(k, k - 45 * 60)?.id === 't45');
  assert('Discovery at −30', resolveMatchUrlSearchSlot(k, k - 30 * 60)?.id === 't30');
  assert('No discovery before −60', resolveMatchUrlSearchSlot(k, k - 90 * 60) == null);
  assert('Live discovery at kickoff', resolveMatchUrlLiveSlot(k, k)?.live === true);
}

console.log('\n=== Phase 2: extract slot resolution ===');
{
  const k = kickSecFromNow(0);
  assert('Extract at −30', resolveStreamSearchSlot(k, k - 30 * 60)?.id === 't30');
  assert('Extract at −15', resolveStreamSearchSlot(k, k - 15 * 60)?.id === 't15');
  assert('Extract at −5', resolveStreamSearchSlot(k, k - 5 * 60)?.id === 't5');
  assert('No extract at −31', resolveStreamSearchSlot(k, k - 31 * 60) == null);
  assert('No extract at −60', resolveStreamSearchSlot(k, k - 60 * 60) == null);
  // After kickoff + (stop+1): nowSec is AFTER kickoff
  assert(
    'Extract stop after configured post window',
    resolveStreamSearchSlot(k, k + (STREAM_SEARCH_STOP_AFTER_MIN + 1) * 60) == null
  );
}

console.log('\n=== Phase 2: Admin URL −60/−45/−31 save, no extract ===');
{
  const engine = engineStub();
  for (const mins of [60, 45, 31]) {
    let m = fixtureAt(mins);
    m = applyAdminMatchUrl(m, 'cakhia', 'https://cakhia.example/match/1');
    const st = m.matchUrlSearch.sources.cakhia;
    assert(
      `Admin at −${mins}: CONFIRMED + manual`,
      st?.status === MATCH_URL_STATUS.CONFIRMED && st?.manual === true
    );
    assert(
      `Admin at −${mins}: sourcePages set`,
      m.sourcePages?.cakhia === 'https://cakhia.example/match/1'
    );
    assert(
      `Admin at −${mins}: extract not eligible`,
      isStreamExtractEligible(m.kickoff) === false
    );
    assert(
      `Admin at −${mins}: shouldExtractStreams false`,
      engine.shouldExtractStreams(m) === false
    );
    assert(
      `Admin at −${mins}: force still false`,
      engine.shouldExtractStreams(m, { force: true }) === false
    );
  }
}

console.log('\n=== Phase 2: Admin URL −30/−15 extract eligible ===');
{
  const engine = engineStub();
  for (const mins of [30, 15]) {
    let m = fixtureAt(mins);
    m = applyAdminMatchUrl(m, 'cakhia', 'https://cakhia.example/match/2');
    assert(
      `Admin at −${mins}: extract eligible`,
      isStreamExtractEligible(m.kickoff) === true
    );
    assert(
      `Admin at −${mins}: shouldExtractStreams true (force)`,
      engine.shouldExtractStreams(m, { force: true }) === true
    );
  }
}

console.log('\n=== Phase 2: LIVE catch-up + +2h cutoff ===');
{
  const engine = engineStub();
  let live = fixtureAt(-20);
  live = applyAdminMatchUrl(live, 'cakhia', 'https://cakhia.example/match/live');
  live.streamSearch = { started: false, stopped: false, sources: {}, slotsDone: {} };
  assert(
    'LIVE with URL + never started: catch-up eligible',
    engine.missedExtractCatchup(live) === true ||
      engine.shouldExtractStreams(live, { force: true }) === true
  );

  let late = fixtureAt(-(MATCH_LIVE_DURATION_MIN + 1));
  late = applyAdminMatchUrl(late, 'cakhia', 'https://cakhia.example/match/late');
  assert(
    'After +2h: extract not eligible',
    isStreamExtractEligible(late.kickoff) === false
  );
  assert(
    'After +2h: force still blocked',
    engine.shouldExtractStreams(late, { force: true }) === false
  );
}

console.log('\n=== Phase 2: forceStreamCheck at −60 ===');
{
  const engine = engineStub();
  let m = fixtureAt(60);
  m = applyAdminMatchUrl(m, 'cakhia', 'https://cakhia.example/match/force');
  assert(
    'forceStreamCheck at −60: no extract',
    engine.shouldExtractStreams(m, { force: true }) === false
  );
  assert(
    'minutesUntilKickoff ≈ 60',
    Math.abs(minutesUntilKickoff(m.kickoff) - 60) < 1.5
  );
}

console.log('\n=== Phase 2: discovery failure −60 does not block −45/−30 ===');
{
  const kick = kickSecFromNow(0);
  let m = {
    matchId: 'disc-1',
    homeTeam: 'A',
    awayTeam: 'B',
    kickoff: DateTime.fromSeconds(kick, { zone: ZONE }).toISO(),
    matchUrlSearch: { sources: {}, slotsDone: {} },
    sourcePages: {},
  };
  const slot60 = resolveMatchUrlSearchSlot(kick, kick - 60 * 60);
  m = applySourceDiscoveryResult(m, 'cakhia', null, slot60, new Date().toISOString());
  assert(
    'After −60 NOT_FOUND: still eligible at −45',
    needsMatchUrlDiscovery(m, 'cakhia', kick - 45 * 60) === true
  );
  const slot45 = resolveMatchUrlSearchSlot(kick, kick - 45 * 60);
  m = applySourceDiscoveryResult(m, 'cakhia', null, slot45, new Date().toISOString());
  assert(
    'After −45 NOT_FOUND: still eligible at −30',
    needsMatchUrlDiscovery(m, 'cakhia', kick - 30 * 60) === true
  );
  assert(
    'Status not permanently FAILED after 2 misses',
    m.matchUrlSearch.sources.cakhia.status !== MATCH_URL_STATUS.FAILED
  );
}

console.log('\n=== Phase 2: valid stream survives extraction failure ===');
{
  const valid = {
    url: 'https://cdn.example/live.m3u8',
    source: 'cakhia',
    active: true,
    validation: { ok: true },
    headers: { Referer: 'https://cakhia.example/' },
  };
  const merged = mergeStreamLists([valid], []);
  assert('mergeStreamLists keeps existing on empty incoming', merged.streams.length === 1);

  const prev = {
    matchId: 'keep-1',
    streams: [valid],
    streamUrl: valid.url,
    streamStatus: STREAM_SOURCE_STATUS.AVAILABLE,
    streamSearch: {
      started: true,
      sources: {
        cakhia: { status: STREAM_SOURCE_STATUS.AVAILABLE, attempts: 1, slotsDone: { t30: true } },
      },
      slotsDone: { t30: true },
    },
  };
  const failState = nextSourceStateAfterAttempt({
    previous: prev.streamSearch.sources.cakhia,
    slot: { id: 't15', postKickoff: false },
    validatedStreams: [],
    error: 'NOT_FOUND',
  });
  const incoming = {
    matchId: 'keep-1',
    streams: [],
    streamUrl: null,
    streamStatus: STREAM_SOURCE_STATUS.SEARCHING,
    streamSearch: {
      started: true,
      sources: { cakhia: failState },
      slotsDone: { t30: true, t15: true },
    },
  };
  const { next } = combineMatchRecords(prev, incoming);
  assert('combineMatchRecords keeps streams after fail', (next.streams || []).length === 1);
  assert('combineMatchRecords keeps streamUrl', next.streamUrl === valid.url);
  assert(
    'combineMatchRecords prefers AVAILABLE status',
    next.streamStatus === STREAM_SOURCE_STATUS.AVAILABLE
  );
  assert(
    'failure recorded on source',
    next.streamSearch.sources.cakhia.lastError != null ||
      next.streamSearch.sources.cakhia.status === STREAM_SOURCE_STATUS.SEARCHING
  );
}

console.log('\n=== Phase 2: later retry can succeed after failure ===');
{
  const searching = nextSourceStateAfterAttempt({
    previous: { status: STREAM_SOURCE_STATUS.SEARCHING, attempts: 1, slotsDone: { t30: true } },
    slot: { id: 't15', postKickoff: false },
    validatedStreams: [],
    error: 'TIMEOUT',
  });
  assert(
    'Failed slot leaves SEARCHING (retryable)',
    searching.status === STREAM_SOURCE_STATUS.SEARCHING
  );
  const recovered = nextSourceStateAfterAttempt({
    previous: searching,
    slot: { id: 't5', postKickoff: false },
    validatedStreams: [
      { url: 'https://cdn.example/ok.m3u8', validation: { ok: true }, active: true },
    ],
  });
  assert(
    'Later slot can become AVAILABLE',
    recovered.status === STREAM_SOURCE_STATUS.AVAILABLE
  );
}

console.log('\n=== Phase 2: premature force does not markChecked throttle ===');
{
  const engine = engineStub();
  const m = applyAdminMatchUrl(
    fixtureAt(60),
    'cakhia',
    'https://cakhia.example/match/throttle'
  );
  assert('Before −30: extract false', engine.shouldExtractStreams(m, { force: true }) === false);
  assert(
    'lastCheck unset before any collect',
    engine.lastCheckByMatch.has(m.matchId) === false
  );
}

console.log(`\nPhase 2 results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
