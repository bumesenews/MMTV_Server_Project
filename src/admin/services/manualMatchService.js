const path = require('path');
const { JsonStore } = require('../store/jsonStore');
const { generateMatchId } = require('../../utils/matchId');
const { combineDateAndTime, formatDate, formatTime, toYangon } = require('../../utils/time');

/**
 * Admin-created matches persisted separately from scraper output.
 * Merged into publish pipeline before overrides / Flutter JSON.
 */
class ManualMatchService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    this.store = new JsonStore(path.join(dataDir, 'manual-matches.json'), {
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
    if (!current) throw new Error('Manual match not found');

    const next = { ...current };
    for (const key of [
      'league',
      'leagueIcon',
      'homeTeam',
      'awayTeam',
      'homeLogo',
      'awayLogo',
      'status',
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
      const url = patch.streamUrl !== undefined ? String(patch.streamUrl || '').trim() : next.streams?.[0]?.url;
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
    if (!all[matchId]) throw new Error('Manual match not found');
    delete all[matchId];
    this.store.write({ matches: all });
    return true;
  }

  /**
   * Merge manual matches into scraper list (manual wins on same matchId).
   */
  mergeInto(matches = []) {
    const byId = new Map();
    for (const m of matches || []) {
      if (m?.matchId) byId.set(m.matchId, m);
    }
    for (const manual of this.list()) {
      const existing = byId.get(manual.matchId);
      if (!existing) {
        byId.set(manual.matchId, { ...manual });
        continue;
      }
      // Prefer manual metadata; keep auto streams if manual has none
      const streams =
        manual.streams?.length > 0
          ? [...manual.streams, ...(existing.streams || []).filter((s) => s.source !== 'manual')]
          : existing.streams || [];
      byId.set(manual.matchId, {
        ...existing,
        ...manual,
        streams,
        hasStreams: streams.some((s) => s?.url && s.active !== false),
        streamCount: streams.filter((s) => s?.url && s.active !== false).length,
        manual: true,
        statusLocked: true,
      });
    }
    return [...byId.values()];
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

module.exports = { ManualMatchService };
