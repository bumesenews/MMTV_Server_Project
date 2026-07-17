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
    if (
      publicJson &&
      req.method === 'GET' &&
      (req.path === '/matches' ||
        req.path.startsWith('/flutter/') ||
        req.path === '/soco' ||
        req.path === '/highlights' ||
        req.path === '/channels')
    ) {
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

  function sendDelivery(res, feed, fallback = null) {
    const data = cache.getDelivery(feed) ?? fallback;
    if (data == null) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(data);
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
      feeds: {
        matches: '/flutter/matches.json',
        soco: '/flutter/soco.json',
        highlight: '/flutter/highlight.json',
        myanmartv: '/flutter/myanmartv.json',
      },
      endpoints: [
        'GET /api/health',
        'GET /api/matches',
        'GET /flutter/matches.json',
        'GET /flutter/soco.json',
        'GET /flutter/highlight.json',
        'GET /flutter/myanmartv.json',
        'POST /api/pipeline/run',
        'POST /api/admin/auth/login',
        'GET /api/admin/dashboard',
      ],
    });
  });

  // Flutter delivery aliases (same shapes as GitHub raw JSON)
  app.get('/flutter/matches.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    const delivery = cache.getDelivery('matches');
    if (delivery) return res.json(delivery);
    const data = cache.getCurrent();
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(data);
  });

  app.get('/flutter/soco.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'soco');
  });

  app.get('/flutter/highlight.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    const delivery = cache.getDelivery('highlight');
    if (delivery) return res.json(delivery);
    const current = cache.getCurrent();
    if (!current?.highlights) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json({
      source: 'https://hoofoot.com/',
      scraped_at: current.generatedAt || new Date().toISOString(),
      count: current.highlights.length,
      highlights: current.highlights,
    });
  });

  app.get('/flutter/myanmartv.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    const delivery = cache.getDelivery('myanmartv');
    if (delivery) return res.json(delivery);
    const current = cache.getCurrent();
    if (!current?.channels) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(
      current.channels.map((c) => ({
        title: c.title,
        img: c.img || null,
        streamUrl: c.streamUrl || '',
      }))
    );
  });

  // Short aliases
  app.get('/flutter/channels.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'myanmartv');
  });

  app.get('/flutter/highlights.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'highlight');
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
