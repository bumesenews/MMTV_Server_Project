/**
 * Create config/admin-match.json on GitHub if it is missing.
 * Run: node scripts/seedAdminMatchGithub.js
 */
require('dotenv').config();
const { ConfigAdminService } = require('../src/admin/services/configAdminService');

(async () => {
  const config = new ConfigAdminService();
  if (!config.enabled) {
    console.error('GitHub is not configured (GITHUB_TOKEN / OWNER / REPO).');
    process.exit(1);
  }
  const before = await config.getRemoteFile(config.adminMatchFile);
  if (before) {
    console.log(`Already on GitHub: ${before.path} (${(before.content.matches || []).length} entries)`);
    process.exit(0);
  }
  const saved = await config.saveAdminMatchConfig(
    { version: 1, matches: [] },
    { actor: 'seed', message: 'chore: create config/admin-match.json' }
  );
  console.log(JSON.stringify({
    uploaded: saved.uploaded,
    origin: saved.origin,
    reason: saved.reason || null,
    htmlUrl: saved.htmlUrl || null,
    path: `${config.configPath}/${config.adminMatchFile}`,
  }, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
