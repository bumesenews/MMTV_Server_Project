const dns = require('dns');
const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { toYangon, formatDate, formatTime, isTodayOrTomorrow } = require('../utils/time');
const { foldKey } = require('../utils/normalize');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const DEFAULT_BASE_URL = 'https://socolivegg.io';
const DEFAULT_SPORT = 'football';
const STREAM_CONCURRENCY = Number(process.env.SOCO_CONCURRENCY || 2);
const STREAM_LEAD_MS = 5 * 60 * 1000;
const MATCH_DURATION_MS = (105 + 30) * 60 * 1000;
const FETCH_RETRIES = 3;
const FETCH_DELAY_MS = 1200;

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

/**
 * Source: socolivemm.io (from MM_TV.Pro soco.js)
 * HTTP/Cheerio based — domain, paths, selectors, attrs are config-driven.
 */
class SocoSource {
  constructor({ config, normalizer }) {
    this.name = 'soco';
    this.config = config || {};
    this.normalizer = normalizer;
    this.baseUrl = this.resolveBaseUrl();
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
    this.teamLogoTemplate =
      this.config.teamLogoTemplate || DEFAULT_TEAM_LOGO_TEMPLATE;
  }

  /**
   * Keep only configured leagues (UEFA CL, FIF, AFF Cup, KOR D1, BRA D1, …).
   * Resolves filter aliases via Normalizer, then compares to the card league.
   */
  passesLeagueFilter(leagueRaw, standardLeague) {
    if (!this.leagueFilter.length) {
      return this.onlyAllowedLeagues ? Boolean(standardLeague) : true;
    }
    if (!this._filterStandards) {
      this._filterStandards = new Set();
      for (const name of this.leagueFilter) {
        const mapped = this.normalizer ? this.normalizer.normalizeLeague(name) : name;
        if (mapped) this._filterStandards.add(foldKey(mapped));
        this._filterStandards.add(foldKey(name));
      }
    }
    const std = standardLeague || (this.normalizer
      ? this.normalizer.normalizeLeague(leagueRaw)
      : leagueRaw);
    return (
      this._filterStandards.has(foldKey(std)) ||
      this._filterStandards.has(foldKey(leagueRaw))
    );
  }

  resolveBaseUrl() {
    const domains = [
      ...(this.config.domains || []),
      ...(this.config.mirrorDomains || []),
    ].filter(Boolean);
    return domains[0] || DEFAULT_BASE_URL;
  }

  headers(referer = this.baseUrl) {
    const custom = this.config.headers || {};
    return {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer.endsWith('/') ? referer : `${referer}/`,
      ...custom,
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
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSectionHtml(section) {
    const url = this.sectionUrl(section);
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
      try {
        const text = await this.fetchText(url);
        const trimmed = text.trim();
        if (!trimmed.startsWith('{')) {
          throw new Error(`non-JSON response (${trimmed.slice(0, 40)}...)`);
        }
        const payload = JSON.parse(trimmed);
        if (!payload?.success || !Array.isArray(payload?.data?.htmls)) {
          throw new Error('missing htmls in API payload');
        }
        return payload.data.htmls.join('');
      } catch (err) {
        if (attempt < FETCH_RETRIES) {
          await sleep(FETCH_DELAY_MS);
          continue;
        }
        logger.warn('Soco section failed', { section, url, error: err.message });
        return '';
      }
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

      const normalizedLeague = this.normalizer
        ? this.normalizer.normalizeLeague(leagueRaw)
        : leagueRaw;
      const standardLeague = this.normalizer
        ? this.normalizer.filterAllowedLeague(leagueRaw)
        : leagueRaw;

      if (!this.passesLeagueFilter(leagueRaw, standardLeague || normalizedLeague)) return;

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
        originalNames: {
          soco: { league: leagueRaw, homeTeam: homeRaw, awayTeam: awayRaw },
        },
      });
    });

    return matches;
  }

  async discoverMatches() {
    logEvent(events.SCRAPER_START, 'Soco discover start', {
      source: this.name,
      baseUrl: this.baseUrl,
      sections: this.sections,
    });
    const all = [];
    for (const section of this.sections) {
      const html = await this.fetchSectionHtml(section);
      if (html) all.push(...this.parseMatchesFromHtml(html, section));
      await sleep(FETCH_DELAY_MS);
    }
    logEvent(events.SCRAPER_SUCCESS, 'Soco discover success', {
      source: this.name,
      count: all.length,
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
   * Full scrape for Flutter soco.json (today/tomorrow cards + stream links).
   * Unlike collectForFixtures, this is not limited to FotMob matchIds.
   */
  async scrapeFull({ fetchStreams = true } = {}) {
    logEvent(events.SCRAPER_START, 'Soco full scrape start', {
      source: this.name,
      baseUrl: this.baseUrl,
    });
    const discovered = await this.discoverMatches();
    // soco.json: only scrape m3u8 links when the site marks the match LIVE (not VS/Scheduled)
    const targets = fetchStreams
      ? discovered.filter((m) => m.status === 'LIVE')
      : [];

    logger.info('Soco scrapeFull status summary', {
      source: this.name,
      total: discovered.length,
      liveCount: discovered.filter((m) => m.status === 'LIVE').length,
      scheduledCount: discovered.filter((m) => m.status === 'Scheduled').length,
      endCount: discovered.filter((m) => m.status === 'END').length,
      streamFetchTargets: targets.length,
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

    const linksById = new Map();
    const enriched = await mapWithConcurrency(targets, STREAM_CONCURRENCY, async (match) => {
      try {
        const links = await this.buildMatchLinks(match.matchUrl, true);
        return { matchId: match.matchId, links };
      } catch (err) {
        logEvent(events.SCRAPER_ERROR, 'Soco full scrape match failed', {
          source: this.name,
          matchId: match.matchId,
          error: err.message,
        });
        return { matchId: match.matchId, links: [] };
      }
    });

    for (const row of enriched) {
      if (row) linksById.set(row.matchId, row.links || []);
    }

    const matches = discovered.map((m) => ({
      ...m,
      // Never publish stream URLs for non-LIVE (VS / Scheduled / END)
      links: m.status === 'LIVE' ? linksById.get(m.matchId) || [] : [],
    }));

    logEvent(events.SCRAPER_SUCCESS, 'Soco full scrape success', {
      source: this.name,
      count: matches.length,
      withLinks: matches.filter((m) => (m.links || []).some((l) => l.url)).length,
    });

    return {
      generatedAt: new Date().toISOString(),
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

function shouldAttemptStreamFetch(match) {
  if (match.status === 'END') return false;
  if (match.status === 'LIVE') return true;
  const kickoffMs = Number(match.kickoffUnix) * 1000;
  return Number.isFinite(kickoffMs) && Date.now() >= kickoffMs - STREAM_LEAD_MS;
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

module.exports = { SocoSource };
