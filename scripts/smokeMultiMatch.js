const { MultiMatchScraper } = require('../src/services/multiMatchScraper');

const s = new MultiMatchScraper({ sourceName: 'cakhia' });
const html = `
<html><body>
  <div class="match-item">
    <div class="league">EPL</div>
    <a href="/truc-tiep/lernayin-artsakh-vs-ararat-armenia-b-luc-1930-ngay-13-08-2026/">watch</a>
  </div>
</body></html>`;

const entries = s.extractMatchEntries(html, 'https://cakhiazvl.tv', {
  selectors: { league: ['.league'], matchCard: ['.match-item'] },
});
console.log(
  'entries',
  entries.map((e) => ({
    url: e.url,
    ok: e.ok,
    home: e.homeTeam,
    away: e.awayTeam,
    time: e.time,
    league: e.league,
  }))
);

const due = s.isFixtureDue({
  kickoff: new Date(Date.now() + 10 * 60000).toISOString(),
});
const early = s.isFixtureDue({
  kickoff: new Date(Date.now() + 60 * 60000).toISOString(),
});
console.log({ due, early });

const fotmob = {
  matchId: 'test-1',
  homeTeam: 'Lernayin Artsakh FC',
  awayTeam: 'FC Ararat-Armenia B',
  kickoff: entries[0]?.utcIso,
  league: 'English Premier League (EPL)',
  country: 'ENG',
  date: entries[0]?.date,
  time: entries[0]?.time,
};
const matched = s.matchFixturesToEntries([fotmob], entries);
console.log(
  'matched',
  matched.map((m) => ({ matchId: m.matchId, matchUrl: m.matchUrl }))
);
