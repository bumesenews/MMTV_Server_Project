const { formatDate } = require('../utils/time');
const { teamMatchKey, Normalizer } = require('../utils/normalize');

function yangonDateFromMatch(match) {
  if (!match || typeof match !== 'object') return null;
  const fromKickoff = formatDate(match.kickoff);
  if (fromKickoff) return fromKickoff;
  const raw = String(match.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const display = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!display) return null;
  const day = display[1].padStart(2, '0');
  const month = display[2].padStart(2, '0');
  return `${display[3]}-${month}-${day}`;
}

function fixtureKey(homeTeam, awayTeam, date, normalizer) {
  const day = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const home = teamMatchKey(normalizer.normalizeTeam(homeTeam));
  const away = teamMatchKey(normalizer.normalizeTeam(awayTeam));
  if (!home || !away) return null;
  const pair = [home, away].sort().join('|');
  return `${day}|${pair}`;
}

function logoUrl(value) {
  const text = String(value || '').trim();
  return text || null;
}

function logosFromFixture(tip, match, normalizer) {
  if (!match) return { homeLogo: null, awayLogo: null };
  const tipHome = teamMatchKey(normalizer.normalizeTeam(tip.homeTeam));
  const matchHome = teamMatchKey(normalizer.normalizeTeam(match.homeTeam));
  const homeIsMatchHome = tipHome && tipHome === matchHome;
  return {
    homeLogo: logoUrl(homeIsMatchHome ? match.homeLogo : match.awayLogo),
    awayLogo: logoUrl(homeIsMatchHome ? match.awayLogo : match.homeLogo),
  };
}

function filterDay(day, matchesByKey, normalizer) {
  const source = day && typeof day === 'object' ? day : {};
  const tips = [];
  for (const tip of source.tips || []) {
    const key = fixtureKey(
      tip.homeTeam,
      tip.awayTeam,
      tip.date || source.date,
      normalizer
    );
    const match = key ? matchesByKey.get(key) : null;
    if (!match) continue;
    tips.push({
      ...tip,
      ...logosFromFixture(tip, match, normalizer),
    });
  }
  return {
    ...source,
    tips,
    count: tips.length,
  };
}

/**
 * Keep a tip only when matches.json has the same two teams on the same Yangon date.
 * Home and away order does not matter. Team aliases are applied before compare.
 * Each kept tip receives that fixture's logo on the matching team.
 */
function filterTipsToMatchFixtures(delivery, matches, normalizer) {
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
  const today = filterDay(payload.today, matchesByKey, matcher);
  const tomorrow = filterDay(payload.tomorrow, matchesByKey, matcher);
  return {
    ...payload,
    today,
    tomorrow,
    count: today.count + tomorrow.count,
  };
}

module.exports = {
  yangonDateFromMatch,
  fixtureKey,
  filterTipsToMatchFixtures,
};
