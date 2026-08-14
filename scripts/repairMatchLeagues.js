/**
 * Repair mislabeled leagues in local delivery matches.json using originalNames
 * (e.g. TAN Premier League wrongly stored as EPL), then optionally push leagues
 * config + republish via a pipeline force run.
 *
 *   node scripts/repairMatchLeagues.js
 *   node scripts/repairMatchLeagues.js --sync-leagues
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Normalizer } = require('../src/utils/normalize');
const { ConfigAdminService } = require('../src/admin/services/configAdminService');

async function main() {
  const syncLeagues = process.argv.includes('--sync-leagues');
  const leaguesPath = path.resolve(process.cwd(), 'config/leagues.json');
  const matchesPath = path.resolve(process.cwd(), 'data/delivery/matches.json');

  const leaguesDoc = JSON.parse(fs.readFileSync(leaguesPath, 'utf8'));
  const normalizer = new Normalizer({
    leagues: leaguesDoc.allowedLeagues || [],
    teams: [],
  });

  if (syncLeagues) {
    const cfg = new ConfigAdminService();
    const result = await cfg.saveLeaguesConfig(leaguesDoc, {
      actor: 'repairMatchLeagues',
      message: 'chore: sync leagues.json (Armenian/Tanzanian Premier League)',
    });
    console.log('leagues sync:', result);
  }

  if (!fs.existsSync(matchesPath)) {
    console.log('No local data/delivery/matches.json — skip local repair.');
    console.log(
      'Deploy/restart the AWS server so the pipeline picks up normalize + leagues fixes.'
    );
    return;
  }

  const doc = JSON.parse(fs.readFileSync(matchesPath, 'utf8'));
  let repaired = 0;
  doc.matches = (doc.matches || []).map((m) => {
    const next = normalizer.repairMatchLeague(m);
    if (next.league !== m.league) {
      repaired += 1;
      console.log(`${m.matchId}: ${m.league} → ${next.league}`);
    }
    return next;
  });
  doc.generatedAt = new Date().toISOString();
  fs.writeFileSync(matchesPath, JSON.stringify(doc, null, 2), 'utf8');
  console.log(`Repaired ${repaired} match league label(s) in ${matchesPath}`);
  console.log(
    'Note: Flutter still reads GitHub until you restart/redeploy AWS and let the pipeline publish.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
