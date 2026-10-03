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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
