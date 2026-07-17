const { verifyToken, hasMinRole, ROLES } = require('./jwt');

function authRequired(env = process.env) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing token' });
    }
    try {
      req.admin = verifyToken(token, env);
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }
  };
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.admin || !hasMinRole(req.admin.role, minRole)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    return next();
  };
}

module.exports = {
  authRequired,
  requireRole,
  ROLES,
};
