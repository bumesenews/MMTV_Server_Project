/**
 * Merge FotMob club/NT names from allow-listed league tables + today/tomorrow
 * fixtures into config/teams.json. Skips friendlies (unbounded).
 * Run: node scripts/syncTeamsFromFotmobLeagues.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');
const leaguesDoc = require('../config/leagues.json');
const teamsPath = path.join(__dirname, '../config/teams.json');

const ZONE = 'Asia/Yangon';
const SKIP_LEAGUE_IDS = new Set([915708]);
const JUNK_NAME =
  /^(winner\b|[1-4][a-f]\b|3abc|3abcd|3adef|3def|group\s+[a-h]$|tbd$|n\/a$)/i;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.fotmob.com/',
};

function foldKey(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function usableName(name) {
  const s = String(name || '').trim();
  if (s.length < 3) return false;
  if (JUNK_NAME.test(s)) return false;
  return true;
}

function pushTeam(acc, name, shortName) {
  if (!usableName(name)) return;
  acc.push({
    name: String(name).trim(),
    shortName: usableName(shortName) ? String(shortName).trim() : '',
  });
}

function collectTableTeams(data, acc) {
  const blocks = Array.isArray(data?.table) ? data.table : [];
  for (const block of blocks) {
    const table = block?.data?.table || {};
    for (const key of ['all', 'home', 'away']) {
      const rows = table[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) pushTeam(acc, row.name, row.shortName);
    }
  }
  const fixtureLists = [
    data?.fixtures?.allMatches,
    data?.fixtures?.matches,
    data?.overview?.table,
  ];
  for (const list of fixtureLists) {
    if (!Array.isArray(list)) continue;
    for (const match of list) {
      pushTeam(acc, match?.home?.name, match?.home?.shortName);
      pushTeam(acc, match?.away?.name, match?.away?.shortName);
    }
  }
}

function collectMatchTeams(node, acc, allowedIds) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectMatchTeams(item, acc, allowedIds);
    return;
  }
  const leagueId = Number(node.id || node.leagueId || node.primaryId);
  const matches = node.matches || node.allMatches;
  if (Array.isArray(matches) && allowedIds.has(leagueId)) {
    for (const match of matches) {
      pushTeam(acc, match?.home?.name || match?.home?.longName, match?.home?.shortName);
      pushTeam(acc, match?.away?.name || match?.away?.longName, match?.away?.shortName);
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectMatchTeams(value, acc, allowedIds);
  }
}

async function getJson(url) {
  const { data } = await axios.get(url, { timeout: 25000, headers: HEADERS });
  return data;
}

function findExisting(teams, name) {
  const key = foldKey(name);
  if (!key) return null;
  return teams.find((t) => {
    const names = [t.standardName, ...(t.aliases || [])];
    return names.some((n) => foldKey(n) === key);
  });
}

function mergeRow(teams, row, stats) {
  const primary = row.name;
  const extra = [];
  if (row.shortName && foldKey(row.shortName) !== foldKey(primary)) extra.push(row.shortName);

  let existing = findExisting(teams, primary);
  if (!existing && row.shortName) existing = findExisting(teams, row.shortName);
  if (existing) {
    const aliases = existing.aliases || [];
    const have = new Set(aliases.map(foldKey));
    have.add(foldKey(existing.standardName));
    for (const alias of [primary, ...extra]) {
      if (!alias || have.has(foldKey(alias))) continue;
      if (foldKey(alias).length < 3) continue;
      aliases.push(alias);
      have.add(foldKey(alias));
      stats.aliased += 1;
    }
    existing.aliases = aliases;
    return;
  }
  const aliases = [primary, ...extra.filter((a) => foldKey(a) !== foldKey(primary))];
  teams.push({ standardName: primary, aliases: [...new Set(aliases)] });
  stats.added += 1;
}

async function main() {
  const allowedIds = new Set(
    (leaguesDoc.allowedLeagues || [])
      .flatMap((l) => l.fotmobIds || [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && !SKIP_LEAGUE_IDS.has(id))
  );
  const tableIds = [...allowedIds];

  const acc = [];
  for (const id of tableIds) {
    try {
      const data = await getJson(`https://www.fotmob.com/api/data/leagues?id=${id}`);
      const before = acc.length;
      collectTableTeams(data, acc);
      console.log(`table ${id}: +${acc.length - before}`);
    } catch (err) {
      console.warn(`table ${id} failed: ${err.message}`);
    }
  }

  const day = DateTime.now().setZone(ZONE);
  for (const offset of [-1, 0, 1]) {
    const dateKey = day.plus({ days: offset }).toFormat('yyyyMMdd');
    try {
      const data = await getJson(
        `https://www.fotmob.com/api/data/matches?date=${dateKey}&timezone=${encodeURIComponent(ZONE)}&ccode3=MMR`
      );
      const before = acc.length;
      collectMatchTeams(data, acc, allowedIds);
      console.log(`matches ${dateKey}: +${acc.length - before}`);
    } catch (err) {
      console.warn(`matches ${dateKey} failed: ${err.message}`);
    }
  }

  const seen = new Map();
  for (const row of acc) {
    const key = foldKey(row.name);
    if (!seen.has(key)) seen.set(key, row);
  }

  const doc = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
  const teams = Array.isArray(doc.teams) ? doc.teams : [];
  const stats = { added: 0, aliased: 0 };
  for (const row of seen.values()) mergeRow(teams, row, stats);

  const seeds = [
    {
      standardName: 'Jagiellonia Białystok',
      aliases: ['Jagiellonia Białystok', 'Jagiellonia Bialystok', 'Jagiellonia'],
    },
    {
      standardName: 'Iberia 1999',
      aliases: ['Iberia 1999', 'FC Iberia 1999', 'Saburtalo', 'FC Saburtalo', 'Saburtalo Tbilisi'],
    },
    {
      standardName: 'Kairat Almaty',
      aliases: ['Kairat Almaty', 'Kairat', 'FC Kairat'],
    },
    {
      standardName: 'Anderlecht',
      aliases: ['Anderlecht', 'RSC Anderlecht', 'RSCA'],
    },
    {
      standardName: 'Mjällby',
      aliases: ['Mjällby', 'Mjallby', 'Mjällby AIF'],
    },
  ];
  for (const seed of seeds) {
    const existing = findExisting(teams, seed.standardName) || findExisting(teams, seed.aliases[0]);
    if (!existing) {
      teams.push(seed);
      stats.added += 1;
      continue;
    }
    const have = new Set((existing.aliases || []).map(foldKey));
    have.add(foldKey(existing.standardName));
    for (const alias of seed.aliases) {
      if (!have.has(foldKey(alias))) {
        existing.aliases = existing.aliases || [];
        existing.aliases.push(alias);
        have.add(foldKey(alias));
        stats.aliased += 1;
      }
    }
  }

  teams.sort((a, b) => String(a.standardName).localeCompare(String(b.standardName)));
  fs.writeFileSync(teamsPath, `${JSON.stringify({ teams }, null, 2)}\n`);
  console.log(`wrote ${teams.length} teams (added ${stats.added}, new aliases ${stats.aliased})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
