/**
 * Name-first stream selection (unique server names, 1 per site, max 4).
 * Run: node scripts/testStreamNameSelect.js
 */
const {
  normalizeServerName,
  sortServerCandidates,
  selectedServerNameSet,
  selectUniqueNamedStreams,
} = require('../src/utils/streamServerName');
const { collectServerCandidates } = require('../src/sources/httpStreamExtractor');

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

console.log('\n=== Server name normalize + priority ===');
check('trim spaces', normalizeServerName(' HD ROY ') === 'HD ROY');
check('same as HD ROY', normalizeServerName('HD ROY') === 'HD ROY');
check('strips source prefix', normalizeServerName('CAKHIA HD ROY') === 'HD ROY');

const sorted = sortServerCandidates([
  { name: 'MAX', index: 2 },
  { name: 'HD ROY', index: 0 },
  { name: 'NICK', index: 1 },
  { name: 'RIO', index: 3 },
]).map((c) => c.name);
check(
  'priority order ROY-family first',
  sorted.join(',') === 'HD ROY,RIO,NICK,MAX',
  sorted.join(',')
);

console.log('\n=== Example four websites ===');
{
  const selected = [];
  const sites = [
    ['HD ROY', 'ROY', 'RIO'],
    ['HD ROY', 'NICK', 'MAX'],
    ['RIO', 'HD NICK'],
    ['MAX', 'JOHAN'],
  ];
  for (const names of sites) {
    const taken = selectedServerNameSet(selected);
    const ordered = sortServerCandidates(names.map((name, index) => ({ name, index })));
    const hit = ordered.find((c) => !taken.has(normalizeServerName(c.name)));
    if (hit) {
      selected.push({
        source: `site${selected.length + 1}`,
        name: hit.name,
        quality: hit.name,
        url: `https://cdn.example/${normalizeServerName(hit.name).replace(/\s+/g, '_')}.m3u8`,
      });
    }
  }
  const names = selected.map((s) => normalizeServerName(s.name));
  check('selected ROY, HD ROY, RIO, MAX', names.join(',') === 'ROY,HD ROY,RIO,MAX', names.join(','));
  check('max 4', selected.length === 4);
}

console.log('\n=== Website with only duplicates contributes nothing ===');
{
  const already = [
    { source: 'cakhia', name: 'HD ROY', url: 'https://a' },
    { source: 'xoilac', name: 'RIO', url: 'https://b' },
  ];
  const taken = selectedServerNameSet(already);
  const site3 = ['HD ROY', 'RIO'].filter((n) => !taken.has(normalizeServerName(n)));
  check('no unique names', site3.length === 0);
}

console.log('\n=== HTML name discovery does not need m3u8 ===');
{
  const html = `
    <div id="tv_links">
      <a class="player-link" href="https://cakhia.example/m" data-link="0">HD ROY</a>
      <a class="player-link" href="https://cakhia.example/m/link/2" data-link="1">NICK</a>
    </div>`;
  const names = collectServerCandidates(html, 'https://cakhia.example/m').map((c) =>
    normalizeServerName(c.name)
  );
  check('reads HD ROY and NICK from HTML', names.includes('HD ROY') && names.includes('NICK'), names.join(','));
}

console.log('\n=== Final list unique names + 1 per source ===');
{
  const out = selectUniqueNamedStreams([
    { source: 'manual', name: 'ENG HD', url: 'https://manual', manualId: '1' },
    { source: 'cakhia', name: 'HD ROY', url: 'https://a' },
    { source: 'cakhia', name: 'ROY', url: 'https://b' },
    { source: 'xoilac', name: 'HD ROY', url: 'https://c' },
    { source: 'phut', name: 'NICK', url: 'https://d' },
    { source: 'socolive', name: 'MAX', url: 'https://e' },
  ]);
  check('manual first', out[0].source === 'manual');
  check(
    'three unique auto names',
    out.filter((s) => s.source !== 'manual').map((s) => s.name).join(',') === 'HD ROY,NICK,MAX'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
