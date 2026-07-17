const dns = require('dns');
const { load } = require('cheerio');
const { logger, logEvent, events } = require('../utils/logger');
const { generateMatchId } = require('../utils/matchId');
const { toYangon, formatDate, formatTime, isTodayOrTomorrow } = require('../utils/time');
const { DEFAULT_UA } = require('../browser/puppeteerManager');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const BASE_URL = 'https://socolivemm.io';
const SPORT = 'football';
const STREAM_CONCURRENCY = 6;
const STREAM_LEAD_MS = 5 * 60 * 1000;
const MATCH_DURATION_MS = (105 + 30) * 60 * 1000;
const FETCH_RETRIES = 3;
const FETCH_DELAY_MS = 1200;
const SECTIONS = ['today', 'tomorrow'];

/**
 * Source: socolivemm.io (from MM_TV.Pro soco.js)
 * HTTP/Cheerio based — no Puppeteer required.
 */
class SocoSource {
  constructor({ config, normalizer }) {
    this.name = 'soco';
    this.config = config || {};
    this.normalizer = normalizer;
    this.baseUrl = (this.config.domains && this.config.domains[0]) || BASE_URL;
  }

  headers(referer = this.baseUrl) {
    return {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer.endsWith('/') ? referer : `${referer}/`,
    };
  }

  absUrl(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${this.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
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
    const url = `${this.baseUrl}/sport/${SPORT}/filter/${section}`;
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
        logger.warn('Soco section failed', { section, error: err.message });
        return '';
      }
    }
    return '';
  }

  parseMatchesFromHtml(html, sectionKey) {
    const $ = load(html);
    const matches = [];
    const seen = new Set();

    $('.match-football-item').each((_, el) => {
      const card = $(el);
      if (card.attr('data-sport') && card.attr('data-sport') !== SPORT) return;

      const kickoffUnix = card.attr('data-runtime');
      if (!kickoffUnix) return;

      const kickoff = toYangon(Number(kickoffUnix) * 1000);
      if (!kickoff || !isTodayOrTomorrow(kickoff)) return;

      const homeRaw = card.find('.grid-match__team--home-name').first().text().trim();
      const awayRaw = card.find('.grid-match__team--away-name').first().text().trim();
      const matchPath = card.find('a.redirectPopup').first().attr('href');
      const matchUrl = this.absUrl(matchPath);
      const leagueRaw =
        card.find('.grid-match__league-name').first().text().trim() ||
        card.find('.grid-match__league span').first().text().trim() ||
        card.find('.grid-match__league').first().text().trim() ||
        '';

      if (!homeRaw || !awayRaw || !matchUrl) return;

      const standardLeague = this.normalizer
        ? this.normalizer.filterAllowedLeague(leagueRaw)
        : leagueRaw;
      // Keep all for discovery; league filter applied when merging to FotMob fixtures
      const homeTeam = this.normalizer ? this.normalizer.normalizeTeam(homeRaw) : homeRaw;
      const awayTeam = this.normalizer ? this.normalizer.normalizeTeam(awayRaw) : awayRaw;
      const matchId = generateMatchId(homeTeam, awayTeam, kickoff);
      if (seen.has(matchId)) return;
      seen.add(matchId);

      const { status, live } = parseMatchStatus(card, kickoffUnix);

      matches.push({
        matchId,
        league: standardLeague || leagueRaw,
        leagueAllowed: Boolean(standardLeague),
        homeTeam,
        awayTeam,
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
    logEvent(events.SCRAPER_START, 'Soco discover start', { source: this.name });
    const all = [];
    for (const section of SECTIONS) {
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
    $('#tv_links a.player-link, #tv_links .player-link').each((_, el) => {
      const anchor = $(el);
      const rawIndex = anchor.attr('data-link');
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

function parseMatchStatus(card, kickoffUnixSeconds) {
  const className = (card.attr('class') || '').toLowerCase();
  const dataStatus = String(card.attr('data-status') || card.attr('data-match-status') || '').trim();
  const statusText = card
    .find('.grid-match__status, .grid-match__time, .grid-match__state, .match-status')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (
    /^(ft|full|end|ended|finished|aet|pen|cancel|postpon|abandon)/i.test(statusText) ||
    className.includes('finished') ||
    dataStatus === '2' ||
    dataStatus === '-1'
  ) {
    return { status: 'END', live: false };
  }

  if (
    className.includes('live') ||
    dataStatus === '1' ||
    /\blive\b/i.test(statusText) ||
    /^ht$/i.test(statusText)
  ) {
    return { status: 'LIVE', live: true };
  }

  const kickoffMs = Number(kickoffUnixSeconds) * 1000;
  const now = Date.now();
  if (!Number.isFinite(kickoffMs) || now < kickoffMs) {
    return { status: 'Scheduled', live: false };
  }
  if (now < kickoffMs + MATCH_DURATION_MS) {
    return { status: 'LIVE', live: true };
  }
  return { status: 'END', live: false };
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { SocoSource };
