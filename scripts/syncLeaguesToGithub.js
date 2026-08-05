/**
 * Push local config/leagues.json to GitHub.
 * Run on the AWS host (where GITHUB_* env is set):
 *   node scripts/syncLeaguesToGithub.js
 */
require('dotenv').config();
const { ConfigAdminService } = require('../src/admin/services/configAdminService');

async function main() {
  const svc = new ConfigAdminService(process.env);
  if (!svc.enabled) {
    console.error('GitHub not configured (GITHUB_TOKEN / OWNER / REPO).');
    process.exit(1);
  }
  const local = svc.readLocalFile('leagues.json');
  const count = local?.content?.allowedLeagues?.length || 0;
  console.log(`Syncing ${count} local leagues to GitHub…`);
  const result = await svc.syncLocalLeaguesToGithub({ actor: 'script' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
