/**
 * FotMob CDN logos.
 *
 * Team logos use team IDs from the matches feed.
 * League logos use the league *page* id (e.g. Club Friendlies = 489),
 * which is often different from the matches-feed id (915708).
 * Using the feed id returns 403 and Flutter shows no icon.
 */
const leaguesDoc = require('../../config/leagues.json');

const FOTMOB_TEAM_LOGO = 'https://images.fotmob.com/image_resources/logo/teamlogo';
const FOTMOB_LEAGUE_LOGO = 'https://images.fotmob.com/image_resources/logo/leaguelogo';

/** Matches-API league id → logo/page id when they differ. */
const LIST_ID_TO_LOGO_ID = {
  915708: 489, // Club Friendlies
  938330: 9265, // ASEAN Championship
};

function teamLogoUrl(teamId) {
  if (teamId == null || teamId === '') return null;
  return `${FOTMOB_TEAM_LOGO}/${teamId}.png`;
}

function leagueLogoUrl(logoId) {
  if (logoId == null || logoId === '') return null;
  const id = Number(logoId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return `${FOTMOB_LEAGUE_LOGO}/${id}.png`;
}

function leagueDefs() {
  return leaguesDoc.allowedLeagues || [];
}

function leagueDefFor(match = {}) {
  const name = String(match.league || match.leagueName || '').trim();
  if (name) {
    const byName = leagueDefs().find((l) => l.standardName === name);
    if (byName) return byName;
  }
  const id = Number(match.leagueFotmobId || match.leagueId);
  if (!Number.isFinite(id)) return null;
  return (
    leagueDefs().find(
      (l) =>
        Number(l.logoFotmobId) === id ||
        (l.fotmobIds || []).some((fid) => Number(fid) === id)
    ) || null
  );
}

function resolveLeagueLogoId(match = {}) {
  const def = leagueDefFor(match);
  if (def?.logoFotmobId) return Number(def.logoFotmobId);
  const feedId = Number(match.leagueFotmobId || match.leagueId);
  if (Number.isFinite(feedId) && LIST_ID_TO_LOGO_ID[feedId]) {
    return LIST_ID_TO_LOGO_ID[feedId];
  }
  if (Number.isFinite(feedId) && feedId > 0) return feedId;
  return null;
}

function resolveLeagueIcon(match = {}) {
  if (match.leagueIcon) return match.leagueIcon;
  return leagueLogoUrl(resolveLeagueLogoId(match));
}

module.exports = {
  FOTMOB_LEAGUE_LOGO,
  LIST_ID_TO_LOGO_ID,
  teamLogoUrl,
  leagueLogoUrl,
  resolveLeagueLogoId,
  resolveLeagueIcon,
};
