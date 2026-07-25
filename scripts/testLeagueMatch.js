const { Normalizer } = require('../src/utils/normalize');
const leagues = require('../config/leagues.json').allowedLeagues;
const n = new Normalizer({ leagues, teams: [] });
const cases = [
  'Europa League Qualification',
  'ASEAN Championship Grp. A',
  'Champions League Qualification',
  "INT Women's Champions League Qualification 1st Round",
  'UEFA Champions League',
  'Premier League',
];
for (const name of cases) {
  console.log(JSON.stringify(name), '=>', n.filterAllowedLeague(name));
}
