const fs = require('fs');
const path = require('path');
const { JsonStore } = require('../store/jsonStore');
const { logger } = require('../../utils/logger');

/** Project root: src/admin/services → ../../../ */
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const DEFAULT_SERVICE_ACCOUNT_PATH = path.join(
  PROJECT_ROOT,
  'secrets',
  'firebase-service-account.json'
);

/** Module-level singleton — Firebase Admin must initialize only once (PM2 / multiple imports). */
let sharedMessaging = null;
let sharedInitError = null;
let initAttempted = false;

/**
 * Firebase Cloud Messaging integration.
 * Safe when credentials are missing: app stays up; send() reports a clear error.
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

    const { messaging, error } = initFirebaseAdmin(this.env);
    this.messaging = messaging;
    this.initError = error;
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

  /**
   * Send an FCM topic notification (used by admin routes).
   */
  async send(payload, actor = 'admin') {
    return this.sendNotification(payload, actor);
  }

  async sendNotification(payload, actor = 'admin') {
    const message = this.buildMessage(payload || {});
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
        ok: false,
        dryRun: true,
        error:
          this.initError ||
          'FCM not configured — place secrets/firebase-service-account.json or set FIREBASE_SERVICE_ACCOUNT_JSON',
      };
      logger.warn('FCM send skipped — not initialized', {
        error: result.error,
        topic: message.topic,
        actor,
      });
    } else {
      try {
        const messageId = await this.messaging.send(message);
        result = { ...result, ok: true, messageId };
        logger.info('FCM notification sent', {
          messageId,
          topic: message.topic,
          actor,
        });
      } catch (err) {
        result = { ...result, ok: false, error: err.message };
        logger.error('FCM send failed', {
          error: err.message,
          topic: message.topic,
          actor,
        });
      }
    }

    const entry = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      actor,
      type: payload?.type || 'custom',
      title: message.notification.title,
      body: message.notification.body,
      target: payload?.target || 'all',
      league: payload?.league || null,
      matchId: payload?.matchId || null,
      topic: message.topic,
      result,
    };

    try {
      this.store.update((doc) => {
        doc.history = [entry, ...(doc.history || [])].slice(0, 500);
        return doc;
      });
    } catch (err) {
      logger.error('Failed to persist notification history', { error: err.message });
    }

    if (this.logService) {
      try {
        this.logService.add({
          category: 'notification',
          action: 'send',
          message: `${entry.title} → ${entry.topic}`,
          actor,
          meta: result,
        });
      } catch (err) {
        logger.error('Failed to write admin notification log', { error: err.message });
      }
    }

    return entry;
  }
}

function resolveServiceAccountPath(envPath) {
  if (!envPath || !String(envPath).trim()) {
    return DEFAULT_SERVICE_ACCOUNT_PATH;
  }
  const trimmed = String(envPath).trim();
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  // Relative paths resolve from project root (__dirname-based), not process.cwd()
  // so PM2 / different working directories still find secrets/.
  return path.join(PROJECT_ROOT, trimmed);
}

/**
 * Initialize firebase-admin exactly once for the process.
 */
function initFirebaseAdmin(env = process.env) {
  if (initAttempted) {
    return { messaging: sharedMessaging, error: sharedInitError };
  }
  initAttempted = true;

  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');

    if (admin.apps.length) {
      sharedMessaging = admin.messaging();
      sharedInitError = null;
      logger.info('Firebase Admin already initialized — reusing existing app');
      return { messaging: sharedMessaging, error: null };
    }

    const inline = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (inline && String(inline).trim()) {
      let cred;
      try {
        cred = JSON.parse(inline);
      } catch (parseErr) {
        sharedInitError =
          'FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the full service account JSON as a single line.';
        logger.error(sharedInitError, { error: parseErr.message });
        return { messaging: null, error: sharedInitError };
      }

      admin.initializeApp({ credential: admin.credential.cert(cred) });
      sharedMessaging = admin.messaging();
      sharedInitError = null;
      logger.info('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON', {
        projectId: cred.project_id || null,
      });
      return { messaging: sharedMessaging, error: null };
    }

    const saPath = resolveServiceAccountPath(env.FIREBASE_SERVICE_ACCOUNT_PATH);

    if (!fs.existsSync(saPath)) {
      sharedInitError =
        `Firebase service account file not found at: ${saPath}. ` +
        'Create secrets/firebase-service-account.json under the project root ' +
        '(download from Firebase Console → Project settings → Service accounts → Generate new private key), ' +
        'or set FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT_JSON.';
      logger.warn('Firebase Admin not initialized — missing credentials file', {
        expectedPath: saPath,
        defaultPath: DEFAULT_SERVICE_ACCOUNT_PATH,
        envPath: env.FIREBASE_SERVICE_ACCOUNT_PATH || null,
      });
      return { messaging: null, error: sharedInitError };
    }

    let cred;
    try {
      const raw = fs.readFileSync(saPath, 'utf8');
      cred = JSON.parse(raw);
    } catch (readErr) {
      sharedInitError = `Failed to read/parse Firebase service account at ${saPath}: ${readErr.message}`;
      logger.error(sharedInitError);
      return { messaging: null, error: sharedInitError };
    }

    if (!cred.project_id || !cred.private_key || !cred.client_email) {
      sharedInitError =
        `Firebase service account JSON at ${saPath} is incomplete ` +
        '(need project_id, private_key, client_email). Re-download the key from Firebase Console.';
      logger.error(sharedInitError);
      return { messaging: null, error: sharedInitError };
    }

    admin.initializeApp({ credential: admin.credential.cert(cred) });
    sharedMessaging = admin.messaging();
    sharedInitError = null;
    logger.info('Firebase Admin initialized successfully', {
      path: saPath,
      projectId: cred.project_id,
    });
    return { messaging: sharedMessaging, error: null };
  } catch (err) {
    sharedInitError = `Firebase Admin initialization failed: ${err.message}`;
    sharedMessaging = null;
    logger.error(sharedInitError, { stack: err.stack });
    return { messaging: null, error: sharedInitError };
  }
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

module.exports = {
  NotificationService,
  initFirebaseAdmin,
  DEFAULT_SERVICE_ACCOUNT_PATH,
  PROJECT_ROOT,
};
