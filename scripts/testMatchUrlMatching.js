/**
 * Fixture → streaming Match URL matching tests.
 * Run: node scripts/testMatchUrlMatching.js
 */
  const { DateTime } = require('luxon');
const { Normalizer } = require('../src/utils/normalize');
const teamsDoc = require('../config/teams.json');
const {
  parseStreamUrl,
  scoreStreamMatch,
  MATCH_URL_STATUS,
  compactNamesFuzzyMatch,
  compareTeamIdentity,
} = require('../src/utils/streamUrlHelper');
const {
  resolveMatchUrlSearchSlot,
  resolveMatchUrlLiveSlot,
  toUtcUnixSeconds,
} = require('../src/utils/time');
const {
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  finalizeMatchUrlStatus,
} = require('../src/utils/matchUrlDiscovery');
const { MultiMatchScraper } = require('../src/services/multiMatchScraper');

const normalizer = new Normalizer({ teams: teamsDoc.teams || [] });
const scraper = new MultiMatchScraper({
  sourceName: 'cakhia',
  normalizer,
});

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

function yangonKickoff(isoLocal) {
  return DateTime.fromISO(isoLocal, { zone: ZONE });
}

function fotmobFromParsed(parsed, extra = {}) {
  const yangon = DateTime.fromISO(parsed.yangonIso, { setZone: true }).setZone(ZONE);
  return {
    matchId: extra.matchId || 'fotmob-1',
    fotmobId: extra.fotmobId || 12345,
    leagueId: extra.leagueId || 55,
    league: extra.league || 'Serie A',
    leagueName: extra.league || 'Serie A',
    homeTeam: extra.homeTeam,
    awayTeam: extra.awayTeam,
    date: yangon.toFormat('yyyy-MM-dd'),
    time: yangon.toFormat('HH:mm'),
    kickoff: yangon.toISO(),
    matchDate: yangon.toFormat('yyyy-MM-dd'),
    kickoffTime: yangon.toFormat('HH:mm'),
    originalNames: {
      fotmob: {
        league: extra.rawLeague || extra.league || 'Serie A',
        leagueId: extra.leagueId || 55,
        homeTeam: extra.homeTeam,
        awayTeam: extra.awayTeam,
      },
    },
  };
}

function scoreUrl(fotmob, url, entryExtra = {}) {
  const parsed = parseStreamUrl(url);
  return scoreStreamMatch(
    fotmob,
    { ...parsed, url, ...entryExtra },
    { normalizer }
  );
}

console.log('\n=== Match URL parsing ===');
{
  const withId =
    'https://mitomtm.cc/truc-tiep/kashima-antlers-vs-nagoya-grampus-luc-1600-ngay-15-08-2026';
  const parsed = parseStreamUrl(withId);
  assert('6. URL with random ID parses teams/date/time', parsed.ok === true, JSON.stringify({
    home: parsed.homeTeam,
    away: parsed.awayTeam,
    date: parsed.date,
    time: parsed.time,
    error: parsed.error,
  }));
  assert('6b. random ID not kept as team name', !/j374/i.test(parsed.homeTeam + parsed.awayTeam));
  assert('6c. houseId query ignored', parsed.ok && parsed.time === '16:00');
}

{
  const withQ =
    'https://cakhiazvm.tv/truc-tiep/nu-northern-tigers-vs-nu-maca-searle-luc-1530-ngay-15-08-2026/?utm_source=x&houseId=1';
  const parsed = parseStreamUrl(withQ);
  assert('7. URL with query parameters parses', parsed.ok === true, parsed.error);
  assert('7b. home/away from slug', /northern tigers/i.test(parsed.homeTeam) && /maca searle/i.test(parsed.awayTeam));
}

console.log('\n=== Matching identity (home + away + date + kickoff) ===');
{
  const url =
    'https://socolivepp.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    league: 'Serie A',
  });
  const r = scoreUrl(fotmob, url);
  assert('1. Exact home/away match → CONFIRMED', r.accepted && r.status === MATCH_URL_STATUS.CONFIRMED, JSON.stringify({
    score: r.score,
    status: r.status,
    reason: r.reason,
    yangon: parsed.yangonDate,
    yangonTime: parsed.yangonTime,
  }));
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/inter-vs-ac-milan-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    league: 'Serie A',
  });
  const r = scoreUrl(fotmob, url);
  assert('2. Different away team → REJECT', !r.accepted && r.reason === 'teams_mismatch', r.reason);
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/ac-milan-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    league: 'Serie A',
  });
  const r = scoreUrl(fotmob, url);
  assert('3. Different home team → REJECT', !r.accepted && r.reason === 'teams_mismatch', r.reason);
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
  });
  const nextDay = DateTime.fromISO(fotmob.kickoff, { setZone: true }).plus({ days: 1 });
  fotmob.kickoff = nextDay.toISO();
  fotmob.date = nextDay.toFormat('yyyy-MM-dd');
  const r = scoreUrl(fotmob, url);
  assert('4. Same teams but different date → REJECT', !r.accepted && r.reason === 'date_mismatch', r.reason);
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
  });
  const shifted = DateTime.fromISO(fotmob.kickoff, { setZone: true }).plus({ minutes: 60 });
  fotmob.kickoff = shifted.toISO();
  fotmob.time = shifted.toFormat('HH:mm');
  const r = scoreUrl(fotmob, url);
  assert('5. Same teams but different kickoff time → REJECT', !r.accepted && r.reason === 'time_mismatch', r.reason);
}

{
  const url =
    'https://xoilacxtn.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    league: 'Serie A',
  });
  const r = scoreUrl(fotmob, url, { league: 'English Premier League', country: 'ENG' });
  assert(
    '12. Incorrect streaming league still CONFIRMED when teams+date+time match',
    r.accepted && r.status === MATCH_URL_STATUS.CONFIRMED,
    JSON.stringify({ status: r.status, score: r.score, league: r.league })
  );
}

{
  const url =
    'https://cakhiazvm.tv/truc-tiep/man-utd-vs-liverpool-luc-1930-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Manchester United',
    awayTeam: 'Liverpool',
    league: 'English Premier League (EPL)',
  });
  const r = scoreUrl(fotmob, url);
  assert(
    '13. Team aliases (Man Utd / Manchester United)',
    r.accepted && r.status === MATCH_URL_STATUS.CONFIRMED,
    JSON.stringify({ score: r.score, status: r.status, reason: r.reason, home: r.home, away: r.away })
  );
}

{
  const url =
    'https://xoilacxtn.tv/truc-tiep/malaysia-vs-viet-nam-luc-2000-ngay-16-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Malaysia',
    awayTeam: 'Vietnam',
    league: 'ASEAN Championship',
  });
  fotmob.kickoff = yangonKickoff('2026-08-16T19:30:00').toISO();
  fotmob.date = '2026-08-16';
  fotmob.time = '19:30';
  const r = scoreUrl(fotmob, url);
  assert('13b. Viet Nam slug matches FotMob Vietnam (ICT 20:00 = Yangon 19:30)',
    r.accepted,
    JSON.stringify({ reason: r.reason, away: r.away, yangon: parsed.yangonTime })
  );
}

{
  const url =
    'https://cakhiazvm.tv/truc-tiep/thai-lan-vs-singapore-luc-2000-ngay-18-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Thailand',
    awayTeam: 'Singapore',
    league: 'ASEAN Championship',
  });
  fotmob.kickoff = yangonKickoff('2026-08-18T19:30:00').toISO();
  fotmob.date = '2026-08-18';
  fotmob.time = '19:30';
  const r = scoreUrl(fotmob, url);
  assert(
    '13e. Thai Lan slug matches FotMob Thailand',
    r.accepted,
    JSON.stringify({ reason: r.reason, home: r.home, yangon: parsed.yangonTime })
  );
}

{
  assert('13f. fuzzy: Thai Lan ↔ Thailand', compactNamesFuzzyMatch('thai lan', 'thailand'));
  assert('13g. fuzzy: Singapura ↔ Singapore', compactNamesFuzzyMatch('singapura', 'singapore'));
  assert('13h. fuzzy rejects Milan ↔ Milano', !compactNamesFuzzyMatch('milan', 'milano'));
  assert('13i. fuzzy rejects Australia ↔ Austria', !compactNamesFuzzyMatch('australia', 'austria'));
  assert('13j. fuzzy rejects Chelsea ↔ Cheltenham', !compactNamesFuzzyMatch('chelsea', 'cheltenham'));
  assert('13k. fuzzy rejects Inter Milan ↔ Milan', !compactNamesFuzzyMatch('inter milan', 'milan'));
  const emptyNormalizer = new Normalizer({ teams: [] });
  const thai = compareTeamIdentity('Thailand', 'Thai Lan', emptyNormalizer);
  const sgp = compareTeamIdentity('Singapore', 'Singapura', emptyNormalizer);
  assert('13l. compareTeamIdentity Thai Lan without teams.json', thai.score > 0, JSON.stringify(thai));
  assert('13m. compareTeamIdentity Singapura without teams.json', sgp.score > 0, JSON.stringify(sgp));
  const thailande = compareTeamIdentity('Thailand', 'Thailande', emptyNormalizer);
  assert(
    '13o. unlisted spelling Thailande uses fuzzy fallback',
    thailande.kind === 'fuzzy' && thailande.score > 0,
    JSON.stringify(thailande)
  );
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/thai-lan-vs-singapura-luc-2000-ngay-18-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Thailand',
    awayTeam: 'Singapore',
    league: 'ASEAN Championship',
  });
  fotmob.kickoff = yangonKickoff('2026-08-18T19:30:00').toISO();
  fotmob.date = '2026-08-18';
  fotmob.time = '19:30';
  const r = scoreStreamMatch(
    fotmob,
    { ...parsed, url },
    { normalizer: new Normalizer({ teams: [] }) }
  );
  assert(
    '13n. Thai Lan vs Singapura URL matches FotMob without teams.json',
    r.accepted,
    JSON.stringify({ reason: r.reason, home: r.home, away: r.away })
  );
}

{
  const url =
    'https://xoilacxtn.tv/truc-tiep/fc-basel-1893-vs-barcelona-luc-2130-ngay-16-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Basel',
    awayTeam: 'Barcelona',
    league: 'Club Friendlies',
  });
  fotmob.kickoff = yangonKickoff('2026-08-16T21:00:00').toISO();
  fotmob.date = '2026-08-16';
  fotmob.time = '21:00';
  const r = scoreUrl(fotmob, url);
  assert(
    '13c. Basel matches Fc Basel 1893',
    r.accepted,
    JSON.stringify({ reason: r.reason, home: r.home })
  );
}

{
  const url =
    'https://cakhiazvm.tv/truc-tiep/nottingham-forest-vs-brest-luc-2000-ngay-16-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Nottm Forest',
    awayTeam: 'Brest',
    league: 'Club Friendlies',
  });
  const r = scoreUrl(fotmob, url);
  assert(
    '13d. Nottm Forest vs Nottingham Forest slug matches',
    r.accepted,
    JSON.stringify({ reason: r.reason, home: r.home, away: r.away, status: r.status })
  );
}

{
  const url =
    'https://socolivepp.tv/truc-tiep/jagiellonia-vs-fc-saburtalo-luc-2300-ngay-20-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, {
    homeTeam: 'Jagiellonia Białystok',
    awayTeam: 'Iberia 1999',
    league: 'UEFA Europa League Qualification',
  });
  fotmob.kickoff = yangonKickoff('2026-08-20T22:30:00').toISO();
  fotmob.date = '2026-08-20';
  fotmob.time = '22:30';
  const r = scoreUrl(fotmob, url);
  assert(
    '13p. Socolive Jagiellonia vs Saburtalo matches FotMob Iberia 1999',
    r.accepted,
    JSON.stringify({
      reason: r.reason,
      home: r.home,
      away: r.away,
      yangon: parsed.yangonTime,
      status: r.status,
    })
  );
  const emptyNormalizer = new Normalizer({ teams: [] });
  const jaga = compareTeamIdentity('Jagiellonia Białystok', 'Jagiellonia', emptyNormalizer);
  const milan = compareTeamIdentity('Inter Milan', 'Milan', emptyNormalizer);
  assert(
    '13q. Jagiellonia short slug matches without teams.json',
    jaga.score > 0,
    JSON.stringify(jaga)
  );
  assert(
    '13r. Inter Milan still does not match bare Milan',
    milan.score === 0,
    JSON.stringify(milan)
  );
}

console.log('\n=== Multiple matches at the same time ===');
{
  const kick = yangonKickoff('2026-08-15T19:30:00');
  const entries = [
    parseStreamUrl(
      'https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/'
    ),
    parseStreamUrl(
      'https://cakhiazvm.tv/truc-tiep/ac-milan-vs-napoli-luc-2000-ngay-15-08-2026/'
    ),
  ].map((p, i) => ({
    ...p,
    url: i === 0
      ? 'https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/'
      : 'https://cakhiazvm.tv/truc-tiep/ac-milan-vs-napoli-luc-2000-ngay-15-08-2026/',
  }));

  const fixtures = [
    fotmobFromParsed(entries[0], {
      matchId: 'inter-juve',
      homeTeam: 'Inter',
      awayTeam: 'Juventus',
    }),
    fotmobFromParsed(entries[1], {
      matchId: 'milan-napoli',
      homeTeam: 'AC Milan',
      awayTeam: 'Napoli',
    }),
  ];
  // Force identical FotMob kickoff (same Yangon instant)
  fixtures[0].kickoff = kick.toISO();
  fixtures[0].date = kick.toFormat('yyyy-MM-dd');
  fixtures[1].kickoff = kick.toISO();
  fixtures[1].date = kick.toFormat('yyyy-MM-dd');

  const matched = scraper.matchFixturesToEntries(fixtures, entries);
  const ids = matched.map((m) => m.matchId).sort();
  assert(
    '14. Multiple matches at the same time get distinct URLs',
    matched.length === 2 && ids[0] === 'inter-juve' && ids[1] === 'milan-napoli',
    JSON.stringify(matched.map((m) => ({ id: m.matchId, url: m.matchUrl, score: m.confidence })))
  );

  const wrong = scraper.matchFixturesToEntries(
    [fixtures[0]],
    [entries[1]]
  );
  assert('14b. Does not assign the other same-time URL', wrong.length === 0);
}

console.log('\n=== Match URL discovery timing (−60 / −45 / −30) ===');
{
  const kickoffDt = yangonKickoff('2026-08-15T20:00:00');
  const kickSec = toUtcUnixSeconds(kickoffDt.toISO());
  const fixtureBase = {
    matchId: 'timing-1',
    kickoff: kickoffDt.toISO(),
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
    kickoffTime: '20:00',
  };

  const slotAt = (minsBefore) =>
    resolveMatchUrlSearchSlot(kickoffDt.toISO(), kickSec - minsBefore * 60);

  assert('8a0. −60m is t60 slot', slotAt(60)?.id === 't60', JSON.stringify(slotAt(60)));
  assert('8a. −45m is t45 slot', slotAt(45)?.id === 't45', JSON.stringify(slotAt(45)));
  assert('9a. −30m is t30 slot', slotAt(30)?.id === 't30', JSON.stringify(slotAt(30)));
  assert('10a. −15m still in t30 (final Match URL window)', slotAt(15)?.id === 't30', JSON.stringify(slotAt(15)));
  assert('10b. kickoff is not a pre-kickoff Match URL slot', slotAt(0) == null);
  assert('10c. +5m is not a pre-kickoff Match URL slot', slotAt(-5) == null);
  assert(
    '10b2. kickoff opens live Match URL catch-up',
    resolveMatchUrlLiveSlot(kickoffDt.toISO(), kickSec)?.id === 'tLive'
  );
  assert(
    '10c2. +5m still in live Match URL catch-up',
    resolveMatchUrlLiveSlot(kickoffDt.toISO(), kickSec + 5 * 60)?.id === 'tLive'
  );
  assert(
    '10c3. +121m live Match URL catch-up has stopped',
    resolveMatchUrlLiveSlot(kickoffDt.toISO(), kickSec + 121 * 60) == null
  );
  assert('10d. −90m is not a Match URL slot', slotAt(90) == null, JSON.stringify(slotAt(90)));
  assert(
    '10d2. Cloudflare script mention is not a block when truc-tiep links exist',
    scraper.looksBlockedOrEmpty(
      `${'x'.repeat(6000)} cloudflare truc-tiep/malaysia-vs-viet-nam-luc-2000-ngay-16-08-2026/`
    ) === false
  );

  const hit = {
    matchUrl: 'https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/',
    status: MATCH_URL_STATUS.CONFIRMED,
    confidence: 100,
    accepted: true,
  };

  let m = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    hit,
    { id: 't60', attempt: 1, maxInclusive: 60 },
    '2026-08-15T19:00:00.000Z'
  );
  assert('1. Match URL found at −60m saved as CONFIRMED', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrl);
  assert(
    '1b. After −60m hit, Today page is not searched again',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 45 * 60) === false
  );
  assert('1c. matchUrlSource is cakhia', m.matchUrlSource === 'cakhia');

  m = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    null,
    { id: 't60', attempt: 1, maxInclusive: 60 },
    '2026-08-15T19:00:00.000Z'
  );
  assert('2a. Miss at −60m stays PENDING and attempts=1', m.matchUrlStatus === MATCH_URL_STATUS.PENDING && m.matchUrlAttempts === 1);
  assert(
    '2b. −45m slot still due after −60 miss',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 45 * 60) === true
  );
  m = applySourceDiscoveryResult(m, 'cakhia', hit, { id: 't45', attempt: 2, maxInclusive: 45 }, '2026-08-15T19:15:00.000Z');
  assert('2. Match URL found at −45m', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrlAttempts === 2);

  m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', null, { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't45', attempt: 2 }, 't2');
  assert(
    '3a. After two misses, −30m still due',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 30 * 60) === true
  );
  m = applySourceDiscoveryResult(m, 'cakhia', hit, { id: 't30', attempt: 3 }, 't3');
  assert('3. Match URL found at −30m', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrlAttempts === 3);

  m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', null, { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't45', attempt: 2 }, 't2');
  m = applySourceDiscoveryResult(
    m,
    'cakhia',
    null,
    { id: 't30', attempt: 3 },
    new Date((kickSec - 30 * 60) * 1000).toISOString()
  );
  assert(
    '4b. Right after the −30 miss, cooldown blocks another Today-page scrape',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 30 * 60) === false
  );
  m = finalizeMatchUrlStatus(m, kickSec);
  assert(
    '4. After 3 misses, kickoff stays SEARCHING for live catch-up',
    m.matchUrlStatus === MATCH_URL_STATUS.SEARCHING && !m.matchUrl,
    JSON.stringify({ status: m.matchUrlStatus, attempts: m.matchUrlAttempts })
  );
  assert(
    '4f. Live window retries Match URL after pre-kickoff FAILED',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec) === true
  );
  m = applySourceDiscoveryResult(
    m,
    'cakhia',
    hit,
    { id: 'tLive', live: true, postKickoff: true },
    '2026-08-15T20:01:00.000Z'
  );
  assert(
    '4g. Match URL found on live catch-up',
    m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && Boolean(m.matchUrl)
  );

  m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', null, { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't45', attempt: 2 }, 't2');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't30', attempt: 3 }, 't3');
  m = finalizeMatchUrlStatus(m, kickSec + 121 * 60);
  assert(
    '4h. Match URL FAILED after live window closes',
    m.matchUrlStatus === MATCH_URL_STATUS.FAILED && !m.matchUrl
  );

  const leftover = {
    ...fixtureBase,
    matchUrlSearch: {
      slotsDone: { tEarly: true, t30: true },
      sources: {
        cakhia: {
          matchUrl: null,
          status: MATCH_URL_STATUS.PENDING,
          attempts: 1,
          lastAttemptAt: new Date((kickSec - 26 * 60) * 1000).toISOString(),
          slotsDone: { tEarly: true, t30: true },
          confidence: 0,
        },
      },
    },
  };
  assert(
    '4c. Leftover attempts after tEarly/t30 still search at −20m',
    needsMatchUrlDiscovery(leftover, 'cakhia', kickSec - 20 * 60) === true
  );
  leftover.matchUrlSearch.sources.cakhia.lastAttemptAt = new Date(
    (kickSec - 21 * 60) * 1000
  ).toISOString();
  assert(
    '4d. tEarly leftover reopens t30 immediately (no cooldown trap)',
    needsMatchUrlDiscovery(leftover, 'cakhia', kickSec - 20 * 60) === true
  );

  const genuineT30 = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    null,
    { id: 't30', attempt: 3, maxInclusive: 30 },
    new Date((kickSec - 21 * 60) * 1000).toISOString()
  );
  assert(
    '4e. Genuine t30 miss still uses cooldown',
    needsMatchUrlDiscovery(genuineT30, 'cakhia', kickSec - 20 * 60) === false
  );

  const threeMiss = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    null,
    { id: 't60', attempt: 1 },
    new Date((kickSec - 50 * 60) * 1000).toISOString()
  );
  const threeMiss2 = applySourceDiscoveryResult(
    threeMiss,
    'cakhia',
    null,
    { id: 't45', attempt: 2 },
    new Date((kickSec - 40 * 60) * 1000).toISOString()
  );
  const threeMiss3 = applySourceDiscoveryResult(
    threeMiss2,
    'cakhia',
    null,
    { id: 't30', attempt: 3 },
    new Date((kickSec - 28 * 60) * 1000).toISOString()
  );
  assert(
    '4i. After 3 misses, last pre-kickoff window retries once cooldown elapses',
    threeMiss3.matchUrlSearch.sources.cakhia.status === MATCH_URL_STATUS.FAILED &&
      needsMatchUrlDiscovery(threeMiss3, 'cakhia', kickSec - 20 * 60) === true
  );
  const mixed = applySourceDiscoveryResult(
    threeMiss3,
    'xoilac',
    null,
    { id: 't30', attempt: 1 },
    new Date((kickSec - 20 * 60) * 1000).toISOString()
  );
  assert(
    '4j. Overall status stays PENDING while another source is still searching',
    mixed.matchUrlStatus === MATCH_URL_STATUS.PENDING &&
      mixed.matchUrlSearch.sources.xoilac.status === MATCH_URL_STATUS.PENDING
  );
}

console.log('\n=== Independent sources + duplicate candidates ===');
{
  const kickoffDt = yangonKickoff('2026-08-15T20:00:00');
  const kickSec = toUtcUnixSeconds(kickoffDt.toISO());
  const fixtureBase = {
    matchId: 'src-ind',
    kickoff: kickoffDt.toISO(),
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
  };
  const hit = (host) => ({
    matchUrl: `https://${host}/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/`,
    status: MATCH_URL_STATUS.CONFIRMED,
    confidence: 100,
    accepted: true,
  });

  let m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', hit('cakhiazvm.tv'), { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'mitomtm', null, { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'xoilac', null, { id: 't60', attempt: 1 }, 't1');
  m = applySourceDiscoveryResult(m, 'socolive', hit('socolivepp.tv'), { id: 't60', attempt: 1 }, 't1');
  assert(
    '14. Found sources stop; unresolved sources still due at −45m',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 45 * 60) === false &&
      needsMatchUrlDiscovery(m, 'socolive', kickSec - 45 * 60) === false &&
      needsMatchUrlDiscovery(m, 'mitomtm', kickSec - 45 * 60) === true &&
      needsMatchUrlDiscovery(m, 'xoilac', kickSec - 45 * 60) === true
  );

  m = applySourceDiscoveryResult(m, 'xoilac', null, { id: 't45', attempt: 2 }, 't2');
  m = applySourceDiscoveryResult(m, 'xoilac', null, { id: 't30', attempt: 3 }, 't3');
  assert(
    '15. One source FAILED while others remain FOUND',
    m.matchUrlSearch.sources.xoilac.status === MATCH_URL_STATUS.FAILED &&
      m.matchUrlSearch.sources.cakhia.status === MATCH_URL_STATUS.CONFIRMED &&
      Boolean(m.matchUrl)
  );

  const entries = [
    parseStreamUrl('https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/'),
    parseStreamUrl('https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/'),
    parseStreamUrl('https://cakhiazvm.tv/truc-tiep/ac-milan-vs-napoli-luc-2000-ngay-15-08-2026/'),
  ].map((p, i) => ({
    ...p,
    url:
      i === 2
        ? 'https://cakhiazvm.tv/truc-tiep/ac-milan-vs-napoli-luc-2000-ngay-15-08-2026/'
        : 'https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/',
  }));
  const fot = fotmobFromParsed(entries[0], {
    matchId: 'inter-juve-dup',
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
  });
  const matched = scraper.matchFixturesToEntries([fot], entries);
  assert('12. Duplicate candidate URLs assign once', matched.length === 1 && matched[0].matchUrl.includes('inter-vs-juventus'));
}

console.log('\n=== Transient error does not burn the attempt ===');
{
  const { isTransientDiscoverError, matchUrlJobKey } = require('../src/utils/matchUrlDiscovery');
  assert('16a. timeout is transient', isTransientDiscoverError({ code: 'ETIMEDOUT', message: 'timeout' }) === true);
  assert('16b. DNS is transient', isTransientDiscoverError({ code: 'ENOTFOUND', message: 'getaddrinfo' }) === true);
  assert('16c. 403 is transient', isTransientDiscoverError(new Error('Request failed with status code 403')) === true);
  assert('16d. empty today page is a completed miss', isTransientDiscoverError(new Error('empty_match_links')) === false);
  assert(
    '18. job key is matchId+source+match-url+attempt',
    matchUrlJobKey('match123', 'soco', { attempt: 1 }) === 'match123:soco:match-url:attempt1'
  );
}

console.log('\n=== Empty Today page / domain-agnostic matching ===');
{
  const empty = scraper.extractMatchEntries('<html><body>no matches</body></html>', 'https://example-new-domain.tv');
  assert('17. Empty Today page yields no candidates', empty.length === 0);
  const url = 'https://brand-new-domain.example/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/';
  const parsed = parseStreamUrl(url);
  const fotmob = fotmobFromParsed(parsed, { homeTeam: 'Inter', awayTeam: 'Juventus' });
  const r = scoreUrl(fotmob, url);
  assert(
    '18b. Matcher does not hard-code source domains',
    parsed.ok && r.accepted,
    JSON.stringify({ ok: parsed.ok, reason: r.reason, host: parsed })
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
