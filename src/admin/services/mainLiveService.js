const path = require('path');
const { JsonStore } = require('../store/jsonStore');
const { generateMatchId } = require('../../utils/matchId');
const { combineDateAndTime, formatDate, formatTime, toYangon, nowYangon } = require('../../utils/time');
const { hashPayload, sanitizeForCompare } = require('../../utils/compare');

/**
 * Admin-owned MainLive feed (mainlive.json) — separate from scraped matches.json.
 * Stored locally; published to delivery + GitHub on change.
 */
class MainLiveService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    this.store = new JsonStore(path.join(dataDir, 'mainlive-matches.json'), {
      matches: {},
    });
  }

  all() {
    return this.store.read().matches || {};
  }

  list() {
    return Object.values(this.all()).sort((a, b) =>
      String(a.kickoff || '').localeCompare(String(b.kickoff || ''))
    );
  }

  get(matchId) {
    return this.all()[matchId] || null;
  }

  create(input = {}) {
    const homeTeam = String(input.homeTeam || '').trim();
    const awayTeam = String(input.awayTeam || '').trim();
    const league = String(input.league || '').trim();
    if (!homeTeam || !awayTeam) throw new Error('Home and away teams are required');
    if (!league) throw new Error('League is required');

    const date = String(input.date || '').trim();
    const time = String(input.time || '').trim() || '00:00';
    if (!date) throw new Error('Date is required (yyyy-MM-dd)');

    let kickoff = input.kickoff ? toYangon(input.kickoff) : combineDateAndTime(date, time);
    if (!kickoff || !kickoff.isValid) throw new Error('Invalid date/time');

    const matchId = input.matchId || generateMatchId(homeTeam, awayTeam, kickoff);
    const existing = this.all();
    if (existing[matchId]) throw new Error(`Match already exists: ${matchId}`);

    const status = normalizeStatus(input.status);
    const streamUrl = String(input.streamUrl || input.url || '').trim();
    const streamName = String(input.streamName || input.quality || 'HD').trim() || 'HD';

    const streams = [];
    if (streamUrl) {
      streams.push({
        source: 'manual',
        type: 'm3u8',
        quality: streamName,
        name: streamName,
        url: streamUrl,
        headers: {
          'User-Agent': input.userAgent || '',
          Referer: input.referer || '',
        },
        active: true,
        priority: 1000,
        checkedAt: new Date().toISOString(),
      });
    }

    const match = {
      matchId,
      manual: true,
      statusLocked: true,
      league,
      leagueIcon: String(input.leagueIcon || '').trim() || null,
      homeTeam,
      awayTeam,
      homeLogo: String(input.homeLogo || '').trim() || null,
      awayLogo: String(input.awayLogo || '').trim() || null,
      homeTeamId: null,
      awayTeamId: null,
      date: formatDate(kickoff),
      time: formatTime(kickoff),
      kickoff: kickoff.toISO(),
      timezone: 'Asia/Yangon',
      status,
      pinned: Boolean(input.pinned),
      featured: Boolean(input.featured),
      streams,
      hasStreams: streams.length > 0,
      streamCount: streams.length,
      originalNames: {},
      sourcePages: {},
      streamAttempts: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    existing[matchId] = match;
    this.store.write({ matches: existing });
    return match;
  }

  update(matchId, patch = {}) {
    const all = this.all();
    const current = all[matchId];
    if (!current) throw new Error('MainLive match not found');

    const next = { ...current };
    for (const key of [
      'league',
      'leagueIcon',
      'homeTeam',
      'awayTeam',
      'homeLogo',
      'awayLogo',
      'pinned',
      'featured',
    ]) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }

    if (patch.status !== undefined) {
      next.status = normalizeStatus(patch.status);
      next.statusLocked = true;
    }

    if (patch.date || patch.time || patch.kickoff) {
      const date = patch.date || next.date;
      const time = patch.time || next.time || '00:00';
      const kickoff = patch.kickoff
        ? toYangon(patch.kickoff)
        : combineDateAndTime(date, time);
      if (!kickoff || !kickoff.isValid) throw new Error('Invalid date/time');
      next.kickoff = kickoff.toISO();
      next.date = formatDate(kickoff);
      next.time = formatTime(kickoff);
    }

    if (patch.streamUrl !== undefined || patch.streamName !== undefined) {
      const url =
        patch.streamUrl !== undefined
          ? String(patch.streamUrl || '').trim()
          : next.streams?.[0]?.url;
      const name =
        patch.streamName !== undefined
          ? String(patch.streamName || 'HD').trim() || 'HD'
          : next.streams?.[0]?.name || next.streams?.[0]?.quality || 'HD';
      if (url) {
        next.streams = [
          {
            source: 'manual',
            type: 'm3u8',
            quality: name,
            name,
            url,
            headers: next.streams?.[0]?.headers || { 'User-Agent': '', Referer: '' },
            active: true,
            priority: 1000,
            checkedAt: new Date().toISOString(),
          },
        ];
      } else {
        next.streams = [];
      }
      next.hasStreams = next.streams.length > 0;
      next.streamCount = next.streams.length;
    }

    next.manual = true;
    next.statusLocked = next.statusLocked !== false;
    next.updatedAt = new Date().toISOString();
    all[matchId] = next;
    this.store.write({ matches: all });
    return next;
  }

  remove(matchId) {
    const all = this.all();
    if (!all[matchId]) throw new Error('MainLive match not found');
    delete all[matchId];
    this.store.write({ matches: all });
    return true;
  }

  /**
   * Build Flutter delivery payload for mainlive.json (same shape as matches.json).
   */
  toDeliveryPayload() {
    const matches = this.list();
    const payload = {
      version: 1,
      generatedAt: nowYangon().toISO(),
      timezone: 'Asia/Yangon',
      matchCount: matches.length,
      matches,
      meta: {
        feed: 'mainlive',
        source: 'admin',
        liveCount: matches.filter((m) => m.status === 'LIVE').length,
        scheduledCount: matches.filter((m) => m.status === 'Scheduled').length,
        endedCount: matches.filter((m) => m.status === 'END').length,
      },
    };
    payload.meta.checksum = hashPayload(sanitizeForCompare(payload));
    return payload;
  }
}

function normalizeStatus(raw) {
  const s = String(raw || 'Scheduled').trim();
  if (s === 'LIVE' || s === 'END' || s === 'Scheduled' || s === 'PREPARING_STREAM') return s;
  const lower = s.toLowerCase();
  if (lower === 'live') return 'LIVE';
  if (lower === 'end' || lower === 'ended' || lower === 'finished') return 'END';
  if (lower.includes('prepar')) return 'PREPARING_STREAM';
  return 'Scheduled';
}

module.exports = { MainLiveService };
