const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('../store/jsonStore');

function newId() {
  return crypto.randomUUID();
}

/**
 * Persistent admin overrides for matches + manual streams.
 * Applied on every Flutter JSON publish. Manual streams beat auto sources.
 */
class OverrideService {
  constructor(dataDir = path.resolve(process.cwd(), 'data/admin')) {
    this.store = new JsonStore(path.join(dataDir, 'match-overrides.json'), {
      matches: {},
    });
  }

  all() {
    return this.store.read().matches || {};
  }

  get(matchId) {
    return this.all()[matchId] || null;
  }

  ensure(matchId) {
    const all = this.all();
    if (!all[matchId]) {
      all[matchId] = defaultOverride();
      this.store.write({ matches: all });
    }
    return all[matchId];
  }

  updateMatch(matchId, patch = {}) {
    const all = this.all();
    const current = all[matchId] || defaultOverride();
    const next = {
      ...current,
      hidden: patch.hidden != null ? Boolean(patch.hidden) : current.hidden,
      pinned: patch.pinned != null ? Boolean(patch.pinned) : current.pinned,
      featured: patch.featured != null ? Boolean(patch.featured) : current.featured,
      status: patch.status !== undefined ? patch.status : current.status,
      statusLocked:
        patch.status !== undefined
          ? true
          : patch.statusLocked != null
            ? Boolean(patch.statusLocked)
            : current.statusLocked,
      kickoff: patch.kickoff !== undefined ? patch.kickoff : current.kickoff,
      date: patch.date !== undefined ? patch.date : current.date,
      time: patch.time !== undefined ? patch.time : current.time,
      league: patch.league !== undefined ? patch.league : current.league,
      leagueIcon: patch.leagueIcon !== undefined ? patch.leagueIcon : current.leagueIcon,
      homeTeam: patch.homeTeam !== undefined ? patch.homeTeam : current.homeTeam,
      awayTeam: patch.awayTeam !== undefined ? patch.awayTeam : current.awayTeam,
      updatedAt: new Date().toISOString(),
    };
    all[matchId] = next;
    this.store.write({ matches: all });
    return next;
  }

  addManualStream(matchId, streamInput) {
    const all = this.all();
    const current = all[matchId] || defaultOverride();
    const stream = normalizeManualStream(streamInput);
    current.manualStreams = [...(current.manualStreams || []), stream];
    current.updatedAt = new Date().toISOString();
    all[matchId] = current;
    this.store.write({ matches: all });
    return stream;
  }

  updateManualStream(matchId, streamId, patch = {}) {
    const all = this.all();
    const current = all[matchId];
    if (!current) throw new Error('Match override not found');
    const idx = (current.manualStreams || []).findIndex((s) => s.id === streamId);
    if (idx < 0) throw new Error('Manual stream not found');

    const prev = current.manualStreams[idx];
    current.manualStreams[idx] = {
      ...prev,
      ...normalizeManualStream({ ...prev, ...patch, id: streamId }),
      updatedAt: new Date().toISOString(),
    };
    current.updatedAt = new Date().toISOString();
    all[matchId] = current;
    this.store.write({ matches: all });
    return current.manualStreams[idx];
  }

  removeManualStream(matchId, streamId) {
    const all = this.all();
    const current = all[matchId];
    if (!current) throw new Error('Match override not found');
    current.manualStreams = (current.manualStreams || []).filter((s) => s.id !== streamId);
    current.updatedAt = new Date().toISOString();
    all[matchId] = current;
    this.store.write({ matches: all });
    return true;
  }

  /**
   * Merge scraper matches with admin overrides. Manual streams highest priority.
   */
  applyToMatches(matches = [], priorityMap = null) {
    const overrides = this.all();
    const SOURCE_PRIORITY = {
      manual: 1000,
      luongson: 500,
      cakhia: 450,
      xoilac: 400,
      '90phut': 350,
      yyzb: 300,
      socolive: 250,
      soco: 200,
      ...(priorityMap || {}),
    };

    return (matches || [])
      .map((match) => {
        const ov = overrides[match.matchId];
        if (!ov) {
          return {
            ...match,
            hidden: false,
            pinned: false,
            featured: false,
            streams: sortStreams(match.streams || [], SOURCE_PRIORITY),
          };
        }

        const autoStreams = (match.streams || []).filter(
          (s) => String(s.source || '').toLowerCase() !== 'manual'
        );
        const manual = (ov.manualStreams || [])
          .filter((s) => s.active !== false)
          .map((s) => ({
            source: 'manual',
            type: s.type || 'm3u8',
            quality: s.quality || s.name || 'HD',
            name: s.name || s.quality || 'HD',
            url: s.url,
            headers: {
              'User-Agent': s.headers?.['User-Agent'] || '',
              Referer: s.headers?.Referer || '',
              ...(s.headers?.Cookie ? { Cookie: s.headers.Cookie } : {}),
            },
            active: s.active !== false,
            priority: 1000,
            checkedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
            manualId: s.id,
          }));

        const streams = sortStreams([...manual, ...autoStreams], SOURCE_PRIORITY);
        const kickoff = ov.kickoff || match.kickoff;

        return {
          ...match,
          hidden: Boolean(ov.hidden),
          pinned: Boolean(ov.pinned),
          featured: Boolean(ov.featured),
          status: ov.status || match.status,
          statusLocked: Boolean(ov.statusLocked || ov.status || match.statusLocked),
          kickoff,
          date: ov.date || match.date,
          time: ov.time || match.time,
          league: ov.league || match.league,
          leagueIcon: ov.leagueIcon || match.leagueIcon || null,
          homeTeam: ov.homeTeam || match.homeTeam,
          awayTeam: ov.awayTeam || match.awayTeam,
          streams,
          hasStreams: streams.some((s) => s.active !== false && s.url),
          streamCount: streams.filter((s) => s.active !== false && s.url).length,
          adminOverride: true,
        };
      })
      .filter((m) => !m.hidden)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return String(a.kickoff || '').localeCompare(String(b.kickoff || ''));
      });
  }
}

function defaultOverride() {
  return {
    hidden: false,
    pinned: false,
    featured: false,
    status: null,
    statusLocked: false,
    kickoff: null,
    date: null,
    time: null,
    league: null,
    leagueIcon: null,
    homeTeam: null,
    awayTeam: null,
    manualStreams: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeManualStream(input = {}) {
  if (!input.url || !String(input.url).trim()) {
    throw new Error('Stream URL is required');
  }
  const quality = input.quality || input.name || 'HD';
  return {
    id: input.id || newId(),
    source: 'manual',
    type: input.type || 'm3u8',
    quality,
    name: input.name || quality,
    url: String(input.url).trim(),
    headers: {
      'User-Agent': input.headers?.['User-Agent'] || input.userAgent || '',
      Referer: input.headers?.Referer || input.referer || '',
      ...(input.headers?.Cookie || input.cookie
        ? { Cookie: input.headers?.Cookie || input.cookie }
        : {}),
    },
    active: input.active !== false,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function sortStreams(streams, priorityMap) {
  return [...streams].sort((a, b) => {
    const pa =
      a.priority != null
        ? Number(a.priority)
        : priorityMap[String(a.source || '').toLowerCase()] || 0;
    const pb =
      b.priority != null
        ? Number(b.priority)
        : priorityMap[String(b.source || '').toLowerCase()] || 0;
    if (pa !== pb) return pb - pa;
    return 0;
  });
}

module.exports = { OverrideService };
