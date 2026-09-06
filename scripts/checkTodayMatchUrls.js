/**
 * Check whether streaming sites list Match URLs for today's fixtures.
 * Usage: node scripts/checkTodayMatchUrls.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { Normalizer } = require('../src/utils/normalize');
const { MultiMatchScraper } = require('../src/services/multiMatchScraper');

const ROOT = path.join(__dirname, '..');
const FEED_URL =
  process.env.MATCHES_FEED_URL ||
  'https://raw.githubusercontent.com/pkutoelay-alt/football-json-delivery/refs/heads/main/matches.json';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function yangonDateKey() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yangon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

async function main() {
  const sourcesDoc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config/sources.json'), 'utf8')
  );
  const teamsDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/teams.json'), 'utf8'));
  const normalizer = new Normalizer({ teams: teamsDoc.teams || [] });

  const feed = await getJson(FEED_URL);
  const today = yangonDateKey();
  const fixtures = (feed.matches || []).filter((m) => m.date === today);
  console.log(`Feed generatedAt=${feed.generatedAt}`);
  console.log(`Today (${today}) fixtures: ${fixtures.length}`);
  console.log(
    `Already have Match URL in feed: ${fixtures.filter((m) => m.matchUrl || Object.keys(m.sourcePages || {}).length).length}`
  );

  const only = (process.env.CHECK_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const enabled = (sourcesDoc.sources || []).filter(
    (s) =>
      s.enabled &&
      s.type === 'streaming' &&
      (!only.length || only.includes(s.name))
  );

  const summary = [];

  for (const cfg of enabled) {
    const base = String(cfg.domains?.[0] || '').replace(/\/$/, '');
    const lists = (cfg.paths?.lists || [cfg.paths?.schedule || '/']).map(
      (p) => base + p
    );
    console.log(`\n=== ${cfg.name} ===`);
    console.log(` list: ${lists[0]}`);

    const scraper = new MultiMatchScraper({
      sourceName: cfg.name,
      linkPattern: /truc-tiep\/[^\s"'<>#?]+/gi,
      normalizer,
    });

    let entries = [];
    try {
      entries = await scraper.fetchListEntriesAxios(lists, cfg);
      console.log(` axios listings: ${entries.length}`);
    } catch (err) {
      console.log(` axios failed: ${err.message}`);
    }

    if (!entries.length) {
      summary.push({ source: cfg.name, listings: 0, matched: 0, note: 'empty_or_blocked' });
      continue;
    }

    const matched = scraper.matchFixturesToEntries(fixtures, entries);
    console.log(` matched today's fixtures: ${matched.length}`);
    for (const m of matched) {
      console.log(
        `  ✓ ${(m.homeTeam || m.originalNames?.fotmob?.homeTeam || '?')} vs ${(m.awayTeam || m.originalNames?.fotmob?.awayTeam || '?')}`
      );
      console.log(`    ${m.matchUrl}`);
    }

    const blob = entries.map((e) => JSON.stringify(e).toLowerCase()).join('\n');
    const probes = [
      'arsenal',
      'chelsea',
      'everton',
      'manchester',
      'barcelona',
      'valencia',
      'juventus',
      'milan',
      'marseille',
      'anyan',
      'gangwon',
    ];
    const mentioned = probes.filter((n) => blob.includes(n));
    if (mentioned.length) console.log(` listing text mentions: ${mentioned.join(', ')}`);

    const matchedIds = new Set(matched.map((m) => m.matchId));
    const missed = fixtures.filter((f) => !matchedIds.has(f.matchId));
    if (missed.length) {
      console.log(` not matched (${missed.length}):`);
      for (const m of missed) {
        console.log(`  ✗ ${m.time} ${m.homeTeam} vs ${m.awayTeam} (${m.league || ''})`);
      }
    }

    summary.push({
      source: cfg.name,
      listings: entries.length,
      matched: matched.length,
      missed: missed.length,
      urls: matched.map((m) => ({
        matchId: m.matchId,
        url: m.matchUrl,
        teams: `${m.homeTeam || '?'} vs ${m.awayTeam || '?'}`,
      })),
    });
  }

  console.log('\n=== SUMMARY ===');
  for (const row of summary) {
    console.log(
      `${row.source}: listings=${row.listings} matched=${row.matched}${row.note ? ` (${row.note})` : ''}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
