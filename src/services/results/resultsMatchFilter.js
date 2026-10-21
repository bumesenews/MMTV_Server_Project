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
    homeLogo: logoUrl(homeIsMatchHome ? match.homeLogo : match.awayLogo) || logoUrl(result.homeLogo),
    awayLogo: logoUrl(homeIsMatchHome ? match.awayLogo : match.homeLogo) || logoUrl(result.awayLogo),
  };
}

function rememberTeam(catalog, normalizer, name, logo) {
  const standard = normalizer.normalizeTeam(name) || name;
  const key = teamMatchKey(standard);
  if (!key) return;
  const prev = catalog.get(key);
  const nextLogo = logoUrl(logo);
  if (!prev) {
    catalog.set(key, { name: standard, logo: nextLogo });
    return;
  }
  if (!prev.logo && nextLogo) prev.logo = nextLogo;
}

function sideFromCatalog(name, catalog, normalizer, existingLogo) {
  const standard = normalizer.normalizeTeam(name) || name;
  const found = catalog.get(teamMatchKey(standard));
  const logo = logoUrl(existingLogo);
  if (!found) return { name, logo };
  return { name: found.name || name, logo: found.logo || logo };
}

/**
 * Every result stays in the feed. Crests come from the results site.
 * When the same club is in matches.json, that fixture's name and logo replace
 * the scraped ones. A same-day fixture wins so each badge stays with the score.
 */
function filterResultsToMatchFixtures(delivery, matches, normalizer) {
  const matcher = normalizer || new Normalizer();
  const matchesByKey = new Map();
  const catalog = new Map();
  for (const match of matches || []) {
    const key = fixtureKey(
      match.homeTeam,
      match.awayTeam,
      yangonDateFromMatch(match),
      matcher
    );
    if (key && !matchesByKey.has(key)) matchesByKey.set(key, match);
    rememberTeam(catalog, matcher, match.homeTeam, match.homeLogo);
    rememberTeam(catalog, matcher, match.awayTeam, match.awayLogo);
  }

  const payload = delivery && typeof delivery === 'object' ? delivery : {};
  const results = (payload.results || []).map((row) => {
    const key = fixtureKey(row.homeTeam, row.awayTeam, row.date, matcher);
    const match = key ? matchesByKey.get(key) : null;
    if (match) return { ...row, ...teamsFromFixture(row, match, matcher) };
    const home = sideFromCatalog(row.homeTeam, catalog, matcher, row.homeLogo);
    const away = sideFromCatalog(row.awayTeam, catalog, matcher, row.awayLogo);
    return {
      ...row,
      homeTeam: home.name,
      awayTeam: away.name,
      homeLogo: home.logo,
      awayLogo: away.logo,
    };
  });
  return {
    ...payload,
    results,
    count: results.length,
  };
}

module.exports = {
  filterResultsToMatchFixtures,
};
