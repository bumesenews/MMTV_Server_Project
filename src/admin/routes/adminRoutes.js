const express = require('express');
const { authRequired, requireRole, ROLES } = require('../auth/middleware');
const { formatDate, formatTime, toYangon } = require('../../utils/time');

function createAdminRouter(ctx) {
  const router = express.Router();
  const auth = authRequired(ctx.env);
  const editor = requireRole(ROLES.EDITOR);
  const admin = requireRole(ROLES.ADMIN);

  // ---------- Auth ----------
  router.post('/auth/login', async (req, res) => {
    try {
      await ctx.users.ensureSeedAdmin();
      const result = await ctx.users.login(req.body?.username, req.body?.password);
      ctx.logService.add({
        category: 'admin',
        action: 'login',
        message: `Login ${result.user.username}`,
        actor: result.user.username,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(401).json({ ok: false, error: err.message });
    }
  });

  router.get('/auth/me', auth, (req, res) => {
    const user = ctx.users.findById(req.admin.sub);
    if (!user) return res.status(401).json({ ok: false, error: 'User not found' });
    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        active: user.active,
      },
    });
  });

  // ---------- Dashboard ----------
  router.get('/dashboard', auth, (_req, res) => {
    res.json({ ok: true, dashboard: ctx.dashboard.get() });
  });

  // ---------- Matches ----------
  router.get('/matches', auth, (_req, res) => {
    const current = ctx.cache.getCurrent();
    const overrides = ctx.overrides.all();
    const matches = (current?.matches || []).map((m) => ({
      ...m,
      override: overrides[m.matchId] || null,
    }));
    // Include hidden matches for admin (from overrides even if filtered out of public JSON)
    for (const [matchId, ov] of Object.entries(overrides)) {
      if (ov.hidden && !matches.find((m) => m.matchId === matchId)) {
        matches.push({
          matchId,
          hidden: true,
          override: ov,
          homeTeam: '(hidden)',
          awayTeam: '',
          league: '',
          status: ov.status || 'Scheduled',
          streams: ov.manualStreams || [],
        });
      }
    }
    res.json({ ok: true, matches, generatedAt: current?.generatedAt || null });
  });

  router.patch('/matches/:matchId', auth, editor, async (req, res) => {
    try {
      const { matchId } = req.params;
      const patch = req.body || {};
      if (patch.kickoff) {
        const dt = toYangon(patch.kickoff);
        if (dt) {
          patch.kickoff = dt.toISO();
          patch.date = formatDate(dt);
          patch.time = formatTime(dt);
        }
      }
      const override = ctx.overrides.updateMatch(matchId, patch);

      // Also patch in-memory/current cache fields before republish
      const current = ctx.cache.getCurrent();
      if (current?.matches) {
        const idx = current.matches.findIndex((m) => m.matchId === matchId);
        if (idx >= 0) {
          current.matches[idx] = {
            ...current.matches[idx],
            ...(patch.status != null ? { status: patch.status } : {}),
            ...(patch.kickoff ? { kickoff: patch.kickoff, date: patch.date, time: patch.time } : {}),
          };
          ctx.cache.writeJson(ctx.cache.currentPath, current);
        }
      }

      const published = await ctx.publish.republishFromCache({
        actor: req.admin.username,
        meta: { reason: 'match_update' },
      });

      ctx.logService.add({
        category: 'admin',
        action: 'match_update',
        message: `Updated match ${matchId}`,
        actor: req.admin.username,
        meta: patch,
      });

      res.json({ ok: true, override, published });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ---------- Manual streams ----------
  router.get('/matches/:matchId/streams', auth, (req, res) => {
    const ov = ctx.overrides.get(req.params.matchId);
    res.json({ ok: true, manualStreams: ov?.manualStreams || [] });
  });

  router.post('/matches/:matchId/streams', auth, editor, async (req, res) => {
    try {
      const stream = ctx.overrides.addManualStream(req.params.matchId, req.body || {});
      const published = await ctx.publish.republishFromCache({
        actor: req.admin.username,
        meta: { reason: 'manual_stream_add' },
      });
      ctx.logService.add({
        category: 'manual_stream',
        action: 'add',
        message: `Added manual stream for ${req.params.matchId}`,
        actor: req.admin.username,
        meta: { streamId: stream.id, url: stream.url },
      });
      res.json({ ok: true, stream, published });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.patch('/matches/:matchId/streams/:streamId', auth, editor, async (req, res) => {
    try {
      const stream = ctx.overrides.updateManualStream(
        req.params.matchId,
        req.params.streamId,
        req.body || {}
      );
      const published = await ctx.publish.republishFromCache({
        actor: req.admin.username,
        meta: { reason: 'manual_stream_update' },
      });
      ctx.logService.add({
        category: 'manual_stream',
        action: 'update',
        message: `Updated manual stream ${req.params.streamId}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, stream, published });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.delete('/matches/:matchId/streams/:streamId', auth, editor, async (req, res) => {
    try {
      ctx.overrides.removeManualStream(req.params.matchId, req.params.streamId);
      const published = await ctx.publish.republishFromCache({
        actor: req.admin.username,
        meta: { reason: 'manual_stream_delete' },
      });
      ctx.logService.add({
        category: 'manual_stream',
        action: 'delete',
        message: `Removed manual stream ${req.params.streamId}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, published });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ---------- Leagues ----------
  router.get('/leagues', auth, (_req, res) => {
    res.json({ ok: true, leagues: ctx.leagues.list() });
  });

  router.patch('/leagues/:name', auth, editor, async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name);
      const league = ctx.leagues.setEnabled(name, req.body?.enabled !== false);
      const published = await ctx.publish.republishFromCache({
        actor: req.admin.username,
        meta: { reason: 'league_toggle' },
      });
      ctx.logService.add({
        category: 'admin',
        action: 'league_toggle',
        message: `${name} enabled=${league.enabled}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, league, published });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ---------- Sources ----------
  router.get('/sources', auth, async (_req, res) => {
    try {
      let remote = null;
      try {
        remote = await ctx.config.getSourcesConfig();
      } catch {
        remote = null;
      }
      const local = ctx.sources.list(remote?.content || null);
      res.json({
        ok: true,
        sources: local,
        config: remote?.content || null,
        configOrigin: remote?.origin || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.patch('/sources/:name/enabled', auth, editor, async (req, res) => {
    try {
      const source = ctx.sources.setEnabled(req.params.name, req.body?.enabled !== false);
      // Mirror enabled flag into sources.json (local + GitHub)
      await ctx.config.updateSourceEntry(
        req.params.name,
        { enabled: source.enabled },
        { actor: req.admin.username, message: `chore: ${req.params.name} enabled=${source.enabled}` }
      );
      ctx.logService.add({
        category: 'admin',
        action: 'source_toggle',
        message: `${req.params.name} enabled=${source.enabled}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, source });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.put('/sources/config', auth, admin, async (req, res) => {
    try {
      const content = req.body?.content || req.body;
      if (!content?.sources) throw new Error('Invalid sources.json payload');
      const result = await ctx.config.saveSourcesConfig(content, {
        actor: req.admin.username,
        message: req.body?.message,
      });
      ctx.logService.add({
        category: 'admin',
        action: 'config_save',
        message: 'Saved sources.json',
        actor: req.admin.username,
        meta: result,
      });
      res.json({ ok: true, ...result, content });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.patch('/sources/:name/config', auth, admin, async (req, res) => {
    try {
      const result = await ctx.config.updateSourceEntry(req.params.name, req.body || {}, {
        actor: req.admin.username,
      });
      ctx.logService.add({
        category: 'admin',
        action: 'source_config',
        message: `Updated config for ${req.params.name}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ---------- Notifications ----------
  router.get('/notifications/templates', auth, (_req, res) => {
    res.json({ ok: true, templates: ctx.notifications.templates() });
  });

  router.get('/notifications/history', auth, (req, res) => {
    res.json({
      ok: true,
      history: ctx.notifications.history(Number(req.query.limit) || 100),
      fcmReady: Boolean(ctx.notifications.messaging),
      fcmError: ctx.notifications.initError,
    });
  });

  router.post('/notifications/send', auth, editor, async (req, res) => {
    try {
      const entry = await ctx.notifications.send(req.body || {}, req.admin.username);
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ---------- Logs ----------
  router.get('/logs', auth, (req, res) => {
    res.json({
      ok: true,
      logs: ctx.logService.list({
        limit: Number(req.query.limit) || 200,
        category: req.query.category || null,
      }),
    });
  });

  // ---------- Pipeline ----------
  router.post('/pipeline/run', auth, editor, async (req, res) => {
    try {
      const result = await ctx.pipeline.run({
        forceStreamCheck: Boolean(req.body?.force),
      });
      ctx.logService.add({
        category: 'scraper',
        action: 'manual_run',
        message: `Pipeline run ok=${result.ok}`,
        actor: req.admin.username,
        meta: { reason: result.reason, matchCount: result.payload?.matches?.length },
      });

      if (result.reason === 'already_running') {
        return res.status(409).json({
          ok: false,
          error: 'Scraper already running. Wait for the current run to finish, then try again.',
          reason: 'already_running',
        });
      }

      if (!result.ok) {
        return res.status(500).json({
          ...result,
          error: result.reason || 'Pipeline failed',
        });
      }

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---------- Users ----------
  router.get('/users', auth, admin, (_req, res) => {
    res.json({ ok: true, users: ctx.users.list() });
  });

  router.post('/users', auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
      const user = await ctx.users.createUser(req.body || {});
      ctx.logService.add({
        category: 'admin',
        action: 'user_create',
        message: `Created user ${user.username}`,
        actor: req.admin.username,
      });
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.patch('/users/:id', auth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
    try {
      const user = await ctx.users.updateUser(req.params.id, req.body || {});
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
