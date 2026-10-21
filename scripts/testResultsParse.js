/**
 * Football results parser.
 * Run: node scripts/testResultsParse.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const { parseResultsPayload, buildResultsDelivery } = require('../src/services/results/resultsSource');
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
assert('league name attached', rows.find((row) => row.id === 'n54qllhnog3vqvy')?.competition === 'Egyptian Premier League');
assert('not-started match omitted', !rows.some((row) => row.homeTeam === 'Not Started Home'));
assert('live score kept', rows.some((row) => row.status === '2H' && row.homeScore === 2 && row.awayScore === 2));
const delivery = buildResultsDelivery(rows, { generatedAt: '2026-10-21T08:00:00.000+06:30' });
assert('delivery count', delivery.count === 2 && delivery.timezone === 'Asia/Yangon');

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
assert('results keep the matches.json fixture only', aligned.count === 1 && aligned.results[0].id === 'today');
assert(
  'team names and logos come from the fixture',
  aligned.results[0].homeTeam === 'Manchester City' &&
    aligned.results[0].awayTeam === 'Arsenal' &&
    aligned.results[0].homeLogo === 'city.png' &&
    aligned.results[0].awayLogo === 'arsenal.png' &&
    aligned.results[0].homeScore === 2
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
      { id: 'stranger', date: '2026-10-20', kickoff: '2026-10-20T16:00:00.000Z', homeTeam: 'Other', awayTeam: 'Club', homeScore: 3, awayScore: 0, status: 'FT', competition: 'Cup' },
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
  assert('older than yesterday is omitted', kept.length === 1 && kept[0].id === 'keep', String(kept.length));
  assert(
    'kept result uses the matches.json logo',
    kept[0].homeLogo === null && kept[0].awayLogo === 'zamalek.png' && kept[0].homeTeam === 'Asyut Petroleum'
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
