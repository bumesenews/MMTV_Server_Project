const axios = require('axios');
const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { cleanText } = require('../utils/normalize');
const {
  toYangon,
  formatDate,
  formatTime,
  isTodayOrTomorrow,
  todayYangon,
  tomorrowYangon,
  nowYangon,
} = require('../utils/time');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

/**
 * FotMob fixture source ONLY — never collect streaming URLs here.
 */
class FotMobSource {
  constructor({ config, normalizer }) {
    this.name = 'fotmob';
    this.config = config || {};
    this.normalizer = normalizer;
    this.client = axios.create({
      timeout: 20000,
      headers: {
        'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(this.config.headers || {}),
      },
    });
  }

  get domains() {
    return this.config.domains || ['https://www.fotmob.com'];
  }

  dateKeys() {
    return [todayYangon().toFormat('yyyyMMdd'), tomorrowYangon().toFormat('yyyyMMdd')];
  }

  async fetchMatchesForDate(dateKey) {
    // FotMob current endpoint: /api/data/matches (legacy /api/matches returns 404)
    const candidates = [
      this.config.api?.matches,
      `${this.domains[0]}/api/data/matches`,
      `${this.domains[0]}/api/matches`,
    ].filter(Boolean);

    let lastError;
    for (const apiBase of candidates) {
      const url = `${apiBase}?date=${dateKey}&timezone=${encodeURIComponent('Asia/Yangon')}&ccode3=MMR`;
      try {
        const { data, status } = await this.client.get(url, {
          validateStatus: (s) => s < 500,
        });
        if (status === 404) {
          lastError = new Error(`Request failed with status code 404`);
          continue;
        }
        if (status >= 400) {
          throw new Error(`Request failed with status code ${status}`);
        }
        return data;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('FotMob matches API unavailable');
  }

  parsePayload(data, dateKey) {
    const fixtures = [];
    const leagues = data?.leagues || data?.matches?.leagues || [];

    for (const leagueBlock of leagues) {
      const rawLeague =
        leagueBlock?.name ||
        leagueBlock?.leagueName ||
        leagueBlock?.primaryOrSecondaryText ||
        '';

      const standardLeague = this.normalizer.filterAllowedLeague(rawLeague);
      if (!standardLeague) continue;

      const matches = leagueBlock?.matches || leagueBlock?.allMatches || [];
      for (const match of matches) {
        const parsed = this.parseMatch(match, standardLeague, rawLeague, dateKey);
        if (parsed) fixtures.push(parsed);
      }
    }

    // Alternate shape: flat list
    if (!leagues.length && Array.isArray(data?.matches)) {
      for (const match of data.matches) {
        const rawLeague = match?.tournament?.name || match?.leagueName || '';
        const standardLeague = this.normalizer.filterAllowedLeague(rawLeague);
        if (!standardLeague) continue;
        const parsed = this.parseMatch(match, standardLeague, rawLeague, dateKey);
        if (parsed) fixtures.push(parsed);
      }
    }

    return fixtures;
  }

  parseMatch(match, standardLeague, rawLeague, dateKey) {
    const homeRaw =
      match?.home?.name ||
      match?.home?.longName ||
      match?.homeTeam?.name ||
      match?.home?.name ||
      '';
    const awayRaw =
      match?.away?.name ||
      match?.away?.longName ||
      match?.awayTeam?.name ||
      match?.away?.name ||
      '';

    const homeTeam = this.normalizer.normalizeTeam(homeRaw);
    const awayTeam = this.normalizer.normalizeTeam(awayRaw);
    if (!homeTeam || !awayTeam) return null;

    let kickoff = null;
    if (match?.status?.utcTime) {
      kickoff = toYangon(match.status.utcTime);
    } else if (match?.time) {
      kickoff = toYangon(match.time);
    } else if (match?.startDate) {
      kickoff = toYangon(match.startDate);
    } else if (dateKey && match?.status?.started === false) {
      // fallback: midnight of date — better than dropping entirely when API omits time
      kickoff = toYangon(
        `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)} 00:00`
      );
    }

    if (!kickoff || !isTodayOrTomorrow(kickoff)) return null;

    const statusReason = match?.status?.reason?.short || match?.status?.reason?.long || '';
    const started = Boolean(match?.status?.started);
    const finished = Boolean(match?.status?.finished);
    let status = 'Scheduled';
    if (finished || /ft|aet|pen/i.test(statusReason)) status = 'END';
    else if (started || /live|ht|1h|2h/i.test(statusReason)) status = 'LIVE';

    const matchId = generateMatchId(homeTeam, awayTeam, kickoff);
    const homeTeamId = match?.home?.id || match?.homeTeam?.id || null;
    const awayTeamId = match?.away?.id || match?.awayTeam?.id || null;

    return {
      matchId,
      league: standardLeague,
      homeTeam,
      awayTeam,
      homeTeamId,
      awayTeamId,
      homeLogo: teamLogoUrl(homeTeamId),
      awayLogo: teamLogoUrl(awayTeamId),
      date: formatDate(kickoff),
      time: formatTime(kickoff),
      kickoff: kickoff.toISO(),
      status,
      source: 'fotmob',
      fotmobId: match?.id || match?.matchId || null,
      originalNames: {
        fotmob: {
          league: cleanText(rawLeague),
          homeTeam: cleanText(homeRaw),
          awayTeam: cleanText(awayRaw),
        },
      },
      streams: [],
    };
  }

  async collectFixtures() {
    logEvent(events.SCRAPER_START, 'FotMob fixture scrape start', { source: this.name });
    const all = [];
    const errors = [];

    for (const dateKey of this.dateKeys()) {
      try {
        const data = await this.fetchMatchesForDate(dateKey);
        const fixtures = this.parsePayload(data, dateKey);
        all.push(...fixtures);
        logger.info('FotMob date collected', { dateKey, count: fixtures.length });
      } catch (err) {
        errors.push({ dateKey, error: err.message });
        logEvent(events.SCRAPER_ERROR, 'FotMob date fetch failed', {
          source: this.name,
          dateKey,
          error: err.message,
        });
      }
    }

    // Deduplicate by matchId
    const map = new Map();
    for (const f of all) {
      if (!map.has(f.matchId)) map.set(f.matchId, f);
    }
    const fixtures = [...map.values()];

    logEvent(events.FIXTURES_FOUND, 'FotMob fixtures found', {
      source: this.name,
      count: fixtures.length,
      errors: errors.length,
      at: nowYangon().toISO(),
    });

    if (!fixtures.length && errors.length) {
      throw new Error(`FotMob failed for all dates: ${errors.map((e) => e.error).join('; ')}`);
    }

    logEvent(events.SCRAPER_SUCCESS, 'FotMob fixture scrape success', {
      source: this.name,
      count: fixtures.length,
    });

    return fixtures;
  }
}

function teamLogoUrl(teamId) {
  if (teamId == null || teamId === '') return null;
  return `https://images.fotmob.com/image_resources/logo/teamlogo/${teamId}.png`;
}

module.exports = { FotMobSource, teamLogoUrl };
