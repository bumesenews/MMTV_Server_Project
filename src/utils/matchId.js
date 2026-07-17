const { formatKickoffId, toYangon } = require('./time');

function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/**
 * Generate stable matchId from normalized teams + kickoff date (Asia/Yangon).
 * Example: manchester_united_liverpool_20260716
 */
function generateMatchId(homeTeam, awayTeam, kickoff) {
  const home = slugify(homeTeam);
  const away = slugify(awayTeam);
  const datePart = formatKickoffId(kickoff);
  return `${home}_${away}_${datePart}`;
}

function parseMatchId(matchId) {
  const parts = String(matchId || '').split('_');
  if (parts.length < 3) return null;
  const datePart = parts[parts.length - 1];
  const teamParts = parts.slice(0, -1);
  if (!/^\d{8}$/.test(datePart) || teamParts.length < 2) return null;

  // Best-effort split: last two slug segments are unreliable for multi-word teams.
  // Prefer using stored match fields; this is only a helper.
  return { datePart, teamSlug: teamParts.join('_') };
}

function sameMatchDay(a, b) {
  const da = toYangon(a);
  const db = toYangon(b);
  if (!da || !db) return false;
  return da.toFormat('yyyyMMdd') === db.toFormat('yyyyMMdd');
}

module.exports = {
  slugify,
  generateMatchId,
  parseMatchId,
  sameMatchDay,
};
