/**
 * PredictZ tips HTML parser tests.
 * Run: node scripts/testTipsParse.js
 */
const {
  parseTipsHtml,
  parseHeadingDate,
  isUsableTipsDay,
  resolveTipsDay,
} = require('../src/sources/tips');
const { formatTipsDelivery } = require('../src/services/deliveryFormats');
const { filterTipsToMatchFixtures } = require('../src/services/tipsMatchFilter');
const { Normalizer } = require('../src/utils/normalize');

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

const html = `
<html><body>
<h1>Football Tips Tonight - Sunday, August 16th, 2026</h1>
<div class="pttable">
  <div class="pttrnh ptttl"><div class="pttd ptlg"><h2>Spain La Liga Tips</h2></div></div>
  <div class="pttr ptcnt">
    <div class="pttd ptmobh">Espanyol</div>
    <div class="pttd ptlast5h"><div class="ptlast5boxh"><div class="nred ptneonboxsml2">L</div><div class="ngreen ptneonboxsml2">W</div></div></div>
    <div class="pttd ptprd"><div class="nyellow ptpredboxsml">Draw 2-2</div></div>
    <div class="pttd ptmoba">Levante</div>
    <div class="pttd ptlast5a"><div class="ptlast5boxa"><div class="nred ptneonboxsml2">L</div></div></div>
    <div class="pttd ptgame"><a href="https://www.predictz.com/predictions/spain/la-liga/1202539/">Espanyol v Levante</a></div>
    <div class="pttd ptodds"><a>2.15</a></div>
    <div class="pttd ptodds"><a>3.20</a></div>
    <div class="pttd ptodds"><a>3.60</a></div>
  </div>
  <div class="pttr ptcnt">
    <div class="pttd ptmobh">Espanyol</div>
    <div class="pttd ptprd"><div class="nyellow ptpredboxsml">Draw 2-2</div></div>
    <div class="pttd ptmoba">Levante</div>
    <div class="pttd ptgame"><a href="https://www.predictz.com/predictions/spain/la-liga/1202539/">Espanyol v Levante</a></div>
  </div>
</div>
</body></html>
`;

const parsed = parseTipsHtml(html, { day: 'today', date: '2026-08-16' });
assert('heading date', parseHeadingDate('Football Tips Tonight - Sunday, August 16th, 2026') === '2026-08-16');
assert('one unique tip after dedupe', parsed.tips.length === 1, `got ${parsed.tips.length}`);
assert('league stripped Tips suffix', parsed.tips[0].league === 'Spain La Liga');
assert('prediction Draw 2-2', parsed.tips[0].prediction === 'Draw 2-2');
assert('predictionSide draw', parsed.tips[0].predictionSide === 'draw');
assert('odds home', parsed.tips[0].odds.home === '2.15');
assert('home form', parsed.tips[0].homeForm.join('') === 'LW');

const delivery = formatTipsDelivery({
  source: 'https://www.predictz.com/',
  today: parsed,
  tomorrow: { day: 'tomorrow', date: '2026-08-17', tips: [] },
});
assert('delivery today count 1', delivery.today.count === 1);
assert('delivery total count 1', delivery.count === 1);

const shellHtml = `
<html><body>
<h1>www.predictz.com</h1>
<p>No predictions table</p>
</body></html>
`;
const shell = parseTipsHtml(shellHtml, { day: 'today', date: '2026-10-03' });
assert('shell page label is not a tips heading', shell.label === 'www.predictz.com');
assert('shell page is not a usable tips day', isUsableTipsDay(shell) === false);
assert('unavailable day is not a usable tips day', isUsableTipsDay({ unavailable: true, tips: [], label: 'www.predictz.com' }) === false);
assert('shell page has no tips', shell.tips.length === 0);

const realEmpty = parseTipsHtml(
  '<html><body><h1>Football Tips Today - Saturday, October 3rd, 2026</h1></body></html>',
  { day: 'today', date: '2026-10-03' }
);
assert('real empty tips page is usable', isUsableTipsDay(realEmpty) === true);

const logoThenHeading = `
<html><body>
<h1>www.predictz.com</h1>
<h1>Football Tips Today - Saturday, October 3rd, 2026</h1>
<div class="pttr ptcnt">
  <div class="pttd ptmobh">Belarus</div>
  <div class="pttd ptprd"><div class="ptpredboxsml">Home 2-0</div></div>
  <div class="pttd ptmoba">San Marino</div>
  <div class="pttd ptgame"><a href="https://www.predictz.com/predictions/international/uefa-nations-league/1185001/">Belarus v San Marino</a></div>
</div>
</body></html>
`;
const withLogo = parseTipsHtml(logoThenHeading, { day: 'today', date: '2026-10-03' });
assert('logo h1 ignored', withLogo.label.includes('Football Tips Today'));
assert('tip still parsed under logo h1', withLogo.tips.length === 1 && withLogo.tips[0].homeTeam === 'Belarus');

const previousTomorrow = {
  day: 'tomorrow',
  date: '2026-10-03',
  label: 'Football Tips Tomorrow - Saturday, October 3rd, 2026',
  count: 1,
  tips: [{ id: '1', homeTeam: 'A', awayTeam: 'B', prediction: 'Home 1-0', date: '2026-10-03' }],
};
const kept = resolveTipsDay({
  scraped: shell,
  previousSame: { day: 'today', date: '2026-10-02', tips: [{ id: 'old' }], count: 1 },
  previousOther: previousTomorrow,
  expectedDate: '2026-10-03',
  day: 'today',
});
assert('failed today uses yesterday tomorrow when that date is today', kept?.tips?.[0]?.id === '1' && kept.day === 'today');

const missing = resolveTipsDay({
  scraped: shell,
  previousSame: { day: 'today', date: '2026-10-02', tips: [{ id: 'old' }], count: 1 },
  expectedDate: '2026-10-03',
  day: 'today',
});
assert('failed today with no same-date backup is not published', missing == null);

const legitEmptyKept = resolveTipsDay({
  scraped: realEmpty,
  previousSame: previousTomorrow,
  expectedDate: '2026-10-03',
  day: 'today',
});
assert('real empty page is kept', legitEmptyKept?.label?.includes('Football Tips Today') && legitEmptyKept.tips.length === 0);

const normalizer = new Normalizer({
  teams: [
    { standardName: 'Manchester City', aliases: ['Man City', 'Manchester City'] },
    { standardName: 'Arsenal', aliases: ['Arsenal'] },
  ],
});
const tipsDelivery = {
  today: {
    date: '2026-10-20',
    tips: [
      { id: 'city', homeTeam: 'Man City', awayTeam: 'Arsenal', date: '2026-10-20', prediction: 'Home 2-1' },
      { id: 'other', homeTeam: 'Espanyol', awayTeam: 'Levante', date: '2026-10-20', prediction: 'Draw 1-1' },
      { id: 'old-day', homeTeam: 'Man City', awayTeam: 'Arsenal', date: '2026-10-19', prediction: 'Away 1-0' },
    ],
    count: 3,
  },
  tomorrow: {
    date: '2026-10-21',
    tips: [
      { id: 'swap', homeTeam: 'Arsenal', awayTeam: 'Manchester City', date: '2026-10-21', prediction: 'Home 1-0' },
    ],
    count: 1,
  },
  count: 4,
};
const matches = [
  {
    homeTeam: 'Manchester City',
    awayTeam: 'Arsenal',
    homeLogo: 'https://cdn.example/city.png',
    awayLogo: null,
    kickoff: '2026-10-20T13:30:00.000Z',
  },
  {
    homeTeam: 'Manchester City',
    awayTeam: 'Arsenal',
    homeLogo: 'https://cdn.example/city.png',
    awayLogo: 'https://cdn.example/arsenal.png',
    kickoff: '2026-10-21T13:30:00.000Z',
  },
];
const filtered = filterTipsToMatchFixtures(tipsDelivery, matches, normalizer);
assert('fixture in matches.json is kept', filtered.today.tips.map((tip) => tip.id).join(',') === 'city', filtered.today.tips.map((tip) => tip.id).join(','));
assert('tip for teams outside matches.json is dropped', !filtered.today.tips.some((tip) => tip.id === 'other'));
assert('swapped home and away still match', filtered.tomorrow.tips.map((tip) => tip.id).join(',') === 'swap');
const city = filtered.today.tips[0];
assert(
  'logo follows the tip home team',
  city.homeLogo === 'https://cdn.example/city.png' && city.awayLogo == null
);
const swapped = filtered.tomorrow.tips[0];
assert(
  'swapped fixture still gives each team its own logo',
  swapped.homeTeam === 'Arsenal' &&
    swapped.homeLogo === 'https://cdn.example/arsenal.png' &&
    swapped.awayLogo === 'https://cdn.example/city.png'
);
assert('filtered count', filtered.count === 2, String(filtered.count));
const none = filterTipsToMatchFixtures(tipsDelivery, [], normalizer);
assert('no matches means no tips', none.count === 0 && none.today.tips.length === 0);

const midnight = filterTipsToMatchFixtures(
  {
    today: {
      date: '2026-10-21',
      tips: [
        { id: 'como', homeTeam: 'Como', awayTeam: 'Man Utd', date: '2026-10-21', prediction: 'Home 1-0' },
        { id: 'villa', homeTeam: 'Aston Villa', awayTeam: 'Viking', date: '2026-10-21', prediction: 'Home 2-0' },
      ],
    },
    tomorrow: { date: '2026-10-22', tips: [] },
  },
  [
    { homeTeam: 'Como', awayTeam: 'Manchester United', kickoff: '2026-10-21T23:15:00.000+06:30' },
    { homeTeam: 'Aston Villa', awayTeam: 'Viking', kickoff: '2026-10-22T01:30:00.000+06:30' },
  ],
  new Normalizer({
    teams: [{ standardName: 'Manchester United', aliases: ['Man Utd'] }],
  })
);
assert(
  'kickoff before midnight stays on today',
  midnight.today.tips.map((tip) => tip.id).join(',') === 'como'
);
assert(
  'kickoff after midnight moves to tomorrow',
  midnight.tomorrow.count === 1 &&
    midnight.tomorrow.tips[0].id === 'villa' &&
    midnight.tomorrow.tips[0].date === '2026-10-22'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
