/**
 * PredictZ tips HTML parser tests.
 * Run: node scripts/testTipsParse.js
 */
const { parseTipsHtml, parseHeadingDate } = require('../src/sources/tips');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
