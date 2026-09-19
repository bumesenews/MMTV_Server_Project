const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { AdminUserService } = require('../src/admin/services/adminUserService');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-pw-'));
  const users = new AdminUserService(dir, { NODE_ENV: 'test', ADMIN_JWT_SECRET: 'test-secret' });
  let failed = 0;
  const assert = (ok, name) => {
    if (!ok) {
      failed += 1;
      console.error(`FAIL ${name}`);
    } else {
      console.log(`ok   ${name}`);
    }
  };

  const created = await users.createUser({
    username: 'admin',
    password: 'oldpass1',
    role: 'super_admin',
  });

  try {
    await users.changeOwnPassword(created.id, {
      currentPassword: 'wrong',
      newPassword: 'newpass1',
    });
    assert(false, 'rejects wrong current password');
  } catch (err) {
    assert(err.message === 'Current password is incorrect', 'rejects wrong current password');
  }

  try {
    await users.changeOwnPassword(created.id, {
      currentPassword: 'oldpass1',
      newPassword: 'admin123',
    });
    assert(false, 'rejects weak new password');
  } catch (err) {
    assert(err.message === 'Choose a stronger password', 'rejects weak new password');
  }

  await users.changeOwnPassword(created.id, {
    currentPassword: 'oldpass1',
    newPassword: 'newpass1',
  });
  const stored = users.findById(created.id);
  assert(await bcrypt.compare('newpass1', stored.passwordHash), 'updates hash for own password');
  assert(!(await bcrypt.compare('oldpass1', stored.passwordHash)), 'old password no longer matches');

  const editor = await users.createUser({
    username: 'editor1',
    password: 'editor1pass',
    role: 'editor',
  });
  await users.setPassword(editor.id, 'editor2pass');
  const editorStored = users.findById(editor.id);
  assert(await bcrypt.compare('editor2pass', editorStored.passwordHash), 'super admin reset updates hash');

  try {
    await users.createUser({ username: 'weakling', password: 'admin123', role: 'editor' });
    assert(false, 'createUser rejects admin123');
  } catch (err) {
    assert(err.message === 'Choose a stronger password', 'createUser rejects admin123');
  }

  if (failed) {
    process.exitCode = 1;
    console.error(`${failed} failed`);
  } else {
    console.log('all passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
