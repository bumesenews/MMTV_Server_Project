/**
 * Football results parser.
 * Run: node scripts/testResultsParse.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const { parseResultsPayload, buildResultsDelivery, resolveResultsSource } = require('../src/services/results/resultsSource');
const { createResultsPipeline } = require('../src/services/results/resultsPipeline');
const { filterResultsToMatchFixtures } = require('../src/services/results/resultsMatchFilter');
const { Normalizer } = require('../src/utils/normalize');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const packed = {
  competitions: '56ypq3nh01nmd7o^Egyptian Premier League^EGY Premier League^1^44',
  matches: [
    'n54qllhnog3vqvy^1792504800^0^56ypq3nh01nmd7o^season^8^homeid^Asyut Petroleum^0^0^0^2^4^0^0^^awayid^Zamalek^1^1^0^1^6^0^0^^',
    'later^1792508400^0^56ypq3nh01nmd7o^season^1^homeid^Not Started Home^0^0^0^0^0^0^0^^awayid^Not Started Away^0^0^0^0^0^0^0^^',
    'live^1792505000^0^56ypq3nh01nmd7o^season^4^homeid^Live Home^2^1^0^0^3^0^0^^awayid^Live Away^2^0^0^0^1^0^0^^',
  ].join('!!'),
};

const rows = parseResultsPayload(packed);
assert('finished score kept', rows.some((row) => row.homeTeam === 'Asyut Petroleum' && row.homeScore === 0 && row.awayScore === 1 && row.status === 'FT'));
const asyut = rows.find((row) => row.id === 'n54qllhnog3vqvy');
assert(
  'team crest urls come from the result team ids',
  asyut.homeLogo === 'https://imgts.sportpulseapiz.com/football/team/homeid/image/small' &&
    asyut.awayLogo === 'https://imgts.sportpulseapiz.com/football/team/awayid/image/small'
);
assert('league name attached', rows.find((row) => row.id === 'n54qllhnog3vqvy')?.competition === 'Egyptian Premier League');
assert('not-started match omitted', !rows.some((row) => row.homeTeam === 'Not Started Home'));
assert('live score kept', rows.some((row) => row.status === '2H' && row.homeScore === 2 && row.awayScore === 2));
const delivery = buildResultsDelivery(rows, { generatedAt: '2026-10-21T08:00:00.000+06:30' });
assert('delivery count', delivery.count === 2 && delivery.timezone === 'Asia/Yangon');
const custom = resolveResultsSource({
  domains: ['https://scores.example/kqbd/'],
  paths: { page: 'https://scores.example/kqbd/', api: 'https://api.example/football/match/recent' },
  selectors: { card: ['.score-row', '.match'] },
  attrs: { href: ['data-href'], src: ['data-src', 'src'] },
  logoUrl: 'https://cdn.example/team/{id}.png',
});
assert(
  'admin results source settings',
  custom.page === 'https://scores.example/kqbd/' &&
    custom.api === 'https://api.example/football/match/recent/' &&
    custom.selectors.card.join(',') === '.score-row,.match' &&
    custom.attrs.href.join(',') === 'data-href' &&
    custom.attrs.src.join(',') === 'data-src,src' &&
    custom.logoTemplate === 'https://cdn.example/team/{id}.png'
);

const normalizer = new Normalizer({
  teams: [{ standardName: 'Manchester City', aliases: ['Man City'] }],
});
const aligned = filterResultsToMatchFixtures(
  {
    count: 2,
    results: [
      {
        id: 'today',
        date: '2026-10-21',
        homeTeam: 'Man City',
        awayTeam: 'Arsenal',
        homeLogo: 'https://imgts.sportpulseapiz.com/football/team/city/image/small',
        awayLogo: 'https://imgts.sportpulseapiz.com/football/team/arsenal/image/small',
        homeScore: 2,
        awayScore: 1,
        status: 'FT',
        kickoff: '2026-10-21T13:00:00.000Z',
        competition: 'Premier League',
      },
      {
        id: 'other-day',
        date: '2026-10-19',
        homeTeam: 'Man City',
        awayTeam: 'Arsenal',
        homeScore: 0,
        awayScore: 0,
        status: 'FT',
        kickoff: '2026-10-19T13:00:00.000Z',
        competition: 'Premier League',
      },
    ],
  },
  [
    {
      homeTeam: 'Arsenal',
      awayTeam: 'Manchester City',
      homeLogo: 'arsenal.png',
      awayLogo: 'city.png',
      kickoff: '2026-10-21T13:00:00.000+06:30',
    },
  ],
  normalizer
);
assert('every result stays in the feed', aligned.count === 2);
const todayRow = aligned.results.find((row) => row.id === 'today');
const otherDay = aligned.results.find((row) => row.id === 'other-day');
assert(
  'same-day fixture supplies the team names and logos',
  todayRow.homeTeam === 'Manchester City' &&
    todayRow.awayTeam === 'Arsenal' &&
    todayRow.homeLogo === 'city.png' &&
    todayRow.awayLogo === 'arsenal.png' &&
    todayRow.homeScore === 2
);
assert(
  'a club in matches.json keeps its logo on another day',
  otherDay.homeTeam === 'Manchester City' &&
    otherDay.homeLogo === 'city.png' &&
    otherDay.awayLogo === 'arsenal.png'
);

async function main() {
  let fetched = 0;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-test-'));
  const deferred = await createResultsPipeline({
    env: { RESULTS_STATE_PATH: path.join(stateDir, 'status.json') },
    fetchDay: async () => {
      fetched += 1;
      return [];
    },
  }).run({ isHigherPriorityBusy: () => true });
  assert('busy football job defers results', deferred.deferred === true && fetched === 0, deferred.reason);

  const kept = [];
  const windowed = await createResultsPipeline({
    env: { RESULTS_STATE_PATH: path.join(stateDir, 'window.json') },
    cache: { saveDeliveryBundle() {}, getDelivery() { return null; } },
    fetchDay: async () => [
      { id: 'old', date: '2026-10-19', kickoff: '2026-10-19T10:00:00.000Z', homeTeam: 'Old', awayTeam: 'Side', homeScore: 1, awayScore: 0, status: 'FT', competition: 'Cup' },
      { id: 'keep', date: '2026-10-20', kickoff: '2026-10-20T14:00:00.000Z', homeTeam: 'Asyut Petroleum', awayTeam: 'Zamalek', homeScore: 0, awayScore: 1, status: 'FT', competition: 'Egyptian Premier League' },
      { id: 'stranger', date: '2026-10-20', kickoff: '2026-10-20T16:00:00.000Z', homeTeam: 'Other', awayTeam: 'Club', homeLogo: 'https://imgts.sportpulseapiz.com/football/team/other/image/small', awayLogo: 'https://imgts.sportpulseapiz.com/football/team/club/image/small', homeScore: 3, awayScore: 0, status: 'FT', competition: 'Cup' },
    ],
  }).run({
    now: DateTime.fromISO('2026-10-21T08:00:00.000+06:30', { setZone: true }),
    matches: [
      {
        homeTeam: 'Zamalek',
        awayTeam: 'Asyut Petroleum',
        homeLogo: 'zamalek.png',
        awayLogo: null,
        kickoff: '2026-10-20T14:00:00.000Z',
      },
    ],
  });
  kept.push(...(windowed.delivery?.results || []));
  const keep = kept.find((row) => row.id === 'keep');
  const stranger = kept.find((row) => row.id === 'stranger');
  assert('older than yesterday is omitted', kept.length === 2 && keep && stranger, String(kept.map((row) => row.id)));
  assert(
    'fixture result uses the matches.json logo',
    keep.homeLogo === null && keep.awayLogo === 'zamalek.png' && keep.homeTeam === 'Asyut Petroleum'
  );
  assert(
    'a result outside matches.json is still shown',
    stranger.homeTeam === 'Other' &&
      stranger.homeLogo === 'https://imgts.sportpulseapiz.com/football/team/other/image/small' &&
      stranger.awayLogo === 'https://imgts.sportpulseapiz.com/football/team/club/image/small'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
