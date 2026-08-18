class DashboardService {
  constructor({
    pipeline,
    cache,
    overrideService,
    sourceAdminService,
    leagueAdminService,
    publishService,
  }) {
    this.pipeline = pipeline;
    this.cache = cache;
    this.overrides = overrideService;
    this.sources = sourceAdminService;
    this.leagues = leagueAdminService;
    this.publish = publishService;
  }

  get() {
    const delivery =
      typeof this.cache.getDelivery === 'function'
        ? this.cache.getDelivery('matches')
        : null;
    const current = this.cache.getCurrent();
    const payload =
      delivery && Array.isArray(delivery.matches) ? delivery : current;
    const matches = payload?.matches || [];
    const overrideMap = this.overrides.all();
    const matchFailures = collectSourceFailuresFromMatches(matches);

    let manualStreams = 0;
    let totalStreams = 0;
    for (const m of matches) {
      for (const s of m.streams || []) {
        totalStreams += 1;
        if (String(s.source).toLowerCase() === 'manual') manualStreams += 1;
      }
    }

    const storedManual = Object.values(overrideMap).reduce(
      (n, ov) => n + (ov.manualStreams || []).length,
      0
    );

    const sources = this.sources.list().map((s) => {
      const extra = matchFailures.get(s.name);
      const lastError = s.lastError || extra?.lastError || null;
      const lastErrorAt = s.lastErrorAt || extra?.lastErrorAt || null;
      return {
        ...s,
        lastError,
        lastErrorAt,
        failedMatchCount: extra?.matches.length || 0,
        failedMatches: extra?.matches.slice(0, 12) || [],
      };
    });

    const failedSourceDetails = sources.filter(
      (s) => s.lastError || s.failedMatchCount > 0
    );

    return {
      totalMatches: matches.length,
      liveMatches: matches.filter((m) => m.status === 'LIVE').length,
      scheduledMatches: matches.filter((m) => m.status === 'Scheduled').length,
      endedMatches: matches.filter((m) => m.status === 'END').length,
      totalStreams,
      manualStreams: Math.max(manualStreams, storedManual),
      pinnedMatches: matches.filter((m) => m.pinned).length,
      featuredMatches: matches.filter((m) => m.featured).length,
      activeSources: sources.filter((s) => s.enabled).length,
      failedSources: failedSourceDetails.length,
      sources,
      failedSourceDetails,
      leaguesEnabled: this.leagues.list().filter((l) => l.enabled).length,
      leaguesTotal: this.leagues.list().length,
      lastScraperRun: this.pipeline.lastRun || null,
      scraperRunning: Boolean(this.pipeline.running),
      lastGithubUpload: this.publish.lastGithub || payload?.meta?.lastGithub || current?.meta?.lastGithub || null,
      generatedAt: payload?.generatedAt || current?.generatedAt || null,
      awsServerStatus: {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        node: process.version,
        timezone: 'Asia/Yangon',
      },
    };
  }
}

function collectSourceFailuresFromMatches(matches = []) {
  const map = new Map();
  for (const match of matches) {
    const perSource = match?.streamSearch?.sources || {};
    for (const [name, state] of Object.entries(perSource)) {
      const lastError = state?.lastError || null;
      const status = String(state?.status || '');
      const failed = Boolean(lastError) || status === 'FAILED';
      if (!failed) continue;
      if (!map.has(name)) {
        map.set(name, { lastError, lastErrorAt: state.lastAttemptAt || null, matches: [] });
      }
      const row = map.get(name);
      row.matches.push({
        matchId: match.matchId || null,
        homeTeam: match.homeTeam || '',
        awayTeam: match.awayTeam || '',
        status,
        lastError,
        lastAttemptAt: state.lastAttemptAt || null,
      });
      if (String(state.lastAttemptAt || '') > String(row.lastErrorAt || '')) {
        row.lastError = lastError;
        row.lastErrorAt = state.lastAttemptAt || row.lastErrorAt;
      }
    }
  }
  return map;
}

module.exports = { DashboardService, collectSourceFailuresFromMatches };
