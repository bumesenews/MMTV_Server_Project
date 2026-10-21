const { formatDate, todayYangon } = require('../utils/time');
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

function pairKey(homeTeam, awayTeam, normalizer) {
  const home = teamMatchKey(normalizer.normalizeTeam(homeTeam));
  const away = teamMatchKey(normalizer.normalizeTeam(awayTeam));
  if (!home || !away) return null;
  return [home, away].sort().join('|');
}

function fixtureKey(homeTeam, awayTeam, date, normalizer) {
  const day = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const pair = pairKey(homeTeam, awayTeam, normalizer);
  if (!pair) return null;
  return `${day}|${pair}`;
}

function chooseFixture(tip, options) {
  const tipDate = String(tip.date || '').trim();
  const dated = options.find((item) => item.date === tipDate);
  if (dated) return dated;
  if (options.length === 1) return options[0];
  return null;
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

/**
 * Keep a tip when matches.json has the same two teams.
 * The tip is filed under that fixture's Asia/Yangon date, so a PredictZ
 * "today" row whose kickoff is after midnight lands on tomorrow.
 * Home and away order does not matter. Team aliases are applied before compare.
 * Each kept tip receives that fixture's logo on the matching team.
 */
function filterTipsToMatchFixtures(delivery, matches, normalizer) {
  const matcher = normalizer || new Normalizer();
  const byPair = new Map();
  for (const match of matches || []) {
    const date = yangonDateFromMatch(match);
    const pair = pairKey(match.homeTeam, match.awayTeam, matcher);
    if (!date || !pair) continue;
    const list = byPair.get(pair) || [];
    list.push({ match, date });
    byPair.set(pair, list);
  }

  const payload = delivery && typeof delivery === 'object' ? delivery : {};
  const todayDate = payload.today?.date || todayYangon().toFormat('yyyy-MM-dd');
  const tomorrowDate =
    payload.tomorrow?.date || todayYangon().plus({ days: 1 }).toFormat('yyyy-MM-dd');
  const buckets = { today: [], tomorrow: [] };
  const seen = new Set();
  const rows = [...(payload.today?.tips || []), ...(payload.tomorrow?.tips || [])];
  for (const tip of rows) {
    const pair = pairKey(tip.homeTeam, tip.awayTeam, matcher);
    const chosen = pair ? chooseFixture(tip, byPair.get(pair) || []) : null;
    if (!chosen) continue;
    const day = chosen.date === todayDate ? 'today' : chosen.date === tomorrowDate ? 'tomorrow' : null;
    if (!day) continue;
    const id = String(tip.id || `${pair}|${chosen.date}`);
    if (seen.has(`${day}|${id}`)) continue;
    seen.add(`${day}|${id}`);
    buckets[day].push({
      ...tip,
      day,
      date: chosen.date,
      ...logosFromFixture(tip, chosen.match, matcher),
    });
  }

  const today = {
    ...(payload.today || {}),
    day: 'today',
    date: todayDate,
    tips: buckets.today,
    count: buckets.today.length,
  };
  const tomorrow = {
    ...(payload.tomorrow || {}),
    day: 'tomorrow',
    date: tomorrowDate,
    tips: buckets.tomorrow,
    count: buckets.tomorrow.length,
  };
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
