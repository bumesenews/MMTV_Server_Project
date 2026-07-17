const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { JsonStore } = require('../store/jsonStore');
const { ROLES, signToken } = require('../auth/jwt');

function newId() {
  return crypto.randomUUID();
}

class AdminUserService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin'), env = process.env) {
    this.env = env;
    this.store = new JsonStore(path.join(dataDir, 'admins.json'), { users: [] });
  }

  list() {
    return (this.store.read().users || []).map(sanitizeUser);
  }

  findByUsername(username) {
    return (this.store.read().users || []).find(
      (u) => u.username.toLowerCase() === String(username || '').toLowerCase()
    );
  }

  findById(id) {
    return (this.store.read().users || []).find((u) => u.id === id);
  }

  async ensureSeedAdmin() {
    const users = this.store.read().users || [];
    if (users.length) return sanitizeUser(users[0]);

    const username = this.env.ADMIN_USERNAME || 'admin';
    const password = this.env.ADMIN_PASSWORD || 'admin123';
    const user = await this.createUser({
      username,
      password,
      role: ROLES.SUPER_ADMIN,
      displayName: 'Administrator',
    });
    return user;
  }

  async createUser({ username, password, role = ROLES.EDITOR, displayName = '' }) {
    if (!username || !password) throw new Error('username and password required');
    if (this.findByUsername(username)) throw new Error('Username already exists');
    if (!Object.values(ROLES).includes(role)) throw new Error('Invalid role');

    const user = {
      id: newId(),
      username: String(username).trim(),
      displayName: displayName || username,
      role,
      passwordHash: await bcrypt.hash(String(password), 10),
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.store.update((doc) => {
      doc.users = [...(doc.users || []), user];
      return doc;
    });

    return sanitizeUser(user);
  }

  async updateUser(id, patch = {}) {
    let updated = null;
    this.store.update((doc) => {
      const users = doc.users || [];
      const idx = users.findIndex((u) => u.id === id);
      if (idx < 0) throw new Error('User not found');
      const user = { ...users[idx] };
      if (patch.displayName != null) user.displayName = patch.displayName;
      if (patch.role != null) {
        if (!Object.values(ROLES).includes(patch.role)) throw new Error('Invalid role');
        user.role = patch.role;
      }
      if (patch.active != null) user.active = Boolean(patch.active);
      user.updatedAt = new Date().toISOString();
      users[idx] = user;
      updated = user;
      return { users };
    });
    return sanitizeUser(updated);
  }

  async setPassword(id, password) {
    if (!password || String(password).length < 6) {
      throw new Error('Password must be at least 6 characters');
    }
    const hash = await bcrypt.hash(String(password), 10);
    this.store.update((doc) => {
      const users = doc.users || [];
      const idx = users.findIndex((u) => u.id === id);
      if (idx < 0) throw new Error('User not found');
      users[idx] = {
        ...users[idx],
        passwordHash: hash,
        updatedAt: new Date().toISOString(),
      };
      return { users };
    });
    return true;
  }

  async login(username, password) {
    const user = this.findByUsername(username);
    if (!user || !user.active) throw new Error('Invalid credentials');
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');
    const token = signToken(user, this.env);
    return { token, user: sanitizeUser(user) };
  }
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

module.exports = { AdminUserService, sanitizeUser };
