const express = require('express');
const { getCheckIntervalMinutes } = require('../utils/time');

function createApiRouter({ pipeline, cache, requireApiKey }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'football-live-streaming-backend',
      timezone: 'Asia/Yangon',
      lastRun: pipeline.lastRun,
      running: pipeline.running,
    });
  });

  router.get('/matches', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const data = cache.getCurrent();
    if (!data) {
      return res.status(404).json({ ok: false, error: 'No cached data yet' });
    }
    return res.json(data);
  });

  router.get('/matches/:matchId', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const data = cache.getCurrent();
    const match = data?.matches?.find((m) => m.matchId === req.params.matchId);
    if (!match) return res.status(404).json({ ok: false, error: 'Match not found' });
    return res.json({
      ok: true,
      match,
      checkIntervalMinutes: getCheckIntervalMinutes(match.kickoff, match.status),
    });
  });

  router.post('/pipeline/run', async (req, res) => {
    if (!requireApiKey(req, res)) return;
    const force = Boolean(req.body?.force || req.query.force);
    const result = await pipeline.run({ forceStreamCheck: force });
    return res.status(result.ok ? 200 : 500).json(result);
  });

  router.get('/cache/current', (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json(cache.getCurrent() || { ok: false, error: 'empty' });
  });

  router.get('/cache/previous', (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json(cache.getPrevious() || { ok: false, error: 'empty' });
  });

  router.get('/feeds', (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json({
      ok: true,
      delivery: cache.getDeliveryBundle(),
    });
  });

  router.get('/feeds/:name', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const name = String(req.params.name || '').toLowerCase();
    const map = {
      matches: 'matches',
      soco: 'soco',
      highlight: 'highlight',
      highlights: 'highlight',
      channels: 'myanmartv',
      myanmartv: 'myanmartv',
    };
    const key = map[name];
    if (!key) return res.status(404).json({ ok: false, error: 'Unknown feed' });
    const data = cache.getDelivery(key);
    if (data == null) return res.status(404).json({ ok: false, error: 'No data' });
    return res.json(data);
  });

  return router;
}

module.exports = { createApiRouter };
