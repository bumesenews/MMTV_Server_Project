const axios = require('axios');
const { load } = require('cheerio');
const fs = require('fs');
const path = require('path');

async function main() {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const url =
    'https://www.fotmob.com/api/data/matches?date=20260724&timezone=Asia%2FYangon&ccode3=MMR';
  const r = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': ua, Accept: 'application/json', Referer: 'https://www.fotmob.com/' },
  });
  console.log(
    'ALL LEAGUES\n',
    (r.data.leagues || [])
      .map((l) => `${l.name}|${l.country || ''}|${(l.matches || []).length}`)
      .join('\n')
  );

  const leaguesCfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config/leagues.json'), 'utf8')
  );
  const allowed = (leaguesCfg.allowedLeagues || []).map((x) => x.standardName);
  console.log('\nALLOWED', allowed.join(' | '));

  // Soco
  const soco = 'https://socolivekz.cc/sport/football/filter/today';
  const s = await axios.get(soco, {
    timeout: 20000,
    headers: { 'User-Agent': ua, Accept: 'text/html', Referer: 'https://socolivekz.cc/' },
    validateStatus: () => true,
  });
  const $ = load(s.data);
  console.log(
    '\nSOCO',
    s.status,
    'cards',
    $('.match-football-item').length,
    'has class',
    String(s.data).includes('match-football-item')
  );
  console.log('title', $('title').text());
  // sample league texts
  const leagues = [];
  $('.match-football-item')
    .slice(0, 5)
    .each((_, el) => {
      leagues.push({
        league: $(el).find('.grid-match__league-name, .grid-match__league').text().replace(/\s+/g, ' ').trim(),
        home: $(el).find('.grid-match__team--home-name').text().trim(),
        away: $(el).find('.grid-match__team--away-name').text().trim(),
      });
    });
  console.log('sample', leagues);

  // Highlight with browser-like headers
  const h = await axios.get('https://hoofoot.com/', {
    timeout: 20000,
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
    validateStatus: () => true,
  });
  console.log('\nHIGHLIGHT', h.status, String(h.data).slice(0, 120).replace(/\s+/g, ' '));

  // Myanmar with browser-like headers
  const m = await axios.get('https://www.myanmartvchannels.com/tv-channels.html', {
    timeout: 20000,
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,my;q=0.8',
      Referer: 'https://www.google.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-User': '?1',
    },
    validateStatus: () => true,
  });
  console.log('\nMYANMAR', m.status, String(m.data).includes('tv-channels') || String(m.data).includes('channel'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
