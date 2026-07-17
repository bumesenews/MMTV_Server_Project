require('dotenv').config();

const { AdminUserService } = require('../admin/services/adminUserService');
const { ROLES } = require('../admin/auth/jwt');

async function main() {
  const users = new AdminUserService();
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';

  const existing = users.findByUsername(username);
  if (existing) {
    console.log(`Admin already exists: ${username} (${existing.role})`);
    process.exit(0);
  }

  const user = await users.createUser({
    username,
    password,
    role: ROLES.SUPER_ADMIN,
    displayName: 'Administrator',
  });

  console.log('Seeded admin user:');
  console.log(`  username: ${user.username}`);
  console.log(`  role:     ${user.role}`);
  console.log(`  password: (from ADMIN_PASSWORD / default admin123)`);
  console.log('Open /admin and login.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
