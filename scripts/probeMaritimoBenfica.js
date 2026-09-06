const fs = require('fs');
const { MultiMatchScraper } = require('../src/services/multiMatchScraper');
const { axiosGetHtml } = require('../src/sources/httpStreamExtractor');
const { scoreStreamMatch, parseStreamUrl } = require('../src/utils/streamUrlHelper');
const { Normalizer } = require('../src/utils/normalize');

const sources = JSON.parse(fs.readFileSync('config/sources.json', 'utf8')).sources.filter(
  (s) => s.type === 'streaming' && s.enabled !== false
);

const fixture = {
  matchId: 'maritimo_benfica_20260905',
  homeTeam: 'Marítimo',
  awayTeam: 'Benfica',
  kickoff: '2026-09-05T23:30:00.000+06:30',
  date: '2026-09-05',
  time: '23:30',
  league: 'Liga Portugal (PRO D1)',
  originalNames: {
    fotmob: { league: 'Liga Portugal', homeTeam: 'Marítimo', awayTeam: 'Benfica' },
  },
};

const normalizer = new Normalizer({ leagues: [], teams: [] });
const scraper = new MultiMatchScraper({ sourceName: 'probe' });

(async () => {
  for (const s of sources) {
    const origin = (s.domains && s.domains[0]) || '';
    if (!origin) continue;
    const paths = [s.paths?.schedule, ...(s.paths?.lists || []), '/'].filter(Boolean);
    const out = { source: s.name, origin, entries: 0, scored: [], error: null };
    for (const p of paths) {
      const url = `${String(origin).replace(/\/$/, '')}${p.startsWith('http') ? '' : p}`;
      try {
        const html = await axiosGetHtml(url, { referer: origin });
        if (scraper.looksBlockedOrEmpty(html)) {
          out.error = out.error || 'blocked/empty';
          continue;
        }
        const entries = scraper.extractMatchEntries(html, origin, s);
        out.entries = Math.max(out.entries, entries.length);
        out.fetchUrl = url;
        for (const e of entries) {
          const parsed = { ...parseStreamUrl(e.url), url: e.url, league: e.league || '' };
          const r = scoreStreamMatch(fixture, parsed, { normalizer });
          if (r.accepted || (r.score || 0) >= 70 || /maritim|benfica/i.test(e.url)) {
            out.scored.push({
              url: e.url,
              league: e.league,
              score: r.score,
              accepted: r.accepted,
              reason: r.reason,
              status: r.status,
            });
          }
        }
        if (out.scored.length) break;
      } catch (e) {
        out.error = e.message;
      }
    }
    out.scored = out.scored.slice(0, 6);
    console.log(JSON.stringify(out));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
