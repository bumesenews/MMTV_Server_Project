const axios = require('axios');
const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { cleanText, foldKey } = require('../utils/normalize');
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
const { teamLogoUrl, resolveLeagueIcon } = require('../utils/fotmobLogos');
const {
  H2H_MATCH_LIMIT,
  h2hPairKey,
  buildH2hFromMatchDetails,
  reorientH2h,
} = require('../utils/fotmobH2h');

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
    /** @type {Map<string, Promise<object|null>>} per-run H2H cache (pair key → base payload) */
    this._h2hCache = new Map();
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

  /**
   * Fetch matchDetails for H2H. Failures return null (fixture still published).
   */
  async fetchMatchDetails(fotmobMatchId) {
    const id = Number(fotmobMatchId);
    if (!Number.isFinite(id) || id <= 0) return null;

    const candidates = [
      this.config.api?.matchDetails,
      `${this.domains[0]}/api/data/matchDetails`,
      `${this.domains[0]}/api/matchDetails`,
    ].filter(Boolean);

    let lastError;
    for (const apiBase of candidates) {
      const url = `${apiBase}?matchId=${id}`;
      try {
        const { data, status } = await this.client.get(url, {
          timeout: Number(process.env.FOTMOB_H2H_TIMEOUT_MS || 15000),
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
    if (lastError) {
      logger.warn('FotMob matchDetails fetch failed', {
        fotmobMatchId: id,
        error: lastError.message,
      });
    }
    return null;
  }

  /**
   * Load H2H for a team pair once per scrape run (cache key is order-independent).
   * Returns a base payload `{ matches }` (summary reoriented per fixture).
   */
  loadH2hBase(homeTeamId, awayTeamId, fotmobMatchId) {
    const pairKey = h2hPairKey(homeTeamId, awayTeamId);
    if (!pairKey) return Promise.resolve(null);

    if (this._h2hCache.has(pairKey)) {
      return this._h2hCache.get(pairKey);
    }

    const promise = (async () => {
      const details = await this.fetchMatchDetails(fotmobMatchId);
      if (!details) return null;
      // Build once with an arbitrary orientation; reorientH2h recalculates summary later
      const built = buildH2hFromMatchDetails(
        details,
        homeTeamId,
        awayTeamId,
        H2H_MATCH_LIMIT
      );
      return { matches: built.matches };
    })().catch((err) => {
      logger.warn('FotMob H2H enrich failed', {
        pairKey,
        fotmobMatchId,
        error: err.message,
      });
      return null;
    });

    this._h2hCache.set(pairKey, promise);
    return promise;
  }

  /**
   * Attach `h2h` to each fixture. Cached by team-id pair; limited concurrency.
   * Never throws — failed lookups become `h2h: null`.
   */
  async enrichFixturesWithH2h(fixtures) {
    const list = Array.isArray(fixtures) ? fixtures : [];
    if (!list.length) return list;

    this._h2hCache = new Map();
    const concurrency = Math.max(
      1,
      Math.min(5, Number(process.env.FOTMOB_H2H_CONCURRENCY || 3))
    );

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (cursor < list.length) {
        const idx = cursor;
        cursor += 1;
        const f = list[idx];
        try {
          const homeId = f.homeTeamId;
          const awayId = f.awayTeamId;
          const fotmobId = f.fotmobId || f.fotmobMatchId;
          if (homeId == null || awayId == null || !fotmobId) {
            f.h2h = null;
            continue;
          }
          const base = await this.loadH2hBase(homeId, awayId, fotmobId);
          if (!base) {
            f.h2h = null;
            continue;
          }
          f.h2h = reorientH2h(base, homeId, awayId);
        } catch (err) {
          f.h2h = null;
          logger.warn('FotMob H2H attach failed', {
            matchId: f.matchId,
            error: err.message,
          });
        }
      }
    });

    await Promise.all(workers);

    const withData = list.filter((f) => f.h2h && Array.isArray(f.h2h.matches)).length;
    const empty = list.filter(
      (f) =>
        f.h2h &&
        Array.isArray(f.h2h.matches) &&
        f.h2h.matches.length === 0
    ).length;
    const failed = list.filter((f) => f.h2h == null).length;
    logger.info('FotMob H2H enrich complete', {
      fixtures: list.length,
      withHistory: withData - empty,
      empty,
      failed,
      cacheEntries: this._h2hCache.size,
    });

    return list;
  }

  parsePayload(data, dateKey) {
    const fixtures = [];
    const leagues = data?.leagues || data?.matches?.leagues || [];

    for (const leagueBlock of leagues) {
      const name =
        leagueBlock?.name ||
        leagueBlock?.leagueName ||
        leagueBlock?.primaryOrSecondaryText ||
        '';
      const country =
        leagueBlock?.country ||
        leagueBlock?.nation ||
        leagueBlock?.ccode ||
        leagueBlock?.countryCode ||
        '';
      const fotmobId =
        leagueBlock?.id ||
        leagueBlock?.leagueId ||
        leagueBlock?.primaryId ||
        null;

      // Prefer bare league name first so "INT Club Friendlies" / "ENG Premier League"
      // still match allow-list aliases. Fall back to "Country Name" for ambiguous
      // comps (e.g. Ecuador Serie A).
      const bareName = cleanText(name);
      const withCountry =
        country && bareName && !foldKey(bareName).includes(foldKey(country))
          ? `${cleanText(country)} ${bareName}`.trim()
          : null;

      // Prefer "Country + league" before bare name so "Premier League" under ARM/ECU
      // cannot collapse into English Premier League / Serie A.
      const standardLeague =
        (withCountry
          ? this.normalizer.filterAllowedLeague(withCountry, {
              fotmobId,
              country,
            })
          : null) ||
        this.normalizer.filterAllowedLeague(bareName, { fotmobId, country });
      if (!standardLeague) continue;

      const matches = leagueBlock?.matches || leagueBlock?.allMatches || [];
      for (const match of matches) {
        const parsed = this.parseMatch(
          match,
          standardLeague,
          withCountry || bareName,
          dateKey,
          country,
          fotmobId
        );
        if (parsed) fixtures.push(parsed);
      }
    }

    // Alternate shape: flat list
    if (!leagues.length && Array.isArray(data?.matches)) {
      for (const match of data.matches) {
        const name = match?.tournament?.name || match?.leagueName || '';
        const country = match?.tournament?.country || match?.country || '';
        const fotmobId = match?.tournament?.id || match?.leagueId || null;
        const bareName = cleanText(name);
        const withCountry =
          country && bareName && !foldKey(bareName).includes(foldKey(country))
            ? `${cleanText(country)} ${bareName}`.trim()
            : null;
        const standardLeague =
          (withCountry
            ? this.normalizer.filterAllowedLeague(withCountry, {
                fotmobId,
                country,
              })
            : null) ||
          this.normalizer.filterAllowedLeague(bareName, { fotmobId, country });
        if (!standardLeague) continue;
        const parsed = this.parseMatch(
          match,
          standardLeague,
          withCountry || bareName,
          dateKey,
          country,
          fotmobId
        );
        if (parsed) fixtures.push(parsed);
      }
    }

    return fixtures;
  }

  parseMatch(match, standardLeague, rawLeague, dateKey, country = '', leagueFotmobId = null) {
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
      // FotMob utcTime is always a UTC instant — parse as UTC, then convert.
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
    const countryClean = cleanText(country);

    return {
      matchId,
      league: standardLeague,
      country: countryClean || null,
      leagueFotmobId: leagueFotmobId != null ? Number(leagueFotmobId) || leagueFotmobId : null,
      homeTeam,
      awayTeam,
      homeTeamId,
      awayTeamId,
      homeLogo: teamLogoUrl(homeTeamId),
      awayLogo: teamLogoUrl(awayTeamId),
      leagueIcon: resolveLeagueIcon({
        league: standardLeague,
        leagueFotmobId,
      }),
      date: formatDate(kickoff),
      time: formatTime(kickoff),
      kickoff: kickoff.toISO(),
      status,
      source: 'fotmob',
      fotmobId: match?.id || match?.matchId || null,
      originalNames: {
        fotmob: {
          league: cleanText(rawLeague),
          country: countryClean || null,
          leagueId: leagueFotmobId != null ? Number(leagueFotmobId) || leagueFotmobId : null,
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

    // Deduplicate by FotMob id first, then matchId (alias renames must not double-list)
    const map = new Map();
    for (const f of all) {
      const key =
        f.fotmobId != null && f.fotmobId !== ''
          ? `fm:${f.fotmobId}`
          : f.matchId;
      map.set(key, f);
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

    // Optional H2H enrichment — failures never abort fixture collection
    try {
      await this.enrichFixturesWithH2h(fixtures);
    } catch (err) {
      logger.warn('FotMob H2H enrichment skipped', { error: err.message });
      for (const f of fixtures) {
        if (f.h2h === undefined) f.h2h = null;
      }
    }

    logEvent(events.SCRAPER_SUCCESS, 'FotMob fixture scrape success', {
      source: this.name,
      count: fixtures.length,
    });

    return fixtures;
  }
}

module.exports = { FotMobSource };
