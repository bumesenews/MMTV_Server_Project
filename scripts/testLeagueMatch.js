const { Normalizer, isFalseEnglishPremierLabel } = require('../src/utils/normalize');
const leagues = require('../config/leagues.json').allowedLeagues;
const n = new Normalizer({ leagues, teams: [] });
const cases = [
  ['Europa League Qualification', {}],
  ['ASEAN Championship Grp. A', {}],
  ['Champions League Qualification', {}],
  ["INT Women's Champions League Qualification 1st Round", {}],
  ['UEFA Champions League', {}],
  ['Premier League', {}],
  ['Premier League', { country: 'ARM' }],
  ['Premier League', { country: 'ARM', fotmobId: 118 }],
  ['ARM Premier League', { country: 'ARM' }],
  ['Premier League', { country: 'England' }],
  ['Premier League', { fotmobId: 47 }],
  ['INT Champions League Qualification', { country: 'INT', fotmobId: 937348 }],
  ['ENG Premier League U18', { country: 'ENG', fotmobId: 10068 }],
  ['Premier League U18', { country: 'ENG' }],
  ['Bundesliga', { country: 'AUT', fotmobId: 938366 }],
  ['Bundesliga', { country: 'GER', fotmobId: 54 }],
  ['UKR Premier League', { country: 'UKR' }],
];
for (const [name, opts] of cases) {
  console.log(JSON.stringify(name), opts, '=>', n.filterAllowedLeague(name, opts));
}

const u18 = n.filterAllowedLeague('ENG Premier League U18', {
  country: 'ENG',
  fotmobId: 10068,
});
if (u18 != null) {
  console.error('FAIL: U18 must not map onto a senior league, got', u18);
  process.exit(1);
}
const uclQ = n.filterAllowedLeague('INT Champions League Qualification', {
  country: 'INT',
  fotmobId: 937348,
});
if (uclQ !== 'UEFA Champions League') {
  console.error('FAIL: UCL qualification id 937348 must map to UEFA Champions League, got', uclQ);
  process.exit(1);
}
const uel = n.filterAllowedLeague('Europa League', {});
if (uel !== 'UEFA Europa League') {
  console.error('FAIL: Europa League must map to UEFA Europa League, got', uel);
  process.exit(1);
}
const uelQ = n.filterAllowedLeague('INT Europa League Qualification', {
  country: 'INT',
  fotmobId: 937349,
});
if (uelQ !== 'UEFA Europa League Qualification') {
  console.error(
    'FAIL: UEL qualification id 937349 must stay Qualification, not UEFA Europa League, got',
    uelQ
  );
  process.exit(1);
}
const uelQAlias = n.filterAllowedLeague('Europa League Qualification', {});
if (uelQAlias !== 'UEFA Europa League Qualification') {
  console.error('FAIL: Europa League Qualification alias mapped to', uelQAlias);
  process.exit(1);
}
const stale = isFalseEnglishPremierLabel({
  league: 'English Premier League (EPL)',
  homeTeam: 'Chelsea U18',
  awayTeam: 'Norwich U18',
  originalNames: { fotmob: { league: 'ENG Premier League U18', country: 'ENG', leagueId: 10068 } },
});
if (!stale) {
  console.error('FAIL: U18 EPL row must be treated as false EPL so sync can drop it');
  process.exit(1);
}
console.log('U18 rejected from allow-list');

