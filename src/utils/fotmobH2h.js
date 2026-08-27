const { DateTime } = require('luxon');

const EMPTY_H2H = Object.freeze({
  summary: Object.freeze({ homeWins: 0, draws: 0, awayWins: 0 }),
  matches: Object.freeze([]),
});

const H2H_MATCH_LIMIT = 5;

/**
 * Normalize a team-pair cache key so A_B and B_A share one lookup.
 * @returns {string|null}
 */
function h2hPairKey(homeTeamId, awayTeamId) {
  const a = Number(homeTeamId);
  const b = Number(awayTeamId);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function emptyH2h() {
  return {
    summary: { homeWins: 0, draws: 0, awayWins: 0 },
    matches: [],
  };
}

function parseScoreStr(scoreStr) {
  const m = String(scoreStr || '')
    .trim()
    .match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m) return null;
  return { homeScore: Number(m[1]), awayScore: Number(m[2]) };
}

function formatH2hDate(utcTime) {
  if (!utcTime) return '';
  const dt = DateTime.fromISO(String(utcTime), { zone: 'utc' });
  if (!dt.isValid) return '';
  return dt.toFormat('yyyy-MM-dd');
}

function isCompletedH2hMatch(row) {
  if (!row || typeof row !== 'object') return false;
  const status = row.status || {};
  if (status.cancelled === true) return false;
  if (status.finished !== true && row.finished !== true) return false;
  // Prefer explicit FT/AET/PEN reasons when present
  const reason = String(status.reason?.short || status.reason?.long || '');
  if (reason && /postponed|cancelled|canceled|abandoned|sched/i.test(reason)) {
    return false;
  }
  return Boolean(status.scoreStr || (row.home?.score != null && row.away?.score != null));
}

/**
 * Normalize one FotMob H2H row into the delivery shape.
 * Returns null when required fields are missing or the match is not completed.
 */
function normalizeH2hMatch(row) {
  if (!isCompletedH2hMatch(row)) return null;

  const homeTeamId = Number(row.home?.id);
  const awayTeamId = Number(row.away?.id);
  if (!Number.isFinite(homeTeamId) || !Number.isFinite(awayTeamId)) return null;

  let homeScore =
    row.home?.score != null && row.home.score !== ''
      ? Number(row.home.score)
      : null;
  let awayScore =
    row.away?.score != null && row.away.score !== ''
      ? Number(row.away.score)
      : null;

  if (homeScore == null || awayScore == null || Number.isNaN(homeScore) || Number.isNaN(awayScore)) {
    const parsed = parseScoreStr(row.status?.scoreStr);
    if (!parsed) return null;
    homeScore = parsed.homeScore;
    awayScore = parsed.awayScore;
  }

  const date = formatH2hDate(row.status?.utcTime || row.time?.utcTime);
  const homeTeam = String(row.home?.name || '').trim();
  const awayTeam = String(row.away?.name || '').trim();
  const competition = String(row.league?.name || row.tournament?.name || '').trim();

  if (!date || !homeTeam || !awayTeam || !competition) return null;

  return {
    date,
    homeTeam,
    awayTeam,
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    competition,
  };
}

/**
 * Build summary from historical matches using the CURRENT fixture's home/away IDs.
 * (If a historical match had sides reversed, still attribute the win to the current home/away.)
 */
function summarizeH2h(matches, currentHomeId, currentAwayId) {
  const homeId = Number(currentHomeId);
  const awayId = Number(currentAwayId);
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;

  for (const m of matches || []) {
    const histHome = Number(m.homeTeamId);
    const histAway = Number(m.awayTeamId);
    const hs = Number(m.homeScore);
    const as = Number(m.awayScore);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

    if (hs === as) {
      draws += 1;
      continue;
    }

    const winnerId = hs > as ? histHome : histAway;
    if (winnerId === homeId) homeWins += 1;
    else if (winnerId === awayId) awayWins += 1;
  }

  return { homeWins, draws, awayWins };
}

/**
 * Extract H2H from a FotMob matchDetails payload for a specific fixture orientation.
 */
function buildH2hFromMatchDetails(details, currentHomeId, currentAwayId, limit = H2H_MATCH_LIMIT) {
  const rawList = details?.content?.h2h?.matches;
  if (!Array.isArray(rawList)) {
    return emptyH2h();
  }

  const normalized = [];
  for (const row of rawList) {
    const item = normalizeH2hMatch(row);
    if (item) normalized.push(item);
  }

  // Newest first (FotMob usually already is; enforce anyway)
  normalized.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Keep only meetings that involve both current team IDs (ID-based, not names)
  const homeId = Number(currentHomeId);
  const awayId = Number(currentAwayId);
  const pairOk = normalized.filter((m) => {
    const ids = new Set([Number(m.homeTeamId), Number(m.awayTeamId)]);
    return ids.has(homeId) && ids.has(awayId);
  });

  const matches = pairOk.slice(0, Math.max(0, Number(limit) || H2H_MATCH_LIMIT));

  return {
    summary: summarizeH2h(matches, currentHomeId, currentAwayId),
    matches,
  };
}

/**
 * Recompute summary for a cached H2H match list under a new home/away orientation.
 */
function reorientH2h(base, currentHomeId, currentAwayId) {
  if (!base || !Array.isArray(base.matches)) return emptyH2h();
  return {
    summary: summarizeH2h(base.matches, currentHomeId, currentAwayId),
    matches: base.matches,
  };
}

module.exports = {
  EMPTY_H2H,
  H2H_MATCH_LIMIT,
  h2hPairKey,
  emptyH2h,
  parseScoreStr,
  normalizeH2hMatch,
  summarizeH2h,
  buildH2hFromMatchDetails,
  reorientH2h,
};
