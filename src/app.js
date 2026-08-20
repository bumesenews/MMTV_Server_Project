const express = require('express');
const cors = require('cors');
const path = require('path');
const { createApiRouter } = require('./routes/api');
const { createAdminRouter } = require('./admin/routes/adminRoutes');
const { logger } = require('./utils/logger');

function createApp({ pipeline, cache, admin, env = process.env }) {
  const app = express();
  // Behind nginx/ALB set TRUST_PROXY=1 so req.ip / rate limits stay accurate.
  if (env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }
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
        req.path === '/highlights' ||
        req.path === '/channels' ||
        req.path === '/tips')
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
        mainlive: '/flutter/mainlive.json',
        matches: '/flutter/matches.json',
        highlight: '/flutter/highlight1.json',
        highlight1: '/flutter/highlight1.json',
        highlight2: '/flutter/highlight2.json',
        myanmartv: '/flutter/myanmartv.json',
        tips: '/flutter/tips.json',
      },
      endpoints: [
        'GET /api/health',
        'GET /api/matches',
        'GET /flutter/mainlive.json',
        'GET /flutter/matches.json',
        'GET /flutter/highlight1.json',
        'GET /flutter/highlight2.json',
        'GET /flutter/myanmartv.json',
        'GET /flutter/tips.json',
        'POST /api/pipeline/run',
        'POST /api/admin/auth/login',
        'GET /api/admin/dashboard',
      ],
    });
  });

  // Flutter delivery aliases (same shapes as GitHub raw JSON)
  app.get('/flutter/mainlive.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'mainlive');
  });

  app.get('/flutter/matches.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    const delivery = cache.getDelivery('matches');
    if (delivery) return res.json(delivery);
    const data = cache.getCurrent();
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(data);
  });

  app.get('/flutter/highlight.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'highlight1', cache.getDelivery('highlight'));
  });

  app.get('/flutter/highlight1.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'highlight1', cache.getDelivery('highlight'));
  });

  app.get('/flutter/highlight2.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'highlight2');
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

  app.get('/flutter/tips.json', (req, res) => {
    if (!publicJson && !requireApiKey(req, res)) return;
    return sendDelivery(res, 'tips');
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
