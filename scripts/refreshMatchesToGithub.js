/**
 * One-shot: scrape FotMob today+tomorrow and push matches.json to GitHub.
 * Use when EC2 delivery is stuck on expired rows.
 */
require('dotenv').config();
const { ConfigLoader } = require('../src/services/configLoader');
const { Normalizer } = require('../src/utils/normalize');
const { FixtureService } = require('../src/services/fixtureService');
const { CacheService } = require('../src/services/cacheService');
const { GitHubService } = require('../src/services/githubService');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const { buildDeliveryBundle } = require('../src/services/deliveryFormats');
const { syncMatchesForDelivery } = require('../src/services/matchesSyncService');
const { isTodayOrTomorrow } = require('../src/utils/time');

async function main() {
  const loader = new ConfigLoader(process.env);
  const config = await loader.load(true);
  const leagues = config.leagues?.allowedLeagues || config.leagues?.leagues || [];
  const teams = config.teams?.teams || [];
  const normalizer = new Normalizer({ leagues, teams });
  const fotmobCfg =
    loader.getSourceConfig(config.sources, 'fotmob') || {
      name: 'fotmob',
      domains: ['https://www.fotmob.com'],
      api: { matches: 'https://www.fotmob.com/api/data/matches' },
    };

  const fixtures = await new FixtureService({
    config: fotmobCfg,
    normalizer,
  }).collect();
  const todayTomorrow = (fixtures || []).filter((f) => isTodayOrTomorrow(f.kickoff));
  console.log('scraped', fixtures.length, 'todayTomorrow', todayTomorrow.length);

  const cache = new CacheService();
  const github = new GitHubService(process.env);
  const previous = cache.getDelivery('matches');
  const extras = {
    highlights: cache.getCurrent()?.highlights || cache.getDelivery('highlight1')?.highlights || [],
    channels: cache.getCurrent()?.channels || cache.getDelivery('myanmartv') || [],
  };

  const sync = syncMatchesForDelivery([], todayTomorrow, { normalizer });
  console.log('sync final', sync.matches.length, 'removedExpired', sync.removedExpired);

  const payload = generateFlutterJson(
    sync.matches,
    {
      configOrigin: 'manual_refresh',
      sources: [],
      sync: {
        removedExpired: sync.removedExpired,
        streamsAdded: 0,
        matchesAdded: sync.matchesAdded,
      },
    },
    extras
  );

  cache.saveGenerated(payload);
  const delivery = buildDeliveryBundle({
    matchesPayload: payload,
    highlights: extras.highlights,
    channels: extras.channels,
  });
  const { previous: prevDelivery } = cache.saveDeliveryBundle(delivery);

  const result = await github.uploadDeliveryBundle(delivery, {
    ...(prevDelivery || {}),
    matches: previous,
  });
  console.log('github', JSON.stringify(result, null, 2));
  console.log(
    'sample',
    sync.matches.slice(0, 5).map((m) => `${m.date} ${m.time} ${m.homeTeam} vs ${m.awayTeam}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
