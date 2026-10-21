const { teamMatchKey, Normalizer } = require('../../utils/normalize');
const { fixtureKey, yangonDateFromMatch } = require('../tipsMatchFilter');

function logoUrl(value) {
  const text = String(value || '').trim();
  return text || null;
}

function teamsFromFixture(result, match, normalizer) {
  const resultHome = teamMatchKey(normalizer.normalizeTeam(result.homeTeam));
  const matchHome = teamMatchKey(normalizer.normalizeTeam(match.homeTeam));
  const homeIsMatchHome = Boolean(resultHome && resultHome === matchHome);
  return {
    homeTeam: homeIsMatchHome ? match.homeTeam : match.awayTeam,
    awayTeam: homeIsMatchHome ? match.awayTeam : match.homeTeam,
    homeLogo: logoUrl(homeIsMatchHome ? match.homeLogo : match.awayLogo),
    awayLogo: logoUrl(homeIsMatchHome ? match.awayLogo : match.homeLogo),
  };
}

/**
 * Keep a result only when matches.json has the same two teams on the same
 * Yangon date. Team names and logos on the kept row come from that fixture.
 * The score stays with the result's home and away sides.
 */
function filterResultsToMatchFixtures(delivery, matches, normalizer) {
  const matcher = normalizer || new Normalizer();
  const matchesByKey = new Map();
  for (const match of matches || []) {
    const key = fixtureKey(
      match.homeTeam,
      match.awayTeam,
      yangonDateFromMatch(match),
      matcher
    );
    if (key) matchesByKey.set(key, match);
  }

  const payload = delivery && typeof delivery === 'object' ? delivery : {};
  const results = [];
  for (const row of payload.results || []) {
    const key = fixtureKey(row.homeTeam, row.awayTeam, row.date, matcher);
    const match = key ? matchesByKey.get(key) : null;
    if (!match) continue;
    results.push({
      ...row,
      ...teamsFromFixture(row, match, matcher),
    });
  }
  return {
    ...payload,
    results,
    count: results.length,
  };
}

module.exports = {
  filterResultsToMatchFixtures,
};
