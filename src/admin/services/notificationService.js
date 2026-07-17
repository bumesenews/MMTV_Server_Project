const path = require('path');
const { JsonStore } = require('../store/jsonStore');

/**
 * Firebase Cloud Messaging integration.
 * Works without credentials in dry-run/log mode for local setups.
 */
class NotificationService {
  constructor({
    dataDir = path.resolve(process.cwd(), 'data/admin'),
    env = process.env,
    logService = null,
  } = {}) {
    this.env = env;
    this.logService = logService;
    this.store = new JsonStore(path.join(dataDir, 'notifications.json'), {
      history: [],
      topics: {
        all: 'football_all',
        leaguePrefix: 'league_',
        matchPrefix: 'match_',
      },
    });
    this.messaging = null;
    this.initError = null;
    this._initFirebase();
  }

  _initFirebase() {
    try {
      // Lazy require so missing firebase-admin doesn't crash if unused
      // eslint-disable-next-line global-require
      const admin = require('firebase-admin');
      if (admin.apps.length) {
        this.messaging = admin.messaging();
        return;
      }

      const jsonPath = this.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      const jsonInline = this.env.FIREBASE_SERVICE_ACCOUNT_JSON;

      if (jsonInline) {
        const cred = JSON.parse(jsonInline);
        admin.initializeApp({ credential: admin.credential.cert(cred) });
        this.messaging = admin.messaging();
        return;
      }

      if (jsonPath) {
        // eslint-disable-next-line import/no-dynamic-require, global-require
        const cred = require(path.resolve(process.cwd(), jsonPath));
        admin.initializeApp({ credential: admin.credential.cert(cred) });
        this.messaging = admin.messaging();
        return;
      }

      this.initError = 'Firebase credentials not configured';
    } catch (err) {
      this.initError = err.message;
    }
  }

  templates() {
    return [
      { type: 'live_started', title: 'Live Match Started', body: '{home} vs {away} is LIVE' },
      { type: 'new_stream', title: 'New Stream Available', body: 'New stream for {home} vs {away}' },
      { type: 'stream_updated', title: 'Stream Updated', body: 'Stream updated for {home} vs {away}' },
      { type: 'match_finished', title: 'Match Finished', body: '{home} vs {away} has ended' },
      { type: 'maintenance', title: 'Maintenance Notice', body: 'Scheduled maintenance in progress' },
      { type: 'custom', title: 'Custom Notification', body: '' },
    ];
  }

  history(limit = 100) {
    return (this.store.read().history || []).slice(0, limit);
  }

  buildMessage({ type, title, body, target = 'all', league = null, matchId = null, data = {} }) {
    const topics = this.store.read().topics || {};
    let topic = topics.all || 'football_all';
    if (target === 'league' && league) {
      topic = `${topics.leaguePrefix || 'league_'}${slug(league)}`;
    }
    if (target === 'match' && matchId) {
      topic = `${topics.matchPrefix || 'match_'}${slug(matchId)}`;
    }

    return {
      topic,
      notification: {
        title: title || 'Football Live',
        body: body || '',
      },
      data: {
        type: String(type || 'custom'),
        target: String(target),
        league: league ? String(league) : '',
        matchId: matchId ? String(matchId) : '',
        ...Object.fromEntries(
          Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')])
        ),
      },
    };
  }

  async send(payload, actor = 'admin') {
    const message = this.buildMessage(payload);
    let result = {
      ok: false,
      dryRun: false,
      messageId: null,
      error: null,
      topic: message.topic,
    };

    if (!this.messaging) {
      result = {
        ...result,
        ok: true,
        dryRun: true,
        error: this.initError || 'FCM not configured — logged only',
      };
    } else {
      try {
        const messageId = await this.messaging.send(message);
        result = { ...result, ok: true, messageId };
      } catch (err) {
        result = { ...result, ok: false, error: err.message };
      }
    }

    const entry = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      actor,
      type: payload.type || 'custom',
      title: message.notification.title,
      body: message.notification.body,
      target: payload.target || 'all',
      league: payload.league || null,
      matchId: payload.matchId || null,
      topic: message.topic,
      result,
    };

    this.store.update((doc) => {
      doc.history = [entry, ...(doc.history || [])].slice(0, 500);
      return doc;
    });

    if (this.logService) {
      this.logService.add({
        category: 'notification',
        action: 'send',
        message: `${entry.title} → ${entry.topic}`,
        actor,
        meta: result,
      });
    }

    return entry;
  }
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

module.exports = { NotificationService };
