const https = require('https');
const fs = require('fs');
const path = require('path');

const url =
  'https://raw.githubusercontent.com/pkutoelay-alt/football-json-delivery/refs/heads/main/config/sources.json';
const out = path.join(__dirname, '../config/sources.json');

https
  .get(url, (res) => {
    let d = '';
    res.on('data', (c) => {
      d += c;
    });
    res.on('end', () => {
      const json = JSON.parse(d);
      for (const s of json.sources || []) {
        if (!s.selectors) continue;
        if (['cakhia', 'xoilac', 'mitomtm', 'socolive'].includes(s.name)) {
          const cards = s.selectors.matchCard || [];
          for (const c of ['.match-football-item', '.main-grid-match', '.grid-matches__item']) {
            if (!cards.includes(c)) cards.unshift(c);
          }
          s.selectors.matchCard = cards;
          const leagues = s.selectors.league || [];
          for (const c of ['.gmd-match-league', 'span.text-ellipsis[data-attr]']) {
            if (!leagues.includes(c)) leagues.unshift(c);
          }
          s.selectors.league = leagues;
          const links = s.selectors.matchLink || [];
          if (!links.some((x) => String(x).includes('truc-tiep'))) {
            links.push("a[href*='/truc-tiep']");
          }
          s.selectors.matchLink = links;
        }
        if (s.name === 'socolive' && s.playbackHeaders) {
          s.playbackHeaders.Referer = 'https://socoliveza.tv/';
        }
        if (s.name === 'highlight2') {
          s.domains = ['https://socoliveza.tv/'];
        }
      }
      json.updatedAt = new Date().toISOString();
      fs.writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
      console.log(
        'wrote',
        out,
        (json.sources || [])
          .filter((s) => s.type === 'streaming')
          .map((s) => ({ name: s.name, domains: s.domains }))
      );
    });
  })
  .on('error', (e) => {
    console.error(e);
    process.exit(1);
  });
