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
} = require('../src/utils/streamUrlHelper');
const {
  resolveMatchUrlSearchSlot,
  toUtcUnixSeconds,
} = require('../src/utils/time');
const {
  needsMatchUrlDiscovery,
  applySourceDiscoveryResult,
  finalizeMatchUrlStatus,
  MATCH_URL_MAX_ATTEMPTS,
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
    'https://colatv65.live/truc-tiep/kashima-antlers-vs-nagoya-grampus-luc-1600-ngay-15-08-2026-j374oi0yov3cgqo?houseId=07808742';
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

console.log('\n=== Match URL discovery timing (−30 / −15 / −5) ===');
{
  const kickoffDt = yangonKickoff('2026-08-15T20:00:00');
  const kickSec = toUtcUnixSeconds(kickoffDt.toISO());
  const fixtureBase = {
    matchId: 'timing-1',
    kickoff: kickoffDt.toISO(),
    homeTeam: 'Inter',
    awayTeam: 'Juventus',
  };

  const slotAt = (minsBefore) =>
    resolveMatchUrlSearchSlot(kickoffDt.toISO(), kickSec - minsBefore * 60);

  assert('8a. −30m is t30 slot', slotAt(30)?.id === 't30', JSON.stringify(slotAt(30)));
  assert('9a. −15m is t15 slot', slotAt(15)?.id === 't15', JSON.stringify(slotAt(15)));
  assert('10a. −5m is t5 slot', slotAt(5)?.id === 't5', JSON.stringify(slotAt(5)));
  assert('10b. kickoff is not a Match URL slot', slotAt(0) == null);
  assert('10c. +5m is not a Match URL slot', slotAt(-5) == null);
  assert('10d. −45m is too early', slotAt(45) == null);

  const hit = {
    matchUrl: 'https://cakhiazvm.tv/truc-tiep/inter-vs-juventus-luc-2000-ngay-15-08-2026/',
    status: MATCH_URL_STATUS.CONFIRMED,
    confidence: 100,
    accepted: true,
  };

  // 8. Found at −30m → stop searching
  let m = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    hit,
    { id: 't30' },
    '2026-08-15T19:30:00.000Z'
  );
  assert('8. Match URL found at −30m saved as CONFIRMED', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrl);
  assert(
    '8b. After −30m hit, Today page is not searched again',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 15 * 60) === false
  );

  // 9. Found at −15m (missed −30)
  m = applySourceDiscoveryResult(
    { ...fixtureBase },
    'cakhia',
    null,
    { id: 't30' },
    '2026-08-15T19:30:00.000Z'
  );
  assert('9b. Miss at −30m stays NOT_FOUND and attempts=1', m.matchUrlStatus === MATCH_URL_STATUS.NOT_FOUND && m.matchUrlAttempts === 1);
  assert(
    '9c. −15m slot still due after −30 miss',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 15 * 60) === true
  );
  m = applySourceDiscoveryResult(m, 'cakhia', hit, { id: 't15' }, '2026-08-15T19:45:00.000Z');
  assert('9. Match URL found at −15m', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrlAttempts === 2);

  // 10. Found at −5m
  m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', null, { id: 't30' }, 't1');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't15' }, 't2');
  assert(
    '10e. After two misses, −5m still due',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 5 * 60) === true
  );
  m = applySourceDiscoveryResult(m, 'cakhia', hit, { id: 't5' }, 't3');
  assert('10. Match URL found at −5m', m.matchUrlStatus === MATCH_URL_STATUS.CONFIRMED && m.matchUrlAttempts === 3);

  // 11. Never found
  m = applySourceDiscoveryResult({ ...fixtureBase }, 'cakhia', null, { id: 't30' }, 't1');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't15' }, 't2');
  m = applySourceDiscoveryResult(m, 'cakhia', null, { id: 't5' }, 't3');
  m = finalizeMatchUrlStatus(m, kickSec);
  assert(
    '11. Match URL never found → MATCH_URL_NOT_FOUND after 3 attempts',
    m.matchUrlStatus === MATCH_URL_STATUS.NOT_FOUND &&
      m.matchUrlAttempts === MATCH_URL_MAX_ATTEMPTS &&
      !m.matchUrl,
    JSON.stringify({ status: m.matchUrlStatus, attempts: m.matchUrlAttempts })
  );
  assert(
    '11b. Not stuck unknown — no further Today-page search',
    needsMatchUrlDiscovery(m, 'cakhia', kickSec - 5 * 60) === false
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
