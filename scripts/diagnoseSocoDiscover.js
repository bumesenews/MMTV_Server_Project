const { load } = require('cheerio');
const { Normalizer } = require('../src/utils/normalize');
const leagues = require('../config/leagues.json').allowedLeagues;
const { SocoSource } = require('../src/sources/soco');

async function main() {
  const normalizer = new Normalizer({ leagues, teams: [] });
  const soco = new SocoSource({
    config: {
      name: 'soco',
      enabled: true,
      domains: ['https://socolivekz.cc/'],
      onlyAllowedLeagues: true,
      leagueFilter: [],
      sections: ['today', 'tomorrow'],
      paths: {
        today: '/sport/football/filter/today',
        tomorrow: '/sport/football/filter/tomorrow',
      },
    },
    normalizer,
  });

  console.log('baseUrl', soco.baseUrl);
  console.log('onlyAllowedLeagues', soco.onlyAllowedLeagues, 'leagueFilter', soco.leagueFilter);

  for (const section of ['today', 'tomorrow']) {
    const url = soco.sectionUrl(section);
    const html = await soco.fetchSectionHtml(section);
    const $ = load(html || '');
    const cards = $('.match-football-item').length;
    console.log('\nsection', section, 'url', url);
    console.log('htmlLen', (html || '').length, 'cards', cards);

    const samples = [];
    $('.match-football-item')
      .slice(0, 8)
      .each((_, el) => {
        const card = $(el);
        const league = card
          .find('.grid-match__league-name, .grid-match__league')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim();
        const home = card.find('.grid-match__team--home-name').first().text().trim();
        const away = card.find('.grid-match__team--away-name').first().text().trim();
        const kickoff = card.attr('data-runtime');
        const allowed = normalizer.filterAllowedLeague(league);
        const pass = soco.passesLeagueFilter(league, allowed || league);
        samples.push({ league, home, away, kickoff, allowed, pass });
      });
    console.log('samples', JSON.stringify(samples, null, 2));
  }

  const discovered = await soco.discoverMatches();
  console.log('\ndiscover count', discovered.length);
  console.log(
    'leagues',
    [...new Set(discovered.map((m) => m.league))].slice(0, 20)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
