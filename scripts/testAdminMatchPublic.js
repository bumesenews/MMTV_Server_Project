/**
 * Admin-match.json apply + public matches.json filter.
 * Run: node scripts/testAdminMatchPublic.js
 */
const { applyAdminEntryToFixture, upsertAdminEntry, emptyAdminMatchDoc } = require('../src/utils/adminMatch');
const { needsMatchUrlDiscovery, applySourceDiscoveryResult, MATCH_URL_STATUS } = require('../src/utils/matchUrlDiscovery');
const { generateFlutterJson, toPublicMatch, toPublicMatchesPayload } = require('../src/services/jsonGenerator');
const { formatMatchesDelivery } = require('../src/services/deliveryFormats');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fixture = {
  matchId: 'cagliari_lecce_20260907',
  league: 'Serie A',
  homeTeam: 'Cagliari',
  awayTeam: 'Lecce',
  date: '7.9.2026',
  time: '11:00 PM',
  kickoff: '2026-09-07T23:00:00.000+06:30',
  status: 'Scheduled',
  matchUrl: null,
  matchUrlStatus: 'MATCH_URL_PENDING',
  matchUrlSearch: { sources: {} },
  sourcePages: {},
  streams: [],
};

console.log('\n=== TEST 1 Auto Match URL still applies ===');
{
  const auto = {
    ...fixture,
    matchUrl: 'https://cakhia.example/auto',
    matchUrlStatus: MATCH_URL_STATUS.CONFIRMED,
    matchUrlSource: 'cakhia',
    sourcePages: { cakhia: 'https://cakhia.example/auto' },
    streams: [{ source: 'cakhia', url: 'https://cdn.example/auto.m3u8', active: true, validation: { ok: true } }],
    streamUrl: 'https://cdn.example/auto.m3u8',
    streamStatus: 'AVAILABLE',
  };
  const pub = toPublicMatch(auto);
  check('public has fixture + stream', pub.homeTeam === 'Cagliari' && pub.streamUrl.includes('auto.m3u8'));
  check('public has no matchUrl', pub.matchUrl === undefined);
  check('public has no sourcePages', pub.sourcePages === undefined);
}

console.log('\n=== TEST 2 Manual Match URL only ===');
{
  const next = applyAdminEntryToFixture(fixture, {
    matchId: fixture.matchId,
    source: 'cakhia',
    matchUrl: 'https://cakhia.example/manual-page',
    streamUrl: '',
  });
  check('manual matchUrl stamped', next.matchUrl === 'https://cakhia.example/manual-page');
  check('source marked manual', next.matchUrlSearch.sources.cakhia.manual === true);
  check('no adminSkipExtract without stream', !next.adminSkipExtract);
}

console.log('\n=== TEST 3 Stream URL only skips extract ===');
{
  const next = applyAdminEntryToFixture(fixture, {
    matchId: fixture.matchId,
    source: 'cakhia',
    matchUrl: '',
    streamUrl: 'https://cdn.example/manual.m3u8',
  });
  check('stream attached', next.streamUrl === 'https://cdn.example/manual.m3u8');
  check('adminSkipExtract', next.adminSkipExtract === true);
  const pub = toPublicMatch(next);
  check('public stream only', pub.streamUrl === next.streamUrl && pub.matchUrl === undefined);
}

console.log('\n=== TEST 4 Match URL + Stream URL ===');
{
  const next = applyAdminEntryToFixture(fixture, {
    matchId: fixture.matchId,
    source: 'xoilac',
    matchUrl: 'https://xoilac.example/page',
    streamUrl: 'https://cdn.example/both.m3u8',
  });
  check('both applied', next.matchUrl.includes('xoilac') && next.streamUrl.includes('both.m3u8'));
  check('skip extract when stream given', next.adminSkipExtract === true);
}

console.log('\n=== TEST 5 Manual Match URL not overwritten ===');
{
  const stamped = applyAdminEntryToFixture(fixture, {
    matchId: fixture.matchId,
    source: 'cakhia',
    matchUrl: 'https://cakhia.example/keep-me',
  });
  check(
    'discovery skipped when manual',
    needsMatchUrlDiscovery(stamped, 'cakhia', Math.floor(Date.now() / 1000)) === false
  );
  const overwritten = applySourceDiscoveryResult(
    stamped,
    'cakhia',
    { matchUrl: 'https://cakhia.example/auto-should-lose', accepted: true, status: MATCH_URL_STATUS.CONFIRMED, confidence: 99 },
    { id: 't30', attempt: 1 },
    new Date().toISOString()
  );
  check(
    'auto result does not replace manual URL',
    overwritten.matchUrlSearch.sources.cakhia.matchUrl === 'https://cakhia.example/keep-me'
  );
}

console.log('\n=== TEST 6 admin-match.json upsert persists matchId ===');
{
  const doc = upsertAdminEntry(emptyAdminMatchDoc(), {
    matchId: 'cagliari_lecce_20260907',
    source: 'cakhia',
    matchUrl: 'https://cakhia.example/page',
  });
  check('entry stored', doc.matches[0].matchId === 'cagliari_lecce_20260907');
}

console.log('\n=== TEST 7 public matches.json strip ===');
{
  const payload = generateFlutterJson([
    {
      ...fixture,
      matchUrl: 'https://secret.example/page',
      matchUrlStatus: 'MATCH_URL_CONFIRMED',
      matchUrlAttempts: 3,
      lastMatchUrlAttemptAt: '2026-09-07T00:00:00.000Z',
      matchUrlSource: 'cakhia',
      sourcePages: { cakhia: 'https://secret.example/page' },
      streamAttempts: { t30: true },
      streamSearch: { started: true, sources: { cakhia: { status: 'AVAILABLE' } } },
      matchUrlSearch: { sources: { cakhia: { matchUrl: 'https://secret.example/page', manual: true } } },
      validationReason: 'HTTP_403',
      validationStatus: 'HTTP_403',
      streams: [
        {
          source: 'cakhia',
          url: 'https://cdn.example/ok.m3u8',
          headers: { Referer: 'https://player.example/' },
          active: true,
          validation: { ok: true },
          manualId: 'hidden',
        },
      ],
      streamUrl: 'https://cdn.example/ok.m3u8',
      streamStatus: 'AVAILABLE',
    },
  ]);
  const delivery = formatMatchesDelivery(payload);
  const m = delivery.matches[0];
  check('delivery stream kept', m.streamUrl === 'https://cdn.example/ok.m3u8');
  check('no matchUrl', !('matchUrl' in m));
  check('no matchUrlStatus', !('matchUrlStatus' in m));
  check('no sourcePages', !('sourcePages' in m));
  check('no streamSearch', !('streamSearch' in m));
  check('no matchUrlSearch', !('matchUrlSearch' in m));
  check('no validationReason', !('validationReason' in m));
  check('no adminManual', !('adminManual' in m));
  check('toPublicMatchesPayload same strip', !('matchUrl' in toPublicMatchesPayload(payload).matches[0]));
}

console.log('\n=== TEST 8 full admin-match.json does not lock AUTO urls ===');
{
  const { applyAdminMatchDocToMatches, toAdminMatchDoc, mergeAdminMatchDocs } = require('../src/utils/adminMatch');
  const full = generateFlutterJson([
    {
      ...fixture,
      homeTeam: 'Cagliari',
      matchUrl: 'https://cakhia.example/auto',
      matchUrlStatus: 'MATCH_URL_CONFIRMED',
      streamUrl: 'https://cdn.example/auto.m3u8',
      h2h: { matches: [{ score: '1-0' }] },
    },
  ]);
  const applied = applyAdminMatchDocToMatches(
    [{ ...fixture, matchUrl: 'https://cakhia.example/from-scrape' }],
    full
  );
  check('full dump without adminManual is not an override', applied[0].matchUrl === 'https://cakhia.example/from-scrape');
  check('toAdminMatchDoc keeps matchUrl + h2h', toAdminMatchDoc(full).matches[0].matchUrl.includes('auto') && toAdminMatchDoc(full).matches[0].h2h != null);

  const withManual = {
    ...full,
    matches: [
      {
        ...full.matches[0],
        adminManual: { matchUrl: 'https://cakhia.example/manual', streamUrl: '', source: 'cakhia' },
      },
    ],
  };
  const stamped = applyAdminMatchDocToMatches([fixture], withManual);
  check('adminManual still applied from full dump', stamped[0].matchUrl === 'https://cakhia.example/manual');

  const merged = mergeAdminMatchDocs({ version: 1, matches: [] }, full);
  check('empty local does not wipe GitHub full dump', merged.matches[0].homeTeam === 'Cagliari' && merged.matches[0].h2h != null);

  const upserted = upsertAdminEntry(full, {
    matchId: fixture.matchId,
    source: 'cakhia',
    matchUrl: 'https://cakhia.example/typed',
  });
  check('upsert on full doc keeps fixture fields', upserted.matches[0].homeTeam === 'Cagliari' && upserted.matches[0].h2h != null);
  check('upsert stamps adminManual', upserted.matches[0].adminManual.matchUrl === 'https://cakhia.example/typed');

  const { applyStickyStoredMatch, preserveDiscoveredFields } = require('../src/utils/adminMatch');
  const shell = { ...fixture, matchUrl: null, matchUrlStatus: 'MATCH_URL_PENDING' };
  const sticky = applyStickyStoredMatch(shell, full.matches[0]);
  check('sticky restores AUTO matchUrl onto empty scrape shell', sticky.matchUrl === 'https://cakhia.example/auto');
  check('sticky does not set adminManual', !sticky.adminManual);
  const wiped = preserveDiscoveredFields(full, generateFlutterJson([shell]));
  check(
    'publish preserve does not write null over stored AUTO url',
    wiped.matches[0].matchUrl === 'https://cakhia.example/auto'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
