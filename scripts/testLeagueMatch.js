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
  ['Bundesliga', { country: 'AUT', fotmobId: 938366 }],
  ['Bundesliga', { country: 'GER', fotmobId: 54 }],
  ['UKR Premier League', { country: 'UKR' }],
];
for (const [name, opts] of cases) {
  console.log(JSON.stringify(name), opts, '=>', n.filterAllowedLeague(name, opts));
}
