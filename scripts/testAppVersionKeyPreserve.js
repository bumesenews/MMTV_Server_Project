const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppVersionAdminService } = require('../src/admin/services/appVersionAdminService');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ver-'));
  const svc = new AppVersionAdminService({
    APP_VERSION_LOCAL_PATH: path.join(dir, 'app-version.json'),
    APP_VERSION_GITHUB_TOKEN: '',
  });
  let failed = 0;
  const check = (ok, name) => {
    if (!ok) {
      failed += 1;
      console.error(`FAIL ${name}`);
    } else {
      console.log(`ok   ${name}`);
    }
  };

  await svc.save({
    title: 'A',
    subtitle: 'B',
    link: 'https://example.com',
    uriversion: '1.0.0',
    uriversionDetails: 'notes',
    key: 'keep-me-key',
  });
  check(svc.readLocal().content.key === 'keep-me-key', 'stores key');

  const saved = await svc.save({
    title: 'Updated title',
    subtitle: 'B',
    link: 'https://example.com',
    uriversion: '1.0.1',
    uriversionDetails: 'notes',
  });
  check(saved.content.key === 'keep-me-key', 'save without key keeps previous');
  check(saved.content.title === 'Updated title', 'other fields still update');
  check(svc.readLocal().content.key === 'keep-me-key', 'local file still has key');

  const blank = await svc.save({
    title: 'Updated title',
    subtitle: 'B',
    link: 'https://example.com',
    uriversion: '1.0.1',
    uriversionDetails: 'notes',
    key: '',
  });
  check(blank.content.key === 'keep-me-key', 'empty key string keeps previous');

  if (failed) process.exitCode = 1;
  else console.log('all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
