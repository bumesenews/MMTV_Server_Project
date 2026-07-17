const express = require('express');
const cors = require('cors');
const path = require('path');
const { createApiRouter } = require('./routes/api');
const { createAdminRouter } = require('./admin/routes/adminRoutes');
const { logger } = require('./utils/logger');

function createApp({ pipeline, cache, admin, env = process.env }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const apiKey = env.API_KEY || '';
  const publicJson = env.ENABLE_PUBLIC_JSON === 'true';

  function requireApiKey(req, res) {
    if (publicJson && req.path === '/matches' && req.method === 'GET') {
      return true;
    }
    if (!apiKey) return true;
    const header = req.header('x-api-key') || req.query.apiKey;
    if (header !== apiKey) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // Admin web UI
  const adminPublic = path.resolve(process.cwd(), 'public/admin');
  app.use('/admin', express.static(adminPublic));
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(adminPublic, 'index.html'));
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'Football Live Streaming Backend',
      timezone: 'Asia/Yangon',
      adminPanel: '/admin',
      endpoints: [
        'GET /api/health',
        'GET /api/matches',
        'GET /flutter/matches.json',
        'POST /api/pipeline/run',
        'POST /api/admin/auth/login',
        'GET /api/admin/dashboard',
      ],
    });
  });

  app.get('/flutter/matches.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    const data = cache.getCurrent();
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(data);
  });

  app.use('/api', createApiRouter({ pipeline, cache, requireApiKey }));

  if (admin) {
    app.use('/api/admin', createAdminRouter(admin));
  }

  app.use((err, _req, res, _next) => {
    logger.error('Express error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
