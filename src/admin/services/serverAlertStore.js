const path = require('path');
const { JsonStore } = require('../store/jsonStore');

const MAX_ALERTS = 200;

function alertsFile(dataDir = path.resolve(process.cwd(), 'data/admin')) {
  return path.join(dataDir, 'server-alerts.json');
}

function openStore(dataDir) {
  return new JsonStore(alertsFile(dataDir), { alerts: [] });
}

/**
 * Keep a copy of a server alert (the same text sent to Telegram)
 * so the admin panel can show it.
 */
function recordServerAlert(entry = {}, dataDir) {
  const key = String(entry.key || 'alert');
  const fingerprint = String(entry.fingerprint || entry.text || '').slice(0, 500);
  const text = String(entry.text || '');
  const title = text.split('\n')[0].trim() || 'Server alert';
  const now = Date.now();
  const cooldownMs = Number(process.env.TELEGRAM_ALERT_COOLDOWN_MS || 15 * 60 * 1000);
  const store = openStore(dataDir);
  let saved = null;

  store.update((doc) => {
    const alerts = Array.isArray(doc.alerts) ? doc.alerts : [];
    const prev = alerts.find((row) => row.key === key);
    if (prev && prev.fingerprint === fingerprint) {
      const age = now - Date.parse(prev.at || 0);
      if (Number.isFinite(age) && age >= 0 && age < cooldownMs) return doc;
    }
    saved = {
      id: String(now),
      at: new Date(now).toISOString(),
      key,
      title,
      body: text,
      fingerprint,
      telegram: entry.telegram === 'failed' ? 'failed' : 'sent',
    };
    doc.alerts = [saved, ...alerts].slice(0, MAX_ALERTS);
    return doc;
  });

  return saved;
}

function listServerAlerts(limit = 100, dataDir) {
  const alerts = openStore(dataDir).read().alerts || [];
  const n = Math.max(1, Math.min(Number(limit) || 100, MAX_ALERTS));
  return alerts.slice(0, n);
}

module.exports = {
  recordServerAlert,
  listServerAlerts,
};
