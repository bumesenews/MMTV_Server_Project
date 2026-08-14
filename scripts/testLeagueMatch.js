const { Normalizer } = require('../src/utils/normalize');
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
];
for (const [name, opts] of cases) {
  console.log(JSON.stringify(name), opts, '=>', n.filterAllowedLeague(name, opts));
}
