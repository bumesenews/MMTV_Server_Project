const jwt = require('jsonwebtoken');

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
};

const ROLE_RANK = {
  [ROLES.VIEWER]: 1,
  [ROLES.EDITOR]: 2,
  [ROLES.ADMIN]: 3,
  [ROLES.SUPER_ADMIN]: 4,
};

function getJwtSecret(env = process.env) {
  return env.ADMIN_JWT_SECRET || env.API_KEY || 'change-me-admin-jwt-secret';
}

function signToken(user, env = process.env) {
  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };
  const expiresIn = env.ADMIN_JWT_EXPIRES || '12h';
  return jwt.sign(payload, getJwtSecret(env), { expiresIn });
}

function verifyToken(token, env = process.env) {
  return jwt.verify(token, getJwtSecret(env));
}

function hasMinRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 99);
}

module.exports = {
  ROLES,
  ROLE_RANK,
  getJwtSecret,
  signToken,
  verifyToken,
  hasMinRole,
};
