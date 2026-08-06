const dns = require('dns');
const axios = require('axios');
const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { toYangon, formatDate, formatTime, isTodayOrTomorrow, MATCH_LIVE_DURATION_MIN } = require('../utils/time');
const { foldKey } = require('../utils/normalize');
const { DEFAULT_UA } = require('../browser/puppeteerManager');
const { githubHeaders } = require('../services/configLoader');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const DEFAULT_SPORT = 'football';
const STREAM_CONCURRENCY = Number(process.env.SOCO_CONCURRENCY || 1);
/** Align with matches.json: force END this long after kickoff even if site still looks LIVE. */
const MATCH_DURATION_MS = MATCH_LIVE_DURATION_MIN * 60 * 1000;
const FETCH_RETRIES = 3;
const FETCH_DELAY_MS = 1200;

/** Stream search: active phase every 5 min, max 5 attempts (~25 min), then low-frequency every 15 min. */
const STREAM_RETRY_MS = 5 * 60 * 1000;
const STREAM_FAILED_RETRY_MS = 15 * 60 * 1000;
const STREAM_MAX_RETRIES = 5;

const STREAM_STATUS = {
  SEARCHING: 'SEARCHING',
  AVAILABLE: 'AVAILABLE',
  FAILED: 'FAILED',
  NONE: 'NONE',
};

/**
 * Football status codes from socolivegg.io `sport_data.football`
 * (score[1] / data-status after live hydrate):
 * 0 abnormal, 1 not started, 2 1H, 3 HT, 4 2H, 5–6 ET, 7 Pen,
 * 8 FT, 9 postponed, 10 interrupted, 11 cut, 12 cancelled, 13 unknown
 */
const SOCO_STATUS_PLAYING = new Set([2, 3, 4, 5, 6, 7]);
const SOCO_STATUS_ENDED = new Set([8, 10, 11, 12]);

const DEFAULT_PATHS = {
  today: '/sport/football/filter/today',
  tomorrow: '/sport/football/filter/tomorrow',
};

const DEFAULT_SELECTORS = {
  matchCard: ['.match-football-item'],
  league: [
    '.grid-match__league-name',
    '.grid-match__league span',
    '.grid-match__league',
  ],
  homeTeam: ['.grid-match__team--home-name'],
  awayTeam: ['.grid-match__team--away-name'],
  homeLogo: [
    '.grid-match__team-home img.team-logo-0',
    '.team-logo-group-home-logo img',
    '.grid-match__team-home img',
    '.team--home img',
    '.grid-match__team--home img',
  ],
  awayLogo: [
    '.grid-match__team-away img.team-logo-0',
    '.team-logo-group-away-logo img',
    '.grid-match__team-away img',
    '.team--away img',
    '.grid-match__team--away img',
  ],
  leagueIcon: ['.grid-match__league img', '.grid-match__competition img'],
  matchLink: ['a.redirectPopup', 'a[href*="/truc-tiep"]', 'a'],
  status: ['.grid-match__status', '.grid-match__time', '.grid-match__state', '.match-status'],
  streamButtons: ['#tv_links a.player-link', '#tv_links .player-link'],
};

const DEFAULT_ATTRS = {
  kickoff: 'data-runtime',
  sport: 'data-sport',
  status: ['data-status', 'data-match-status'],
  streamIndex: 'data-link',
  href: 'href',
  src: ['src', 'data-src', 'data-lazy-src'],
  homeTeamId: 'data-home-team-id',
  awayTeamId: 'data-away-team-id',
};

const DEFAULT_TEAM_LOGO_TEMPLATE =
  'https://imgts.sportpulseapiz.com/football/team/{id}/image/small';

/** Extra leagues Soco should always recognize (merged into leagueFilter when set). */
const SOCO_EXTRA_LEAGUES = [
  'Club Friendlies',
  'Premier League Summer Series',
];

/** In-memory stream search state (survives between pipeline ticks in the same process). */
const streamStateByMatchId = new Map();

/** Pending retry timers (matchId → Timeout) — lightweight, cleared on END/AVAILABLE. */
const streamRetryTimers = new Map();

let streamQueueSeq = 0;
/** Global sequential lock so timers and scrapeFull never search in parallel. */
let streamSearchTail = Promise.resolve();

function enqueueStreamTask(task) {
  const run = streamSearchTail.then(task, task);
  streamSearchTail = run.catch(() => {});
  return run;
}

/**
 * Source: Soco live site (HTTP/Cheerio).
 * Active base domain is loaded dynamically from GitHub `soco.json` (not hardcoded).
 * Domain, paths, selectors, attrs remain config-driven for selectors/paths only.
 */
class SocoSource {
  constructor({ config, normalizer, env = process.env } = {}) {
    this.name = 'soco';
    this.config = config || {};
    this.normalizer = normalizer;
    this.env = env;
    this.baseUrl = '';
    this.domainStatus = 'ACTIVE';
    this.sport = this.config.sport || DEFAULT_SPORT;
    this.paths = { ...DEFAULT_PATHS, ...(this.config.paths || {}) };
    this.selectors = mergeSelectorMap(DEFAULT_SELECTORS, this.config.selectors);
    this.attrs = {
      ...DEFAULT_ATTRS,
      ...(this.config.attrs || {}),
      status: asList((this.config.attrs && this.config.attrs.status) || DEFAULT_ATTRS.status),
    };
    this.sections = Array.isArray(this.config.sections) && this.config.sections.length
      ? this.config.sections
      : ['today', 'tomorrow'];
    this.onlyAllowedLeagues = this.config.onlyAllowedLeagues === true;
    this.leagueFilter = uniqueList(this.config.leagueFilter);
    this.extraLeagues = uniqueList([
      ...SOCO_EXTRA_LEAGUES,
      ...(this.config.extraLeagues || []),
    ]);
    this.teamLogoTemplate =
      this.config.teamLogoTemplate || DEFAULT_TEAM_LOGO_TEMPLATE;
    this._githubSoco = null;
    this._githubSocoSha = null;
  }

  /**
   * Keep only configured leagues when leagueFilter / onlyAllowedLeagues is set.
   * standardLeague must already be the allowed-league result (or null).
   */
  passesLeagueFilter(leagueRaw, standardLeague) {
    if (this.isExtraLeague(leagueRaw, standardLeague)) {
      return true;
    }

    if (this.leagueFilter.length) {
      if (!this._filterStandards) {
        this._filterStandards = new Set();
        for (const name of this.leagueFilter) {
          const mapped = this.normalizer ? this.normalizer.normalizeLeague(name) : name;
          if (mapped) this._filterStandards.add(foldKey(mapped));
          this._filterStandards.add(foldKey(name));
        }
      }
      const std = standardLeague || leagueRaw;
      return (
        this._filterStandards.has(foldKey(std)) ||
        this._filterStandards.has(foldKey(leagueRaw)) ||
        (standardLeague && this._filterStandards.has(foldKey(standardLeague)))
      );
    }

    // No explicit leagueFilter: optionally require leagues.json allow-list
    if (this.onlyAllowedLeagues) {
      return Boolean(standardLeague);
    }
    return true;
  }

  isExtraLeague(leagueRaw, standardLeague) {
    if (!this.extraLeagues.length) return false;
    if (!this._extraStandards) {
      this._extraStandards = new Set();
      for (const name of this.extraLeagues) {
        const mapped = this.normalizer ? this.normalizer.normalizeLeague(name) : name;
        if (mapped) this._extraStandards.add(foldKey(mapped));
        this._extraStandards.add(foldKey(name));
      }
    }
    const std = standardLeague || leagueRaw;
    return (
      this._extraStandards.has(foldKey(std)) ||
      this._extraStandards.has(foldKey(leagueRaw)) ||
      (standardLeague && this._extraStandards.has(foldKey(standardLeague)))
    );
  }

  get githubEnabled() {
    return Boolean(this.env.GITHUB_TOKEN && this.env.GITHUB_OWNER && this.env.GITHUB_REPO);
  }

  get githubSocoPath() {
    return this.env.GITHUB_SOCO_PATH || 'soco.json';
  }

  githubApiUrl(filePath = this.githubSocoPath) {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.env.GITHUB_REPO;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  }

  /**
   * Load GitHub soco.json (domain metadata + previous match/stream state).
   */
  async loadGithubSocoJson() {
    if (!this.githubEnabled) {
      logger.warn('Soco GitHub not configured — cannot load dynamic domain from soco.json');
      return { sha: null, content: null };
    }
    try {
      const { data } = await axios.get(this.githubApiUrl(), {
        headers: githubHeaders(this.env.GITHUB_TOKEN),
        params: { ref: this.env.GITHUB_BRANCH || 'main' },
        timeout: 20000,
      });
      const raw = Buffer.from(data.content || '', 'base64').toString('utf8');
      let content = null;
      try {
        content = JSON.parse(raw);
      } catch {
        content = null;
      }
      this._githubSoco = content;
      this._githubSocoSha = data.sha || null;
      return { sha: this._githubSocoSha, content };
    } catch (err) {
      if (err.response?.status === 404) {
        this._githubSoco = null;
        this._githubSocoSha = null;
        return { sha: null, content: null };
      }
      logger.warn('Soco failed to load GitHub soco.json', { error: err.message });
      throw err;
    }
  }

  /**
   * Overwrite GitHub soco.json (used for domain ERROR clear-old-data).
   */
  async writeGithubSocoJson(payload, message) {
    if (!this.githubEnabled) {
      logger.warn('Soco GitHub overwrite skipped — not configured', {
        status: payload?.status,
        domainStatus: payload?.domainStatus,
      });
      return { uploaded: false, reason: 'not_configured' };
    }

    const remote = await this.loadGithubSocoJson().catch(() => ({
      sha: this._githubSocoSha,
      content: this._githubSoco,
    }));

    const body = {
      message: message || `chore: update soco.json ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
      branch: this.env.GITHUB_BRANCH || 'main',
      ...(remote.sha ? { sha: remote.sha } : {}),
    };

    const { data } = await axios.put(this.githubApiUrl(), body, {
      headers: githubHeaders(this.env.GITHUB_TOKEN),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (data?.message || (data?.status && Number(data.status) >= 400)) {
      const err = new Error(data.message || 'GitHub soco.json overwrite failed');
      err.status = Number(data.status) || 403;
      err.github = data;
      throw err;
    }

    this._githubSoco = payload;
    this._githubSocoSha = data.content?.sha || remote.sha;
    logEvent(events.GITHUB_UPLOAD, 'Soco GitHub soco.json overwritten', {
      path: this.githubSocoPath,
      status: payload?.status,
      domainStatus: payload?.domainStatus,
      commit: data.commit?.sha || null,
    });
    return { uploaded: true, commit: data.commit?.sha || null };
  }

  buildDomainErrorPayload() {
    return {
      status: 'ERROR',
      domainStatus: 'FAILED',
      message: 'Service Temporarily Unavailable',
      matches: [],
    };
  }

  async overwriteGithubWithDomainError(reason) {
    const payload = this.buildDomainErrorPayload();
    logger.error('Soco domain failure — clearing GitHub soco.json match data', {
      reason,
      activeDomain: this.baseUrl || null,
    });
    try {
      await this.writeGithubSocoJson(
        payload,
        `fix: soco domain failed — clear match data (${reason || 'unavailable'})`
      );
      logger.info('Soco domain failure / GitHub overwrite complete', {
        domainStatus: 'FAILED',
        status: 'ERROR',
        message: payload.message,
      });
    } catch (err) {
      logger.error('Soco domain failure GitHub overwrite failed', { error: err.message });
      throw err;
    }
    return payload;
  }

  /**
   * Resolve active Soco base domain from GitHub soco.json.
   * Admin recovery: set domainStatus=ACTIVE and activeDomain (or domain/baseUrl).
   * No hardcoded base URL — config.domains is only a last-resort bootstrap when GitHub has none.
   */
  async resolveActiveDomainFromGithub() {
    const { content } = await this.loadGithubSocoJson();
    const meta = content && typeof content === 'object' ? content : {};
    const remoteStatus = String(meta.domainStatus || '').toUpperCase();

    const fromMeta =
      pickDomain(meta.activeDomain) ||
      pickDomain(meta.domain) ||
      pickDomain(meta.baseUrl) ||
      pickDomain(meta.meta?.activeDomain) ||
      pickDomain(meta.meta?.domain);

    const fromMatches = extractDomainFromSocoPayload(meta);

    if (remoteStatus === 'FAILED') {
      // Recovery: admin must set ACTIVE + a domain. If still FAILED with no new domain, stay blocked.
      if (!fromMeta) {
        this.domainStatus = 'FAILED';
        this.baseUrl = '';
        logger.warn('Soco domainStatus=FAILED on GitHub — waiting for admin ACTIVE recovery', {
          path: this.githubSocoPath,
        });
        return { domain: null, domainStatus: 'FAILED', blocked: true, content: meta };
      }
      // Domain present while FAILED → treat as admin fix in progress; resume with that domain.
      logger.info('Soco recovering from FAILED — using admin-provided domain', {
        activeDomain: fromMeta,
      });
    }

    const bootstrap =
      pickDomain((this.config.domains || [])[0]) ||
      pickDomain((this.config.mirrorDomains || [])[0]);

    const domain = fromMeta || fromMatches || bootstrap || '';
    if (!domain) {
      this.domainStatus = 'FAILED';
      this.baseUrl = '';
      return { domain: null, domainStatus: 'FAILED', blocked: true, content: meta };
    }

    this.baseUrl = domain.replace(/\/+$/, '');
    this.domainStatus = 'ACTIVE';
    logger.info('Soco active domain resolved', {
      activeDomain: this.baseUrl,
      source: fromMeta ? 'github_meta' : fromMatches ? 'github_matches' : 'config_bootstrap',
      domainStatus: this.domainStatus,
    });
    return {
      domain: this.baseUrl,
      domainStatus: this.domainStatus,
      blocked: false,
      content: meta,
    };
  }

  /** @deprecated Prefer resolveActiveDomainFromGithub — kept for callers that read baseUrl early. */
  resolveBaseUrl() {
    const domains = [
      ...(this.config.domains || []),
      ...(this.config.mirrorDomains || []),
    ].filter(Boolean);
    const raw = domains[0] || this.baseUrl || '';
    return String(raw).replace(/\/+$/, '');
  }

  headers(referer = this.baseUrl) {
    const custom = { ...(this.config.headers || {}) };
    // Always prefer this source's own origin as Referer (config may still have an old mirror).
    const origin = (this.baseUrl || referer || '').replace(/\/$/, '');
    delete custom.Referer;
    delete custom.referer;
    return {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept: 'application/json,text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      ...custom,
      Referer: `${origin}/`,
    };
  }

  absUrl(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${this.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
  }

  sectionUrl(section) {
    const path = this.paths[section] || `/sport/${this.sport}/filter/${section}`;
    return this.absUrl(path);
  }

  async fetchText(url, timeoutMs = 30000, referer = this.baseUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: this.headers(referer),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.httpStatus = res.status;
        err.code = res.status === 404 ? 'HTTP_404' : `HTTP_${res.status}`;
        throw err;
      }
      return res.text();
    } catch (err) {
      classifyNetworkError(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSectionHtml(section) {
    const url = this.sectionUrl(section);
    let lastErr = null;
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
      try {
        const text = await this.fetchText(url);
        const trimmed = String(text || '').trim();
        if (!trimmed) throw new Error('empty response');

        // Preferred: JSON envelope { success, data: { htmls: [...] } }
        if (trimmed.startsWith('{')) {
          const payload = JSON.parse(trimmed);
          if (!payload?.success || !Array.isArray(payload?.data?.htmls)) {
            throw new Error('missing htmls in API payload');
          }
          return payload.data.htmls.join('');
        }

        // Fallback: site returned full HTML page with match cards
        if (
          /match-football-item/i.test(trimmed) ||
          /grid-match__/i.test(trimmed) ||
          /<!doctype html/i.test(trimmed)
        ) {
          logger.info('Soco section returned HTML (using directly)', { section, url });
          return trimmed;
        }

        throw new Error(`unexpected response (${trimmed.slice(0, 40)}...)`);
      } catch (err) {
        lastErr = err;
        if (isDomainConnectivityError(err)) {
          err.domainFailure = true;
          throw err;
        }
        if (attempt < FETCH_RETRIES) {
          await sleep(FETCH_DELAY_MS);
          continue;
        }
        logger.warn('Soco section failed', { section, url, error: err.message });
        // Treat final section failure as domain connectivity when classified as such
        if (isDomainConnectivityError(err)) {
          err.domainFailure = true;
          throw err;
        }
        return '';
      }
    }
    if (lastErr && isDomainConnectivityError(lastErr)) {
      lastErr.domainFailure = true;
      throw lastErr;
    }
    return '';
  }

  firstText($root, selectorList) {
    for (const selector of asList(selectorList)) {
      const text = $root.find(selector).first().text().replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '';
  }

  firstAttr($root, selectorList, attrNames) {
    const attrs = asList(attrNames || this.attrs.href);
    for (const selector of asList(selectorList)) {
      const el = $root.find(selector).first();
      if (!el.length) continue;
      for (const attr of attrs) {
        const value = el.attr(attr);
        if (value) return value;
      }
    }
    return '';
  }

  teamLogoFromId(teamId) {
    if (!teamId || !this.teamLogoTemplate) return '';
    return this.teamLogoTemplate.replace('{id}', String(teamId).trim());
  }

  cardAttr(card, attrNames) {
    for (const name of asList(attrNames)) {
      const value = card.attr(name);
      if (value != null && value !== '') return value;
    }
    return '';
  }

  parseMatchesFromHtml(html, sectionKey) {
    const $ = load(html);
    const matches = [];
    const seen = new Set();
    const cardSelector = asList(this.selectors.matchCard).join(', ') || '.match-football-item';

    $(cardSelector).each((_, el) => {
      const card = $(el);
      const sportAttr = this.cardAttr(card, this.attrs.sport);
      if (sportAttr && sportAttr !== this.sport) return;

      const kickoffUnix = this.cardAttr(card, this.attrs.kickoff);
      if (!kickoffUnix) return;

      const kickoff = toYangon(Number(kickoffUnix) * 1000);
      if (!kickoff || !isTodayOrTomorrow(kickoff)) return;

      const homeRaw = this.firstText(card, this.selectors.homeTeam);
      const awayRaw = this.firstText(card, this.selectors.awayTeam);
      const matchPath = this.firstAttr(card, this.selectors.matchLink, this.attrs.href);
      const matchUrl = this.absUrl(matchPath);
      const leagueRaw = this.firstText(card, this.selectors.league);
      const homeLogo = this.absUrl(
        this.firstAttr(card, this.selectors.homeLogo, this.attrs.src) ||
          this.teamLogoFromId(this.cardAttr(card, this.attrs.homeTeamId))
      );
      const awayLogo = this.absUrl(
        this.firstAttr(card, this.selectors.awayLogo, this.attrs.src) ||
          this.teamLogoFromId(this.cardAttr(card, this.attrs.awayTeamId))
      );
      const leagueIcon = this.absUrl(
        this.firstAttr(card, this.selectors.leagueIcon, this.attrs.src)
      );

      if (!homeRaw || !awayRaw || !matchUrl) return;

      const standardLeague = this.normalizer
        ? this.normalizer.filterAllowedLeague(leagueRaw)
        : leagueRaw;

      // Do NOT fall back to raw league name here — that bypasses onlyAllowedLeagues
      if (!this.passesLeagueFilter(leagueRaw, standardLeague)) return;

      const homeTeam = this.normalizer ? this.normalizer.normalizeTeam(homeRaw) : homeRaw;
      const awayTeam = this.normalizer ? this.normalizer.normalizeTeam(awayRaw) : awayRaw;
      const matchId = generateMatchId(homeTeam, awayTeam, kickoff);
      if (seen.has(matchId)) return;
      seen.add(matchId);

      const { status, live } = parseMatchStatus(card, kickoffUnix, this);

      logger.debug('Soco card status → match object', {
        source: 'soco',
        homeTeam: homeRaw,
        awayTeam: awayRaw,
        sectionKey,
        kickoffUnix,
        finalJsonStatus: status,
        live,
      });

      matches.push({
        matchId,
        league: standardLeague || leagueRaw,
        leagueAllowed: Boolean(standardLeague),
        homeTeam,
        awayTeam,
        homeLogo,
        awayLogo,
        leagueIcon,
        date: formatDate(kickoff),
        time: formatTime(kickoff),
        kickoff: kickoff.toISO(),
        status,
        live,
        matchUrl,
        kickoffUnix: Number(kickoffUnix),
        sectionKey,
        source: this.name,
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        originalNames: {
          soco: { league: leagueRaw, homeTeam: homeRaw, awayTeam: awayRaw },
        },
      });
    });

    return matches;
  }

  async discoverMatches() {
    if (!this.baseUrl) {
      const resolved = await this.resolveActiveDomainFromGithub();
      if (resolved.blocked || !this.baseUrl) {
        const err = new Error('Soco domain unavailable (domainStatus=FAILED or missing)');
        err.domainFailure = true;
        err.code = 'DOMAIN_BLOCKED';
        throw err;
      }
    }

    logEvent(events.SCRAPER_START, 'Soco discover start', {
      source: this.name,
      baseUrl: this.baseUrl,
      domainStatus: this.domainStatus,
      sections: this.sections,
      onlyAllowedLeagues: this.onlyAllowedLeagues,
      leagueFilter: this.leagueFilter,
    });
    const all = [];
    try {
      for (const section of this.sections) {
        const html = await this.fetchSectionHtml(section);
        const cardCount = html
          ? (html.match(/match-football-item/gi) || []).length
          : 0;
        const parsed = html ? this.parseMatchesFromHtml(html, section) : [];
        logger.info('Soco section parsed', {
          source: this.name,
          section,
          htmlLen: html ? html.length : 0,
          cards: cardCount,
          kept: parsed.length,
        });
        if (parsed.length) all.push(...parsed);
        await sleep(FETCH_DELAY_MS);
      }
    } catch (err) {
      if (err.domainFailure || isDomainConnectivityError(err)) {
        err.domainFailure = true;
        throw err;
      }
      throw err;
    }
    logEvent(events.SCRAPER_SUCCESS, 'Soco discover success', {
      source: this.name,
      count: all.length,
      activeDomain: this.baseUrl,
    });
    return all;
  }

  async findMatchPage(fixture) {
    const discovered = await this.discoverMatches();
    const hit = discovered.find((m) => m.matchId === fixture.matchId);
    return hit?.matchUrl || null;
  }

  async extractStreams(matchPageUrl) {
    logEvent(events.SCRAPER_START, 'Soco stream extract start', {
      source: this.name,
      url: matchPageUrl,
    });
    const links = await this.buildMatchLinks(matchPageUrl, true);
    const streams = links
      .filter((l) => l.url)
      .map((l) => ({
        source: this.name,
        type: 'm3u8',
        quality: l.name || 'HD',
        url: l.url,
        headers: {
          'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
          Referer: l.reffer || matchPageUrl,
        },
        active: true,
        checkedAt: new Date().toISOString(),
      }));
    logEvent(events.SCRAPER_SUCCESS, 'Soco stream extract success', {
      source: this.name,
      count: streams.length,
    });
    return streams;
  }

  async collectForFixtures(fixtures = []) {
    const discovered = await this.discoverMatches();
    const byId = new Map(discovered.map((m) => [m.matchId, m]));
    const results = [];

    const targets = (fixtures || [])
      .map((f) => ({ fixture: f, page: byId.get(f.matchId) }))
      .filter((x) => x.page && shouldAttemptStreamFetch(x.page));

    // Sequential queue (concurrency 1 by default) to minimize RAM/CPU
    const enriched = await mapWithConcurrency(targets, STREAM_CONCURRENCY, async ({ fixture, page }) => {
      try {
        const streams = await this.extractStreams(page.matchUrl);
        return {
          matchId: fixture.matchId,
          source: this.name,
          matchUrl: page.matchUrl,
          streams,
          originalNames: page.originalNames,
          sourceLive: page.live || page.status === 'LIVE',
        };
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Soco match stream failed', {
          source: this.name,
          matchId: fixture.matchId,
          error: err.message,
        });
        return null;
      }
    });

    for (const row of enriched) {
      if (row) results.push(row);
    }
    return results;
  }

  /**
   * Hydrate in-memory stream state from GitHub / prior scrape payload.
   */
  hydrateStreamStateFromPayload(content) {
    const prior = flattenPriorSocoMatches(content);
    for (const m of prior) {
      if (!m.matchId && !(m.homeTeam && m.awayTeam)) continue;
      const id =
        m.matchId ||
        generateMatchId(m.homeTeam || m.home_team?.name, m.awayTeam || m.away_team?.name, m.kickoff);
      if (!id) continue;
      const existing = streamStateByMatchId.get(id) || {};
      const links = Array.isArray(m.links) ? m.links : [];
      const streamUrl =
        m.streamUrl ||
        links.find((l) => l && l.url)?.url ||
        existing.streamUrl ||
        null;
      streamStateByMatchId.set(id, {
        streamStatus: m.streamStatus || existing.streamStatus || STREAM_STATUS.NONE,
        streamUrl: streamUrl || null,
        retryCount: Number.isFinite(Number(m.retryCount))
          ? Number(m.retryCount)
          : existing.retryCount || 0,
        lastStreamCheck: m.lastStreamCheck || existing.lastStreamCheck || null,
        nextRetryTime: m.nextRetryTime || existing.nextRetryTime || null,
        links: links.length ? links : existing.links || [],
      });
    }
  }

  getStreamState(matchId) {
    return (
      streamStateByMatchId.get(matchId) || {
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        links: [],
      }
    );
  }

  setStreamState(matchId, patch) {
    const prev = this.getStreamState(matchId);
    const next = { ...prev, ...patch };
    streamStateByMatchId.set(matchId, next);
    return next;
  }

  clearStreamRetryTimer(matchId) {
    const timer = streamRetryTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      streamRetryTimers.delete(matchId);
    }
  }

  /**
   * Schedule a lightweight stream-only retry at nextRetryTime (5 min / 15 min).
   * Uses a process-wide sequential queue so timers never fan out in parallel.
   */
  scheduleStreamRetry(match) {
    const matchId = match.matchId;
    this.clearStreamRetryTimer(matchId);
    const state = this.getStreamState(matchId);
    if (match.status !== 'LIVE') return;
    if (state.streamStatus === STREAM_STATUS.AVAILABLE) return;
    if (state.streamStatus === STREAM_STATUS.NONE) return;
    if (!state.nextRetryTime || !match.matchUrl) return;

    const when = Date.parse(state.nextRetryTime);
    if (!Number.isFinite(when)) return;
    const delay = Math.max(1000, when - Date.now());

    logger.info('Soco next retry time scheduled', {
      matchId,
      streamStatus: state.streamStatus,
      retryCount: state.retryCount || 0,
      nextRetryTime: state.nextRetryTime,
      delayMs: delay,
    });

    const timer = setTimeout(() => {
      streamRetryTimers.delete(matchId);
      enqueueStreamTask(async () => {
        const latest = this.getStreamState(matchId);
        if (latest.streamStatus === STREAM_STATUS.AVAILABLE) return;
        if (latest.streamStatus === STREAM_STATUS.NONE) return;
        const queueId = `soco-timer-${++streamQueueSeq}-${matchId}`;
        logger.info('Soco scheduled stream retry firing', {
          queueId,
          matchId,
          streamStatus: latest.streamStatus,
          retryCount: latest.retryCount || 0,
        });
        await this.searchStreamForMatch(
          {
            matchId,
            matchUrl: match.matchUrl,
            status: 'LIVE',
            live: true,
          },
          queueId
        );
        const after = this.getStreamState(matchId);
        if (
          after.streamStatus === STREAM_STATUS.SEARCHING ||
          after.streamStatus === STREAM_STATUS.FAILED
        ) {
          this.scheduleStreamRetry(match);
        }
      });
    }, delay);

    if (typeof timer.unref === 'function') timer.unref();
    streamRetryTimers.set(matchId, timer);
  }

  /**
   * Decide whether this LIVE match should be searched now (retry schedule).
   */
  shouldSearchStreamNow(match, now = Date.now()) {
    if (match.status !== 'LIVE' && match.live !== true) return false;
    const state = this.getStreamState(match.matchId);
    if (state.streamStatus === STREAM_STATUS.AVAILABLE && isValidStreamUrlFormat(state.streamUrl)) {
      return false;
    }
    if (state.nextRetryTime) {
      const next = Date.parse(state.nextRetryTime);
      if (Number.isFinite(next) && now < next) return false;
    }
    return true;
  }

  /**
   * Validate stream URL exists, has valid format, and responds to a fast header check.
   */
  async validateStreamUrl(url, referer) {
    if (!url || !isValidStreamUrlFormat(url)) {
      return { ok: false, reason: 'invalid_format' };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
            Referer: referer || this.baseUrl || '',
          },
        });
      } catch {
        // Some CDNs reject HEAD — fall back to ranged GET
        res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
            Referer: referer || this.baseUrl || '',
            Range: 'bytes=0-0',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok || res.status === 206 || res.status === 302 || res.status === 301) {
        logger.info('Soco stream validated', { url: url.slice(0, 120), status: res.status });
        return { ok: true, status: res.status };
      }
      return { ok: false, reason: `http_${res.status}` };
    } catch (err) {
      return { ok: false, reason: err.message || 'header_check_failed' };
    }
  }

  /**
   * Sequential task-queue stream search for one LIVE match.
   */
  async searchStreamForMatch(match, queueId) {
    const matchId = match.matchId;
    const state = this.getStreamState(matchId);
    const nowIso = new Date().toISOString();
    const nextRetryCount = (state.retryCount || 0) + 1;

    logger.info('Soco stream search started', {
      queueId,
      matchId,
      activeDomain: this.baseUrl,
      websiteStatus: match.status,
      streamStatus: state.streamStatus,
      retryCount: nextRetryCount,
    });

    this.setStreamState(matchId, {
      streamStatus:
        state.streamStatus === STREAM_STATUS.FAILED
          ? STREAM_STATUS.FAILED
          : STREAM_STATUS.SEARCHING,
      lastStreamCheck: nowIso,
      retryCount: nextRetryCount,
    });

    let links = [];
    let foundUrl = '';
    try {
      links = await this.buildMatchLinks(match.matchUrl, true);
      foundUrl =
        links.map((l) => l.url).find((u) => isValidStreamUrlFormat(u)) ||
        pickStreamUrl(links.map((l) => l.url).filter(Boolean)) ||
        '';
    } catch (err) {
      logger.warn('Soco stream search extract failed', {
        queueId,
        matchId,
        error: err.message,
      });
    }

    if (foundUrl) {
      logger.info('Soco stream found', { queueId, matchId, url: foundUrl.slice(0, 120) });
      const validation = await this.validateStreamUrl(foundUrl, match.matchUrl);
      if (validation.ok) {
        const validatedLinks = links.length
          ? links.map((l) =>
              l.url === foundUrl || (!l.url && links.indexOf(l) === 0)
                ? { ...l, url: foundUrl }
                : l
            )
          : [{ name: 'Link 1', url: foundUrl, reffer: match.matchUrl }];

        this.setStreamState(matchId, {
          streamStatus: STREAM_STATUS.AVAILABLE,
          streamUrl: foundUrl,
          links: validatedLinks,
          lastStreamCheck: nowIso,
          nextRetryTime: null,
          retryCount: nextRetryCount,
        });
        this.clearStreamRetryTimer(matchId);
        logger.info('Soco stream search completed — AVAILABLE', {
          queueId,
          matchId,
          retryCount: nextRetryCount,
        });
        return this.getStreamState(matchId);
      }
      logger.warn('Soco stream validation failed — continue searching', {
        queueId,
        matchId,
        reason: validation.reason,
      });
    }

    // No valid stream yet — SEARCHING or FAILED with schedule
    const failed = nextRetryCount >= STREAM_MAX_RETRIES;
    const interval = failed ? STREAM_FAILED_RETRY_MS : STREAM_RETRY_MS;
    const nextRetryTime = new Date(Date.now() + interval).toISOString();
    const streamStatus = failed ? STREAM_STATUS.FAILED : STREAM_STATUS.SEARCHING;

    this.setStreamState(matchId, {
      streamStatus,
      streamUrl: null,
      links: [],
      lastStreamCheck: nowIso,
      nextRetryTime,
      retryCount: nextRetryCount,
    });

    logger.info('Soco stream search completed — not available', {
      queueId,
      matchId,
      streamStatus,
      retryCount: nextRetryCount,
      nextRetryTime,
    });
    return this.getStreamState(matchId);
  }

  /**
   * Process LIVE matches one-at-a-time (task queue) for stream URLs.
   */
  async processStreamSearchQueue(matches) {
    const now = Date.now();
    const queue = matches.filter((m) => this.shouldSearchStreamNow(m, now));
    if (!queue.length) {
      logger.info('Soco stream search queue empty', {
        liveCount: matches.filter((m) => m.status === 'LIVE').length,
      });
      // Still (re)schedule timers for matches waiting on nextRetryTime
      for (const m of matches.filter((x) => x.status === 'LIVE')) {
        this.scheduleStreamRetry(m);
      }
      return;
    }

    logger.info('Soco stream search queue ready', {
      queueSize: queue.length,
      activeDomain: this.baseUrl,
    });

    await enqueueStreamTask(async () => {
      for (const match of queue) {
        const queueId = `soco-q-${++streamQueueSeq}-${match.matchId}`;
        try {
          await this.searchStreamForMatch(match, queueId);
        } catch (err) {
          logEvent(events.SCRAPER_ERROR, 'Soco queued stream search failed', {
            queueId,
            matchId: match.matchId,
            error: err.message,
          });
          const state = this.getStreamState(match.matchId);
          const retryCount = (state.retryCount || 0) + 1;
          const failed = retryCount >= STREAM_MAX_RETRIES;
          this.setStreamState(match.matchId, {
            streamStatus: failed ? STREAM_STATUS.FAILED : STREAM_STATUS.SEARCHING,
            retryCount,
            lastStreamCheck: new Date().toISOString(),
            nextRetryTime: new Date(
              Date.now() + (failed ? STREAM_FAILED_RETRY_MS : STREAM_RETRY_MS)
            ).toISOString(),
          });
        }
        this.scheduleStreamRetry(match);
        // Brief yield between matches to release event-loop / reduce peak RAM
        await sleep(200);
      }
    });
  }

  /**
   * Apply website status + stream state onto a discovered match.
   * Status always follows the Soco website (never forced by stream presence).
   */
  applyStreamFields(match) {
    const status = match.status;
    if (status === 'END') {
      const prev = this.getStreamState(match.matchId);
      if (prev.streamStatus !== STREAM_STATUS.NONE || prev.streamUrl || prev.retryCount) {
        logger.info('Soco search stopped — match END', {
          matchId: match.matchId,
          websiteStatus: status,
        });
      }
      this.clearStreamRetryTimer(match.matchId);
      this.setStreamState(match.matchId, {
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        links: [],
      });
      return {
        ...match,
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        links: [],
      };
    }

    if (status !== 'LIVE') {
      this.clearStreamRetryTimer(match.matchId);
      this.setStreamState(match.matchId, {
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        links: [],
      });
      return {
        ...match,
        streamStatus: STREAM_STATUS.NONE,
        streamUrl: null,
        retryCount: 0,
        lastStreamCheck: null,
        nextRetryTime: null,
        links: [],
      };
    }

    // LIVE — attach current stream state (search queue may have updated it)
    const state = this.getStreamState(match.matchId);
    let streamStatus = state.streamStatus || STREAM_STATUS.SEARCHING;
    if (streamStatus === STREAM_STATUS.NONE) streamStatus = STREAM_STATUS.SEARCHING;
    if (streamStatus === STREAM_STATUS.AVAILABLE && !isValidStreamUrlFormat(state.streamUrl)) {
      streamStatus = STREAM_STATUS.SEARCHING;
    }

    const links =
      streamStatus === STREAM_STATUS.AVAILABLE && Array.isArray(state.links) && state.links.length
        ? state.links
        : streamStatus === STREAM_STATUS.AVAILABLE && state.streamUrl
          ? [{ name: 'Link 1', url: state.streamUrl, reffer: match.matchUrl }]
          : [];

    logger.info('Soco match stream fields', {
      matchId: match.matchId,
      activeDomain: this.baseUrl,
      websiteStatus: status,
      streamStatus,
      retryCount: state.retryCount || 0,
      nextRetryTime: state.nextRetryTime || null,
    });

    return {
      ...match,
      streamStatus,
      streamUrl: streamStatus === STREAM_STATUS.AVAILABLE ? state.streamUrl || null : null,
      retryCount: state.retryCount || 0,
      lastStreamCheck: state.lastStreamCheck || null,
      nextRetryTime: state.nextRetryTime || null,
      links,
    };
  }

  /**
   * Full scrape for Flutter soco.json (today/tomorrow cards + stream links).
   * Status comes from the Soco website card (data-status / class / text).
   * LIVE stream search always uses the sequential task queue (RAM-safe).
   * Active domain is always resolved from GitHub soco.json.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.fetchStreams] - kept for API compatibility; LIVE queue always runs.
   * @param {boolean} [opts.skipStreamSearch=false] - diagnostics only: skip stream queue.
   */
  async scrapeFull({ fetchStreams = true, skipStreamSearch = false } = {}) {
    logEvent(events.SCRAPER_START, 'Soco full scrape start', {
      source: this.name,
    });

    let domainInfo;
    try {
      domainInfo = await this.resolveActiveDomainFromGithub();
    } catch (err) {
      logger.error('Soco could not load domain from GitHub soco.json', { error: err.message });
      const errorPayload = await this.overwriteGithubWithDomainError(
        err.message || 'github_load_failed'
      ).catch(() => this.buildDomainErrorPayload());
      return {
        generatedAt: new Date().toISOString(),
        status: 'ERROR',
        domainStatus: 'FAILED',
        message: 'Service Temporarily Unavailable',
        domainFailed: true,
        errorPayload,
        activeDomain: null,
        today: [],
        tomorrow: [],
        matches: [],
      };
    }

    if (domainInfo.blocked || !this.baseUrl) {
      const errorPayload = this.buildDomainErrorPayload();
      // Ensure GitHub stays in ERROR state (clear old data)
      if (!domainInfo.content || domainInfo.content.status !== 'ERROR') {
        await this.overwriteGithubWithDomainError('domain_blocked_or_missing').catch(() => {});
      }
      return {
        generatedAt: new Date().toISOString(),
        status: 'ERROR',
        domainStatus: 'FAILED',
        message: 'Service Temporarily Unavailable',
        domainFailed: true,
        errorPayload,
        activeDomain: null,
        today: [],
        tomorrow: [],
        matches: [],
      };
    }

    this.hydrateStreamStateFromPayload(domainInfo.content);

    logger.info('Soco scrape using active domain', {
      activeDomain: this.baseUrl,
      domainStatus: this.domainStatus,
      fetchStreams,
    });

    let discovered;
    try {
      discovered = await this.discoverMatches();
    } catch (err) {
      if (err.domainFailure || isDomainConnectivityError(err)) {
        const reason =
          err.code || err.httpStatus || err.message || 'domain_connectivity_failure';
        const errorPayload = await this.overwriteGithubWithDomainError(String(reason)).catch(
          () => this.buildDomainErrorPayload()
        );
        return {
          generatedAt: new Date().toISOString(),
          status: 'ERROR',
          domainStatus: 'FAILED',
          message: 'Service Temporarily Unavailable',
          domainFailed: true,
          errorPayload,
          activeDomain: this.baseUrl || null,
          today: [],
          tomorrow: [],
          matches: [],
        };
      }
      throw err;
    }

    logger.info('Soco scrapeFull status summary', {
      source: this.name,
      activeDomain: this.baseUrl,
      total: discovered.length,
      liveCount: discovered.filter((m) => m.status === 'LIVE').length,
      scheduledCount: discovered.filter((m) => m.status === 'Scheduled').length,
      endCount: discovered.filter((m) => m.status === 'END').length,
      liveSamples: discovered
        .filter((m) => m.status === 'LIVE')
        .slice(0, 10)
        .map((m) => ({
          matchId: m.matchId,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          kickoff: m.kickoff,
          kickoffUnix: m.kickoffUnix,
          status: m.status,
        })),
    });

    // Mark brand-new LIVE matches as SEARCHING before queue runs
    for (const m of discovered) {
      if (m.status === 'LIVE') {
        const state = this.getStreamState(m.matchId);
        if (state.streamStatus === STREAM_STATUS.NONE || !state.streamStatus) {
          this.setStreamState(m.matchId, {
            streamStatus: STREAM_STATUS.SEARCHING,
            streamUrl: null,
            retryCount: state.retryCount || 0,
          });
        }
      } else if (m.status === 'END') {
        this.applyStreamFields(m);
      }
    }

    // Sequential LIVE stream queue always runs (resource-optimized).
    // Pipeline may still pass fetchStreams:false for legacy 1GB hosts — the new
    // queue replaces parallel extraction and is safe to run.
    if (!skipStreamSearch) {
      await this.processStreamSearchQueue(discovered.filter((m) => m.status === 'LIVE'));
    }

    const matches = discovered.map((m) => this.applyStreamFields(m));

    // Prune END / missing matches from in-memory state to free RAM
    const liveIds = new Set(matches.filter((m) => m.status === 'LIVE').map((m) => m.matchId));
    for (const id of [...streamStateByMatchId.keys()]) {
      if (!liveIds.has(id)) {
        const st = streamStateByMatchId.get(id);
        if (!st || st.streamStatus === STREAM_STATUS.NONE) {
          streamStateByMatchId.delete(id);
        }
      }
    }

    logEvent(events.SCRAPER_SUCCESS, 'Soco full scrape success', {
      source: this.name,
      activeDomain: this.baseUrl,
      count: matches.length,
      withLinks: matches.filter((m) => (m.links || []).some((l) => l.url)).length,
      searching: matches.filter((m) => m.streamStatus === STREAM_STATUS.SEARCHING).length,
      available: matches.filter((m) => m.streamStatus === STREAM_STATUS.AVAILABLE).length,
      failed: matches.filter((m) => m.streamStatus === STREAM_STATUS.FAILED).length,
    });

    return {
      generatedAt: new Date().toISOString(),
      status: 'OK',
      domainStatus: 'ACTIVE',
      activeDomain: this.baseUrl,
      message: null,
      domainFailed: false,
      today: matches.filter((m) => m.sectionKey === 'today'),
      tomorrow: matches.filter((m) => m.sectionKey === 'tomorrow'),
      matches,
    };
  }

  parseListStreamGroups(html) {
    const match = html.match(/var\s+list_stream\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  parseStreamButtons(html) {
    const $ = load(html);
    const buttons = [];
    const seen = new Set();
    const buttonSelector =
      asList(this.selectors.streamButtons).join(', ') || '#tv_links a.player-link';
    const indexAttr = this.attrs.streamIndex || 'data-link';

    $(buttonSelector).each((_, el) => {
      const anchor = $(el);
      const rawIndex = anchor.attr(indexAttr);
      if (rawIndex == null || rawIndex === '') return;
      const index = Number(rawIndex);
      if (!Number.isFinite(index)) return;
      const name = anchor.text().replace(/\s+/g, ' ').trim();
      if (!name) return;
      const key = `${index}::${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      buttons.push({ index, name });
    });
    return buttons;
  }

  async extractStreamFromEmbed(embedUrl, matchPageUrl) {
    const html = await this.fetchText(embedUrl, 30000, matchPageUrl);
    const candidates = findPatterns(html, embedUrl);
    const urlStream = html.match(/urlStream\s*=\s*["']([^"']+)["']/)?.[1];
    if (urlStream) candidates.push(urlStream);
    const streamingUrl = html.match(/streamingurl\s*[:=]\s*["']([^"']+)["']/i)?.[1];
    if (streamingUrl) candidates.push(streamingUrl);
    return pickStreamUrl(candidates);
  }

  async buildMatchLinks(matchPageUrl, fetchStreams = true) {
    const html = await this.fetchText(matchPageUrl, 30000, matchPageUrl);
    const streamGroups = this.parseListStreamGroups(html);
    const buttons = this.parseStreamButtons(html);

    if (buttons.length > 0) {
      const links = [];
      for (const button of buttons) {
        const embedUrl = Array.isArray(streamGroups[button.index])
          ? streamGroups[button.index][0]
          : '';
        let streamUrl = '';
        if (fetchStreams && embedUrl) {
          try {
            streamUrl = await this.extractStreamFromEmbed(embedUrl, matchPageUrl);
          } catch (err) {
            logger.debug('Soco embed failed', { name: button.name, error: err.message });
          }
        }
        links.push({ name: button.name, url: streamUrl, reffer: matchPageUrl });
      }
      return links;
    }

    const fallbackEmbeds = [
      ...new Set(
        streamGroups.flat().filter((url) => typeof url === 'string' && url.startsWith('http'))
      ),
    ].slice(0, 2);

    const links = [];
    for (const [index, embedUrl] of fallbackEmbeds.entries()) {
      let streamUrl = '';
      if (fetchStreams) {
        try {
          streamUrl = await this.extractStreamFromEmbed(embedUrl, matchPageUrl);
        } catch {
          // ignore
        }
      }
      links.push({ name: `Link ${index + 1}`, url: streamUrl, reffer: matchPageUrl });
    }

    if (!links.length) {
      const direct = fetchStreams ? pickStreamUrl(findPatterns(html, matchPageUrl)) : '';
      links.push({ name: 'Link 1', url: direct, reffer: matchPageUrl });
    }
    return links;
  }
}

function firstTextWithSelector($root, selectorList) {
  for (const selector of asList(selectorList)) {
    const text = $root.find(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text) return { text, selector };
  }
  return { text: '', selector: null };
}

function parseMatchStatus(card, kickoffUnixSeconds, source) {
  const className = (card.attr('class') || '').toLowerCase();
  const dataStatus = String(source.cardAttr(card, source.attrs.status) || '').trim();
  const statusCode = Number.parseInt(dataStatus, 10);
  const statusHit = firstTextWithSelector(card, source.selectors.status);
  const statusText = String(statusHit.text || '').toLowerCase().trim();
  const statusSelector = statusHit.selector;
  const hasScore =
    card.find('.grid-match__vs .home-score, .grid-match__vs .away-score, .t_vs_num').length > 0;
  const hasVsOnly =
    card.find('.grid-match__vs').length > 0 && !hasScore;

  // Extra raw HTML snapshot of status-related nodes (debug only)
  const rawStatusHtml = asList(source.selectors.status)
    .map((sel) => {
      const el = card.find(sel).first();
      if (!el.length) return null;
      return { selector: sel, text: el.text().replace(/\s+/g, ' ').trim(), html: el.html() };
    })
    .filter(Boolean);

  let branch = null;
  let result = { status: 'Scheduled', live: false };

  // Prefer explicit site status codes (socolivegg.io / apiscoreflow football map)
  if (Number.isFinite(statusCode) && SOCO_STATUS_ENDED.has(statusCode)) {
    branch = `end_data_status_${statusCode}`;
    result = { status: 'END', live: false };
  } else if (Number.isFinite(statusCode) && SOCO_STATUS_PLAYING.has(statusCode)) {
    branch = `live_data_status_${statusCode}`;
    result = { status: 'LIVE', live: true };
  } else if (
    /^(ft|full.?time|end|ended|finished|aet|ket thuc|kết thúc)/i.test(statusText) ||
    className.includes('finished') ||
    dataStatus === '-1'
  ) {
    branch = className.includes('finished') ? 'end_class_finished' : 'end_status_text';
    result = { status: 'END', live: false };
  } else if (
    className.includes('live') ||
    /\blive\b/i.test(statusText) ||
    /^(ht|1h|2h|h1|h2|pen|et)\b/i.test(statusText) ||
    hasScore
  ) {
    if (className.includes('live')) branch = 'live_class_includes_live';
    else if (hasScore) branch = 'live_score_present';
    else if (/\blive\b/i.test(statusText)) branch = 'live_status_text_live';
    else branch = 'live_status_text_period';
    result = { status: 'LIVE', live: true };
  } else {
    const kickoffMs = Number(kickoffUnixSeconds) * 1000;
    const now = Date.now();
    // VS / not-started (code 1/9/13): never force LIVE from kickoff alone
    if (Number.isFinite(kickoffMs) && now >= kickoffMs + MATCH_DURATION_MS) {
      branch = 'end_after_match_duration';
      result = { status: 'END', live: false };
    } else {
      branch =
        Number.isFinite(statusCode) && statusCode === 1
          ? 'scheduled_data_status_1'
          : hasVsOnly
            ? 'scheduled_vs_badge'
            : Number.isFinite(kickoffMs) && now >= kickoffMs
              ? 'scheduled_vs_no_live_signal_after_kickoff'
              : 'scheduled_before_kickoff';
      result = { status: 'Scheduled', live: false };
    }
  }

  // Safety net: sticky LIVE signals (score DOM / playing codes left after FT,
  // common on Club Friendlies) must not keep status LIVE past the live window.
  const kickoffMs = Number(kickoffUnixSeconds) * 1000;
  if (
    result.status === 'LIVE' &&
    Number.isFinite(kickoffMs) &&
    Date.now() >= kickoffMs + MATCH_DURATION_MS
  ) {
    branch = `${branch || 'live'}_forced_end_after_duration`;
    result = { status: 'END', live: false };
  }

  logger.debug('Soco parseMatchStatus debug', {
    source: 'soco',
    className,
    dataStatus,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    statusSelector,
    extractedStatusText: statusHit.text || '',
    extractedStatusTextLower: statusText,
    hasScore,
    hasVsOnly,
    rawStatusHtml,
    kickoffUnix: kickoffUnixSeconds,
    kickoffIso: Number.isFinite(Number(kickoffUnixSeconds))
      ? new Date(Number(kickoffUnixSeconds) * 1000).toISOString()
      : null,
    nowIso: new Date().toISOString(),
    decisionBranch: branch,
    finalStatus: result.status,
    finalLive: result.live,
  });

  if (result.status === 'LIVE') {
    logger.info('Soco status resolved to LIVE', {
      source: 'soco',
      decisionBranch: branch,
      dataStatus,
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      statusSelector,
      extractedStatusText: statusHit.text || '',
      className,
      kickoffUnix: kickoffUnixSeconds,
      finalStatus: result.status,
    });
  }

  return result;
}

/**
 * Stream URLs only when the Soco website status is LIVE.
 * Never use kickoff clock alone (site domain/status is the source of truth).
 */
function shouldAttemptStreamFetch(match) {
  return match?.status === 'LIVE' || match?.live === true;
}

function findPatterns(text, baseUrl) {
  const found = new Set();
  const regexes = [
    /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi,
    /streamingurl\s*[:=]\s*["']([^"']+)["']/gi,
    /urlStream\s*=\s*["']([^"']+)["']/gi,
    /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/gi,
  ];
  for (const regex of regexes) {
    for (const patternMatch of text.matchAll(regex)) {
      const value = patternMatch[1] || patternMatch[0];
      if (!value) continue;
      try {
        found.add(new URL(value, baseUrl).href);
      } catch {
        if (value.startsWith('http')) found.add(value);
      }
    }
  }
  return [...found];
}

function flvToM3u8(url) {
  if (!/\.flv(?:\?|$)/i.test(url)) return null;
  return url.replace(/\.flv(\?.*)?$/i, '.m3u8$1');
}

function isAdStream(url) {
  return /vd\.apisportpulse\.com/i.test(url);
}

function normalizeStreamUrl(url) {
  if (!url || isAdStream(url)) return '';
  if (/\.m3u8(?:\?|$)/i.test(url)) return url;
  const hls = flvToM3u8(url);
  return hls || '';
}

function pickStreamUrl(urls) {
  const cleaned = urls.map(normalizeStreamUrl).filter(Boolean);
  if (!cleaned.length) return '';
  return [...new Set(cleaned)].sort((a, b) => {
    const score = (url) => (/\.m3u8(?:\?|$)/i.test(url) ? 10 : 0);
    return score(b) - score(a);
  })[0];
}

function isValidStreamUrlFormat(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  if (isAdStream(trimmed)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    return false;
  }
  return Boolean(normalizeStreamUrl(trimmed) || /\.(m3u8|mpd)(?:\?|$)/i.test(trimmed));
}

function pickDomain(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).origin;
    }
    return new URL(`https://${trimmed.replace(/^\/+/, '')}`).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function extractDomainFromSocoPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.matches)) {
    for (const m of payload.matches) {
      const d =
        pickDomain(m?.matchUrl) ||
        pickDomain(m?.links?.[0]?.reffer) ||
        pickDomain(m?.links?.[0]?.referer);
      if (d) return d;
    }
  }
  for (const league of payload.leagues || []) {
    for (const m of league.matches || []) {
      const d =
        pickDomain(m?.matchUrl) ||
        pickDomain(m?.links?.[0]?.reffer) ||
        pickDomain(m?.links?.[0]?.referer);
      if (d) return d;
    }
  }
  return '';
}

function flattenPriorSocoMatches(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.matches) && payload.matches.length) {
    return payload.matches;
  }
  const out = [];
  for (const league of payload.leagues || []) {
    for (const m of league.matches || []) {
      out.push({
        matchId: m.matchId || null,
        homeTeam: m.home_team?.name || m.homeTeam || '',
        awayTeam: m.away_team?.name || m.awayTeam || '',
        status: m.status,
        streamStatus: m.streamStatus,
        streamUrl: m.streamUrl || m.links?.find((l) => l?.url)?.url || null,
        retryCount: m.retryCount,
        lastStreamCheck: m.lastStreamCheck,
        nextRetryTime: m.nextRetryTime,
        links: m.links || [],
        matchUrl: m.matchUrl,
        kickoff: m.kickoff,
      });
    }
  }
  return out;
}

function classifyNetworkError(err) {
  if (!err || typeof err !== 'object') return err;
  const msg = String(err.message || '');
  const name = String(err.name || '');
  const causeCode = err.cause?.code || err.code || '';

  if (
    name === 'AbortError' ||
    /aborted|timeout|timed out/i.test(msg) ||
    causeCode === 'ABORT_ERR'
  ) {
    err.code = err.code || 'ETIMEDOUT';
  } else if (/ENOTFOUND|getaddrinfo/i.test(msg) || causeCode === 'ENOTFOUND') {
    err.code = 'ENOTFOUND';
  } else if (/ECONNREFUSED/i.test(msg) || causeCode === 'ECONNREFUSED') {
    err.code = 'ECONNREFUSED';
  } else if (/ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg) || causeCode) {
    err.code = err.code || causeCode || 'ECONNRESET';
  }
  return err;
}

function isDomainConnectivityError(err) {
  if (!err) return false;
  if (err.domainFailure) return true;
  const code = String(err.code || err.cause?.code || '');
  const status = Number(err.httpStatus || 0);
  const msg = String(err.message || '');
  if (status === 404 || status === 502 || status === 503 || status === 521 || status === 522) {
    return true;
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'HTTP_404' ||
    code === 'DOMAIN_BLOCKED'
  ) {
    return true;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|HTTP 404|getaddrinfo/i.test(msg)) {
    return true;
  }
  return false;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function runWorker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === '') return [];
  return [value];
}

function uniqueList(value) {
  const seen = new Set();
  const out = [];
  for (const item of asList(value)) {
    const key = foldKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(item).trim());
  }
  return out;
}

function mergeSelectorMap(defaults, overrides = {}) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(overrides || {})) {
    out[key] = asList(value).length ? asList(value) : defaults[key];
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  SocoSource,
  STREAM_STATUS,
  STREAM_RETRY_MS,
  STREAM_FAILED_RETRY_MS,
  STREAM_MAX_RETRIES,
};
