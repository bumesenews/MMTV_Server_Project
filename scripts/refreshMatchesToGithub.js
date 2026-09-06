/**
 * One-shot: scrape FotMob today+tomorrow and push matches.json to GitHub.
 * Use when EC2 delivery is stuck on expired rows.
 *
 * IMPORTANT: Merges onto local canonical match state (delivery / current.json)
 * and re-applies Admin Match URL overrides. Never starts from an empty merge
 * base — that would wipe matchUrl / streams / search state.
 */
require('dotenv').config();
const { ConfigLoader } = require('../src/services/configLoader');
const { Normalizer } = require('../src/utils/normalize');
const { FixtureService } = require('../src/services/fixtureService');
const { CacheService } = require('../src/services/cacheService');
const { GitHubService } = require('../src/services/githubService');
const { generateFlutterJson } = require('../src/services/jsonGenerator');
const { buildDeliveryBundle } = require('../src/services/deliveryFormats');
const {
  syncMatchesForDelivery,
  readExistingMatches,
} = require('../src/services/matchesSyncService');
const { OverrideService } = require('../src/admin/services/overrideService');
const { isTodayOrTomorrow } = require('../src/utils/time');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
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
  const existing = readExistingMatches(cache);
  const previous = cache.getDelivery('matches');
  const extras = {
    highlights: cache.getCurrent()?.highlights || cache.getDelivery('highlight1')?.highlights || [],
    channels: cache.getCurrent()?.channels || cache.getDelivery('myanmartv') || [],
  };

  // Local delivery/current is the merge base — never [].
  const sync = syncMatchesForDelivery(existing, todayTomorrow, { normalizer });
  console.log(
    'sync final',
    sync.matches.length,
    'existing',
    existing.length,
    'removedExpired',
    sync.removedExpired,
    'updated',
    sync.matchesUpdated,
    'added',
    sync.matchesAdded
  );

  // Admin match-overrides.json is authoritative for manual Match URLs / streams.
  const overrides = new OverrideService();
  const withOverrides = overrides.applyToMatches(sync.matches);

  const payload = generateFlutterJson(
    withOverrides,
    {
      configOrigin: 'manual_refresh',
      sources: [],
      sync: {
        removedExpired: sync.removedExpired,
        streamsAdded: sync.streamsAdded || 0,
        matchesAdded: sync.matchesAdded,
        matchesUpdated: sync.matchesUpdated,
        existingBaseline: existing.length,
      },
    },
    extras
  );

  if (dryRun) {
    console.log('dry-run: skip cache write and GitHub upload');
    console.log(
      'sample',
      (payload.matches || []).slice(0, 5).map((m) => ({
        id: m.matchId,
        matchUrl: m.matchUrl,
        streams: (m.streams || []).length,
        pages: Object.keys(m.sourcePages || {}).length,
      }))
    );
    return;
  }

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
    withOverrides.slice(0, 5).map((m) => `${m.date} ${m.time} ${m.homeTeam} vs ${m.awayTeam}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
