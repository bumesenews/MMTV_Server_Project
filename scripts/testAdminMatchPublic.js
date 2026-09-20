/**
 * Admin-match.json apply + public matches.json filter.
 * Run: node scripts/testAdminMatchPublic.js
 */
const { applyAdminEntryToFixture, upsertAdminEntry, emptyAdminMatchDoc } = require('../src/utils/adminMatch');
const { needsMatchUrlDiscovery, applySourceDiscoveryResult, MATCH_URL_STATUS } = require('../src/utils/matchUrlDiscovery');
const { generateFlutterJson, toPublicMatch, toPublicMatchesPayload, flutterStreamName, publicStreamLabel } = require('../src/services/jsonGenerator');
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
  check('public stream keeps source', m.streams.every((s) => s.source === 'cakhia'));
  check('public stream has no quality', m.streams.every((s) => !('quality' in s)));
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

console.log('\n=== TEST 9 public matches.json keeps m3u8 when only streamUrl is set ===');
{
  const payload = generateFlutterJson([
    {
      ...fixture,
      streams: [],
      hasStreams: false,
      streamCount: 0,
      streamUrl: 'https://live2.example/channel15.m3u8',
      streamHeaders: { Referer: 'https://ck.example/' },
      streamStatus: 'AVAILABLE',
      matchUrl: 'https://cakhia.example/page',
    },
  ]);
  const internal = payload.matches[0];
  check(
    'internal streams[] includes streamUrl',
    internal.hasStreams === true &&
      internal.streamCount >= 1 &&
      internal.streams.some((s) => s.url === 'https://live2.example/channel15.m3u8')
  );
  const pub = toPublicMatch({
    ...fixture,
    streams: [],
    hasStreams: false,
    streamCount: 0,
    streamUrl: 'https://live2.example/channel15.m3u8',
    streamHeaders: { Referer: 'https://ck.example/' },
    streamStatus: 'AVAILABLE',
    matchUrl: 'https://cakhia.example/page',
  });
  check('public has no matchUrl', !('matchUrl' in pub));
  check(
    'public streams[] + hasStreams from streamUrl',
    pub.hasStreams === true &&
      pub.streamCount === 1 &&
      pub.streams[0].url === 'https://live2.example/channel15.m3u8' &&
      pub.streamUrl === 'https://live2.example/channel15.m3u8'
  );
  const noMatchUrlStream = generateFlutterJson([
    {
      ...fixture,
      matchUrl: null,
      streams: [
        {
          source: 'cakhia',
          url: 'https://live2.example/extracted.m3u8',
          active: true,
        },
      ],
      streamUrl: 'https://live2.example/extracted.m3u8',
    },
  ]);
  check(
    'extracted m3u8 published even without saved Match URL on that source',
    noMatchUrlStream.matches[0].streams.some((s) => s.url.includes('extracted.m3u8')) &&
      noMatchUrlStream.matches[0].hasStreams === true
  );
}

console.log('\n=== TEST 10 public stream names use button/quality; quality key stripped ===');
{
  check(
    'Cakhia + HD ROY',
    flutterStreamName({ source: 'cakhia', quality: 'HD ROY' }) === 'HD ROY'
  );
  check(
    'does not keep domain as the title',
    flutterStreamName({ source: 'cakhia', name: 'cakhiazaa.tv', quality: 'HD ROY' }) === 'HD ROY'
  );
  check(
    'strips old Cakhia · prefix',
    flutterStreamName({ source: 'cakhia', name: 'Cakhia · HD ROY', quality: 'HD ROY' }) === 'HD ROY'
  );
  check(
    'manual ENG HD',
    flutterStreamName({ source: 'manual', quality: 'ENG HD' }) === 'ENG HD'
  );
  check(
    'strips accumulated source tokens from republished names',
    publicStreamLabel({
      source: 'cakhia',
      name: 'CAKHIA XOILAC SOCOLIVE CAKHIA XOILAC SOCOLIVE PHUT LOGAN',
    }) === 'CAKHIA LOGAN'
  );
  check(
    'xoilac row from polluted name keeps JOHAN',
    publicStreamLabel({
      source: 'xoilac',
      name: 'XOILAC SOCOLIVE CAKHIA XOILAC SOCOLIVE PHUT JOHAN',
    }) === 'XOILAC JOHAN'
  );
  const namedPayload = generateFlutterJson([
    {
      ...fixture,
      kickoff: '2099-01-01T23:00:00.000+06:30',
      status: 'LIVE',
      matchUrl: 'https://cakhia.example/page',
      matchUrlSearch: {
        sources: { cakhia: { matchUrl: 'https://cakhia.example/page', status: 'MATCH_URL_CONFIRMED' } },
      },
      streams: [
        { source: 'cakhia', quality: 'HD ROY', url: 'https://cdn.example/a.m3u8', active: true },
      ],
    },
  ]);
  const pubName = toPublicMatch(namedPayload.matches[0]);
  check(
    'matches.json keeps source, name is button not site',
    pubName.streams[0].source === 'cakhia' &&
      pubName.streams[0].name === 'CAKHIA HD ROY' &&
      !('quality' in pubName.streams[0])
  );
  const expanded = generateFlutterJson([
    {
      ...fixture,
      kickoff: '2099-01-01T23:00:00.000+06:30',
      status: 'LIVE',
      streams: [
        { source: 'cakhia', name: 'JOHAN', url: 'https://cdn.example/a.m3u8', active: true },
      ],
      matchUrlSearch: {
        sources: {
          cakhia: { matchUrl: 'https://ck.example/p', status: 'MATCH_URL_CONFIRMED' },
          xoilac: { matchUrl: 'https://xl.example/p', status: 'MATCH_URL_CONFIRMED' },
          socolive: { matchUrl: 'https://soco.example/p', status: 'MATCH_URL_CONFIRMED' },
        },
      },
      streamSearch: {
        sources: {
          cakhia: { status: 'AVAILABLE' },
          xoilac: { status: 'AVAILABLE' },
          socolive: { status: 'AVAILABLE' },
        },
      },
    },
  ]);
  const pubExp = toPublicMatch(expanded.matches[0]);
  check('does not clone cakhia onto other AVAILABLE sources', pubExp.streamCount === 1);
  check('keeps the discovered source only', pubExp.streams[0].source === 'cakhia' && pubExp.streams[0].name === 'CAKHIA JOHAN');
  const mixed = generateFlutterJson([
    {
      ...fixture,
      kickoff: '2099-01-01T23:00:00.000+06:30',
      status: 'LIVE',
      streams: [
        { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', active: true },
        { source: 'cakhia', name: 'ROY HD', url: 'https://cdn.example/b.m3u8', active: true },
        { source: 'xoilac', name: 'JOHAN', url: 'https://cdn.example/c.m3u8', active: true },
        { source: 'phut', name: 'ROY', url: 'https://cdn.example/a.m3u8', active: true },
        { source: 'phut', name: 'JOHAN', url: 'https://cdn.example/d.m3u8', active: true },
        { source: 'socolive', name: 'JOHAN', url: 'https://cdn.example/c.m3u8', active: true },
      ],
    },
  ]);
  const pubMixed = toPublicMatch(mixed.matches[0]);
  check('unique names and one stream per website', pubMixed.streamCount === 2);
  check(
    'keeps first unique names only',
    pubMixed.streams.map((s) => s.name).join(',') === 'CAKHIA ROY,XOILAC JOHAN'
  );
}

console.log('\n=== TEST 11 public streams keep source and one row per source+URL ===');
{
  const sameUrl = 'https://cdn.example/same.m3u8';
  const otherUrl = 'https://cdn.example/other.m3u8';
  const pubDup = toPublicMatch({
    matchId: 'dup_1',
    homeTeam: 'A',
    awayTeam: 'B',
    league: 'Serie A',
    status: 'PREPARING_STREAM',
    streamUrl: sameUrl,
    streams: [
      { source: 'cakhia', name: 'JOHAN', url: sameUrl, headers: { Referer: 'https://ck.example/' } },
      { source: 'xoilac', name: 'JOHAN', url: sameUrl, headers: { Referer: 'https://xl.example/' } },
      { source: 'socolive', name: 'JOHAN', url: sameUrl, headers: { Referer: 'https://soco.example/' } },
      { source: 'cakhia', name: 'JOHAN', url: sameUrl, headers: { Referer: 'https://ck.example/dup/' } },
      { source: 'cakhia', name: 'HD TOM', url: otherUrl, headers: { Referer: 'https://ck.example/' } },
    ],
  });
  check('unique server names, one per website', pubDup.streams.length === 1);
  check('streamCount equals streams.length', pubDup.streamCount === pubDup.streams.length);
  check('public streams keep source', pubDup.streams.every((s) => String(s.source || '').trim()));
  check(
    'cakhia JOHAN kept once',
    pubDup.streams.filter((s) => s.source === 'cakhia' && s.url === sameUrl).length === 1
  );
  check(
    'duplicate JOHAN from other sites dropped',
    !pubDup.streams.some((s) => s.source === 'xoilac')
  );
  check(
    'socolive JOHAN dropped as duplicate name',
    !pubDup.streams.some((s) => s.source === 'socolive' && s.url === sameUrl)
  );
  check('second cakhia URL dropped because source already used', !pubDup.streams.some((s) => s.url === otherUrl));
  check('hasStreams', pubDup.hasStreams === true);
  const noHd = toPublicMatch({
    matchId: 'enc_top',
    homeTeam: 'A',
    awayTeam: 'B',
    streamUrl: 'ENC:v1:abc',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8' },
    ],
  });
  check(
    'encrypted streamUrl does not add a generic HD row',
    noHd.streams.length === 1 &&
      noHd.streams[0].name === 'CAKHIA ROY' &&
      noHd.streams[0].source === 'cakhia'
  );
  const roma = toPublicMatch({
    matchId: 'as_roma_inter_milan_20260919',
    streamUrl: 'ENC:v1:roma',
    streams: [
      { name: 'HD', url: 'ENC:v1:roma', active: true },
      { source: 'cakhia', name: 'JOHAN', url: 'ENC:v1:roma', active: true },
      { source: 'xoilac', name: 'JOHAN', url: 'ENC:v1:roma', active: true },
    ],
  });
  const forest = toPublicMatch({
    matchId: 'nottingham_forest_coventry_city_20260919',
    streamUrl: 'ENC:v1:forest',
    streams: [
      { name: 'HD', url: 'ENC:v1:forest', active: true },
      { source: 'cakhia', name: 'ROY', url: 'ENC:v1:forest', active: true },
      { source: 'xoilac', name: 'ROY', url: 'ENC:v1:forest', active: true },
    ],
  });
  check('drops generic HD row', roma.streams.every((s) => s.name !== 'HD') && roma.streamCount === 1);
  check('roma keeps first JOHAN only', roma.streams.map((s) => s.name).join(',') === 'CAKHIA JOHAN');
  check('forest keeps first ROY only', forest.streams.map((s) => s.name).join(',') === 'CAKHIA ROY');
}

console.log('\n=== TEST 12 public stream aggregation (count, clone, manual, multi) ===');
{
  const { mergeStreamLists } = require('../src/services/matchesSyncService');
  const { encryptStreamUrl } = require('../src/utils/streamUrlCrypto');
  const headersA = { Referer: 'https://xl365.domainkqt.cc/', 'User-Agent': 'UA' };
  const headersCakhia = { Referer: 'https://ck.example/', 'User-Agent': 'UA' };
  const headersXoilac = { Referer: 'https://xl.example/', 'User-Agent': 'UA' };
  const headersPhut = { Referer: 'https://phut.example/', 'User-Agent': 'UA' };
  const headersSoco = { Referer: 'https://soco.example/', 'User-Agent': 'UA' };

  const seven = toPublicMatch({
    matchId: 'agg_seven',
    homeTeam: 'A',
    awayTeam: 'B',
    league: 'EPL',
    status: 'LIVE',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'cakhia', name: 'ROY HD', url: 'https://cdn.example/b.m3u8', headers: headersCakhia },
      { source: 'xoilac', name: 'JOHAN', url: 'https://cdn.example/c.m3u8', headers: headersXoilac },
      { source: 'phut', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersPhut },
      { source: 'phut', name: 'ROY HD', url: 'https://cdn.example/d.m3u8', headers: headersPhut },
      { source: 'phut', name: 'ROY 1080P', url: 'https://cdn.example/e.m3u8', headers: headersPhut },
      { source: 'socolive', name: 'JOHAN HD', url: 'https://cdn.example/f.m3u8', headers: headersSoco },
    ],
  });
  check('Test 1: unique names, one per website, max 4', seven.streamCount === 4 && seven.streams.length === 4);
  check(
    'Test 9: streamCount equals streams.length (4)',
    seven.streamCount === seven.streams.length
  );

  const one = toPublicMatch({
    matchId: 'agg_one',
    streams: [{ source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia }],
  });
  check('Test 2: one stream', one.streamCount === 1);

  const sameSourceDup = toPublicMatch({
    matchId: 'agg_dup',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'cakhia', name: 'ROY COPY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
    ],
  });
  check('Test 3: same source + same URL → 1', sameSourceDup.streamCount === 1);

  const crossSource = toPublicMatch({
    matchId: 'agg_cross',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'phut', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersPhut },
    ],
  });
  check('Test 4: duplicate server name across sources → 1', crossSource.streamCount === 1);

  const sameName = toPublicMatch({
    matchId: 'agg_name',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/b.m3u8', headers: headersCakhia },
    ],
  });
  check('Test 5: same name + different URL same website → 1', sameName.streamCount === 1);

  const multiCakhia = toPublicMatch({
    matchId: 'agg_multi',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'cakhia', name: 'ROY HD', url: 'https://cdn.example/b.m3u8', headers: headersCakhia },
    ],
  });
  check('Test 6: one website contributes at most 1 stream', multiCakhia.streamCount === 1);

  const withManual = toPublicMatch({
    matchId: 'agg_manual',
    streams: [
      { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
      { source: 'manual', name: 'ENG HD', url: 'https://cdn.example/manual.m3u8', headers: {}, manualId: 'm1' },
      { source: 'xoilac', name: 'JOHAN', url: 'https://cdn.example/c.m3u8', headers: headersXoilac },
    ],
  });
  check(
    'Test 7: manual remains first',
    withManual.streams[0].source === 'manual' &&
      withManual.streamCount === 3 &&
      withManual.streams.some((s) => s.source === 'cakhia')
  );

  const clonePattern = [
    { source: 'cakhia', name: 'LOGAN', url: 'https://cdn.example/a.m3u8', headers: headersA },
    { source: 'xoilac', name: 'LOGAN', url: 'https://cdn.example/a.m3u8', headers: headersA },
    { source: 'phut', name: 'LOGAN', url: 'https://cdn.example/a.m3u8', headers: headersA },
    { source: 'socolive', name: 'LOGAN', url: 'https://cdn.example/a.m3u8', headers: headersA },
  ];
  const cleaned = toPublicMatch({ matchId: 'agg_clone', streams: clonePattern });
  check(
    'Test 8: historical clone cluster reduced, not kept as 4 copies',
    cleaned.streamCount === 1 && cleaned.streams[0].url.includes('a.m3u8')
  );
  const mergedClones = mergeStreamLists([], clonePattern);
  check(
    'Test 8b: persisted merge also strips expand clones',
    mergedClones.streams.length === 1
  );
  check(
    'Test 8c: duplicate names across sources are not kept just to fill 4 slots',
    crossSource.streamCount === 1
  );

  const key = Buffer.alloc(32, 7);
  const encA = encryptStreamUrl('https://cdn.example/a.m3u8', key);
  const encB = encryptStreamUrl('https://cdn.example/b.m3u8', key);
  const encA2 = encryptStreamUrl('https://cdn.example/a.m3u8', key);
  check('Test 10: ENC:v1 prefix', String(encA).startsWith('ENC:v1:'));
  check('Test 10: same plaintext → same ciphertext', encA === encA2);
  check('Test 10: different plaintext → different ciphertext', encA !== encB);

  const prevKey = process.env.STREAM_URL_ENCRYPTION_KEY;
  process.env.STREAM_URL_ENCRYPTION_KEY = key.toString('hex');
  const delivery = formatMatchesDelivery({
    matches: [
      {
        matchId: 'enc_match',
        homeTeam: 'Home',
        awayTeam: 'Away',
        league: 'EPL',
        status: 'LIVE',
        streams: [
          { source: 'cakhia', name: 'ROY', url: 'https://cdn.example/a.m3u8', headers: headersCakhia },
          { source: 'xoilac', name: 'JOHAN', url: 'https://cdn.example/b.m3u8', headers: headersXoilac },
        ],
      },
    ],
  });
  if (prevKey == null) delete process.env.STREAM_URL_ENCRYPTION_KEY;
  else process.env.STREAM_URL_ENCRYPTION_KEY = prevKey;
  check(
    'Test 10: delivery encrypts each stream independently',
    delivery.matches[0].streams.length === 2 &&
      delivery.matches[0].streams.every((s) => String(s.url).startsWith('ENC:v1:')) &&
      delivery.matches[0].streams[0].url !== delivery.matches[0].streams[1].url &&
      delivery.matches[0].streamCount === 2
  );
  check(
    'Flutter fields kept on public match',
    seven.league === 'EPL' &&
      seven.homeTeam === 'A' &&
      seven.awayTeam === 'B' &&
      seven.streams[0].headers &&
      seven.streams[0].source
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
