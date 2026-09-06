/**
 * Phase 1 regression: fixture refresh must preserve Match URL / stream / Admin state.
 * Run: node scripts/testRefreshMergePreserve.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { syncMatchesForDelivery } = require('../src/services/matchesSyncService');
const { OverrideService } = require('../src/admin/services/overrideService');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const { DateTime } = require('luxon');

const ZONE = 'Asia/Yangon';

function kickoffIso(hoursFromNow) {
  return DateTime.now().setZone(ZONE).plus({ hours: hoursFromNow }).toISO();
}

function baseFixture(partial) {
  const kickoff = partial.kickoff || kickoffIso(3);
  const dt = DateTime.fromISO(kickoff, { setZone: true }).setZone(ZONE);
  return {
    matchId: partial.matchId || 'team_a_team_b_20260906',
    league: partial.league || 'Serie A',
    homeTeam: partial.homeTeam || 'Team A',
    awayTeam: partial.awayTeam || 'Team B',
    date: dt.toFormat('yyyy-MM-dd'),
    time: dt.toFormat('HH:mm'),
    kickoff,
    timezone: ZONE,
    fotmobMatchId: partial.fotmobMatchId || 1001,
    ...partial,
  };
}

function fotmobShell(existing) {
  return baseFixture({
    matchId: existing.matchId,
    fotmobMatchId: existing.fotmobMatchId,
    homeTeam: existing.homeTeam,
    awayTeam: existing.awayTeam,
    league: existing.league,
    kickoff: existing.kickoff,
    // Fresh FotMob scrape has no stream / Match URL state
    matchUrl: null,
    matchUrlStatus: null,
    matchUrlSearch: undefined,
    sourcePages: {},
    streams: [],
    streamSearch: undefined,
    streamUrl: null,
  });
}

let passed = 0;
function check(name, cond) {
  assert(cond, name);
  passed += 1;
  console.log(`  PASS  ${name}`);
}

function testPreserveAdminAndStreams() {
  console.log('\n1–3. Preserve Admin URL, discovered URL, m3u8');
  const adminUrl = 'https://cakhiazaa.tv/truc-tiep/admin-match/';
  const discoveredUrl = 'https://xoilacxbg.tv/truc-tiep/discovered-match/';
  const streamUrl = 'https://cdn.example.com/live/channel.m3u8';

  const existing = [
    baseFixture({
      matchId: 'admin_match_1',
      fotmobMatchId: 11,
      matchUrl: adminUrl,
      matchUrlStatus: 'MATCH_URL_CONFIRMED',
      matchUrlSource: 'cakhia',
      sourcePages: { cakhia: adminUrl },
      matchUrlSearch: {
        sources: {
          cakhia: {
            matchUrl: adminUrl,
            status: 'MATCH_URL_CONFIRMED',
            attempts: 1,
            manual: true,
            confidence: 100,
          },
        },
      },
      streams: [
        {
          source: 'cakhia',
          type: 'm3u8',
          url: streamUrl,
          active: true,
          headers: { Referer: adminUrl, 'User-Agent': 'UA' },
          validation: { ok: true },
        },
      ],
      streamSearch: {
        started: true,
        stopped: false,
        sources: { cakhia: { status: 'AVAILABLE', attempts: 1, postKickoffAttempts: 0 } },
      },
      streamUrl,
      streamStatus: 'AVAILABLE',
    }),
    baseFixture({
      matchId: 'discovered_match_2',
      fotmobMatchId: 22,
      homeTeam: 'Alpha',
      awayTeam: 'Beta',
      matchUrl: discoveredUrl,
      matchUrlStatus: 'MATCH_URL_FOUND',
      matchUrlSource: 'xoilac',
      sourcePages: { xoilac: discoveredUrl },
      matchUrlSearch: {
        sources: {
          xoilac: {
            matchUrl: discoveredUrl,
            status: 'MATCH_URL_FOUND',
            attempts: 2,
            confidence: 90,
          },
        },
      },
      streams: [],
      streamSearch: { started: false, sources: {} },
    }),
  ];

  const incoming = existing.map(fotmobShell);
  const sync = syncMatchesForDelivery(existing, incoming, { normalizer: null });
  const byId = Object.fromEntries(sync.matches.map((m) => [m.matchId, m]));

  check('admin matchUrl preserved', byId.admin_match_1.matchUrl === adminUrl);
  check(
    'admin matchUrlSearch preserved',
    byId.admin_match_1.matchUrlSearch?.sources?.cakhia?.matchUrl === adminUrl
  );
  check(
    'admin sourcePages preserved',
    byId.admin_match_1.sourcePages?.cakhia === adminUrl
  );
  check(
    'admin streams preserved',
    (byId.admin_match_1.streams || []).some((s) => s.url === streamUrl)
  );
  check(
    'admin streamSearch AVAILABLE preserved',
    byId.admin_match_1.streamSearch?.sources?.cakhia?.status === 'AVAILABLE'
  );
  check(
    'discovered matchUrl preserved',
    byId.discovered_match_2.matchUrl === discoveredUrl
  );
  check(
    'discovered sourcePages preserved',
    byId.discovered_match_2.sourcePages?.xoilac === discoveredUrl
  );
}

function testNewFixture() {
  console.log('\n4. New FotMob fixture with no previous state');
  const incoming = [
    baseFixture({
      matchId: 'brand_new_3',
      fotmobMatchId: 33,
      homeTeam: 'New Home',
      awayTeam: 'New Away',
    }),
  ];
  const sync = syncMatchesForDelivery([], incoming, { normalizer: null });
  check('new fixture added', sync.matches.length === 1);
  check('new fixture id', sync.matches[0].matchId === 'brand_new_3');
  check('new fixture has no matchUrl', !sync.matches[0].matchUrl);
}

function testExpiredLifecycle() {
  console.log('\n5. Expired fixture removed by lifecycle');
  const expiredKick = DateTime.now().setZone(ZONE).minus({ hours: 5 }).toISO();
  const existing = [
    baseFixture({
      matchId: 'old_match',
      fotmobMatchId: 44,
      kickoff: expiredKick,
      matchUrl: 'https://example.com/old',
      sourcePages: { cakhia: 'https://example.com/old' },
    }),
  ];
  const incoming = []; // FotMob no longer lists it
  const sync = syncMatchesForDelivery(existing, incoming, { normalizer: null });
  check('expired removed', sync.removedExpired >= 1);
  check('expired not in output', !sync.matches.some((m) => m.matchId === 'old_match'));
}

function testAdminOverrideAuthoritative() {
  console.log('\nAdmin overrides re-stamp after wipe-like shell');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtv-ov-'));
  const overrides = new OverrideService(tmpDir);
  const matchId = 'override_match_5';
  const adminUrl = 'https://cakhiazaa.tv/truc-tiep/from-overrides/';
  overrides.addManualMatchUrl(matchId, { source: 'cakhia', url: adminUrl, addedBy: 'test' });

  // Simulate wiped row (only fixture fields) — overrides must restore URL
  const wiped = baseFixture({
    matchId,
    fotmobMatchId: 55,
    matchUrl: null,
    sourcePages: {},
    matchUrlSearch: { sources: {} },
    streams: [],
  });
  const stamped = overrides.applyManualMatchUrlsToFixture(wiped);
  check('override restored matchUrl', stamped.matchUrl === adminUrl);
  check(
    'override restored sourcePages',
    stamped.sourcePages?.cakhia === adminUrl
  );
  check(
    'override status CONFIRMED',
    stamped.matchUrlSearch?.sources?.cakhia?.status === 'MATCH_URL_CONFIRMED'
  );
  check('override manual flag', stamped.matchUrlSearch?.sources?.cakhia?.manual === true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testFlutterShape() {
  console.log('\n6. Flutter JSON shape after merge');
  const existing = [
    baseFixture({
      matchId: 'flutter_shape',
      fotmobMatchId: 66,
      matchUrl: 'https://cakhiazaa.tv/truc-tiep/x/',
      matchUrlStatus: 'MATCH_URL_CONFIRMED',
      sourcePages: { cakhia: 'https://cakhiazaa.tv/truc-tiep/x/' },
      matchUrlSearch: {
        sources: {
          cakhia: {
            matchUrl: 'https://cakhiazaa.tv/truc-tiep/x/',
            status: 'MATCH_URL_CONFIRMED',
            attempts: 1,
            manual: true,
          },
        },
      },
      streams: [
        {
          source: 'cakhia',
          type: 'm3u8',
          url: 'https://cdn.example.com/a.m3u8',
          active: true,
          headers: { Referer: 'https://cakhiazaa.tv/', 'User-Agent': 'UA' },
          validation: { ok: true },
        },
      ],
      streamSearch: {
        started: true,
        sources: { cakhia: { status: 'AVAILABLE', attempts: 1 } },
      },
    }),
  ];
  const sync = syncMatchesForDelivery(existing, existing.map(fotmobShell), {
    normalizer: null,
  });
  const payload = generateFlutterJson(sync.matches, { configOrigin: 'test' }, {});
  const m = payload.matches[0];
  check('flutter has matchUrl', m.matchUrl === existing[0].matchUrl);
  check('flutter has sourcePages', m.sourcePages?.cakhia === existing[0].matchUrl);
  check('flutter has streams', (m.streams || []).length === 1);
  check('flutter has matchUrlSearch', !!m.matchUrlSearch?.sources?.cakhia);
  check('flutter has streamSearch', !!m.streamSearch?.sources?.cakhia);
  check('flutter required keys', !!(m.matchId && m.homeTeam && m.awayTeam && m.kickoff));
}

function testPartialIncomingCannotWipe() {
  console.log('\n8. Partial incoming fixture cannot erase known-good local state');
  const url = 'https://cakhiazaa.tv/truc-tiep/keep-me/';
  const streamUrl = 'https://cdn.example.com/keep.m3u8';
  const existing = [
    baseFixture({
      matchId: 'wipe_guard',
      fotmobMatchId: 77,
      matchUrl: url,
      matchUrlStatus: 'MATCH_URL_CONFIRMED',
      matchUrlSource: 'cakhia',
      sourcePages: { cakhia: url },
      matchUrlSearch: {
        sources: {
          cakhia: {
            matchUrl: url,
            status: 'MATCH_URL_CONFIRMED',
            attempts: 1,
            manual: true,
            confidence: 100,
          },
        },
      },
      streams: [
        {
          source: 'cakhia',
          type: 'm3u8',
          url: streamUrl,
          active: true,
          headers: { Referer: url, 'User-Agent': 'UA' },
          streamHeaders: { Referer: url, 'User-Agent': 'UA' },
          validation: { ok: true },
        },
      ],
      streamSearch: {
        started: true,
        sources: { cakhia: { status: 'AVAILABLE', attempts: 2 } },
      },
      streamUrl,
      streamHeaders: { Referer: url, 'User-Agent': 'UA' },
      streamStatus: 'AVAILABLE',
      validationStatus: 'AVAILABLE',
      attempts: 2,
    }),
  ];

  const incoming = [
    {
      ...fotmobShell(existing[0]),
      matchUrl: null,
      matchUrlStatus: 'MATCH_URL_PENDING',
      matchUrlSearch: { sources: {} },
      sourcePages: {},
      streams: [],
      streamSearch: { started: false, sources: {} },
      streamUrl: null,
      streamHeaders: null,
      streamStatus: 'PREPARING_STREAM',
      attempts: 0,
    },
  ];

  const sync = syncMatchesForDelivery(existing, incoming, { normalizer: null });
  const m = sync.matches[0];
  check('partial cannot wipe matchUrl', m.matchUrl === url);
  check(
    'partial cannot wipe matchUrlSearch.manual',
    m.matchUrlSearch?.sources?.cakhia?.manual === true
  );
  check('partial cannot wipe sourcePages', m.sourcePages?.cakhia === url);
  check('partial cannot wipe streams', (m.streams || []).some((s) => s.url === streamUrl));
  check(
    'partial cannot wipe streamSearch AVAILABLE',
    m.streamSearch?.sources?.cakhia?.status === 'AVAILABLE'
  );
  check('partial cannot wipe streamUrl', m.streamUrl === streamUrl);
  check('partial cannot wipe streamStatus AVAILABLE', m.streamStatus === 'AVAILABLE');
}

function testGithubRestoreMergesLocal() {
  console.log('\n9. GitHub-sparse restore merges onto local (simulates restore merge)');
  const url = 'https://xoilacxbg.tv/truc-tiep/local-rich/';
  const streamUrl = 'https://cdn.example.com/local.m3u8';
  const local = [
    baseFixture({
      matchId: 'restore_merge',
      fotmobMatchId: 88,
      matchUrl: url,
      matchUrlStatus: 'MATCH_URL_FOUND',
      sourcePages: { xoilac: url },
      matchUrlSearch: {
        sources: {
          xoilac: { matchUrl: url, status: 'MATCH_URL_FOUND', attempts: 1 },
        },
      },
      streams: [
        {
          source: 'xoilac',
          type: 'm3u8',
          url: streamUrl,
          active: true,
          validation: { ok: true },
        },
      ],
      streamSearch: {
        started: true,
        sources: { xoilac: { status: 'AVAILABLE', attempts: 1 } },
      },
      streamUrl,
      streamStatus: 'AVAILABLE',
    }),
  ];
  const remoteSparse = [
    baseFixture({
      matchId: 'restore_merge',
      fotmobMatchId: 88,
      matchUrl: null,
      sourcePages: {},
      streams: [],
      streamUrl: null,
    }),
  ];
  const sync = syncMatchesForDelivery(local, remoteSparse, { normalizer: null });
  const m = sync.matches[0];
  check('restore merge keeps local matchUrl', m.matchUrl === url);
  check('restore merge keeps local stream', (m.streams || []).some((s) => s.url === streamUrl));
}

function main() {
  console.log('Phase 1 refresh merge preserve tests');
  testPreserveAdminAndStreams();
  testNewFixture();
  testExpiredLifecycle();
  testAdminOverrideAuthoritative();
  testFlutterShape();
  testPartialIncomingCannotWipe();
  testGithubRestoreMergesLocal();
  console.log(`\nAll ${passed} checks passed.`);
}

main();
