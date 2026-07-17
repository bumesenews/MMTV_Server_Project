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
    const current = this.cache.getCurrent();
    const matches = current?.matches || [];
    const overrideMap = this.overrides.all();
    const sources = this.sources.list();

    let manualStreams = 0;
    let totalStreams = 0;
    for (const m of matches) {
      for (const s of m.streams || []) {
        totalStreams += 1;
        if (String(s.source).toLowerCase() === 'manual') manualStreams += 1;
      }
    }

    // Also count stored manual streams even if match hidden from JSON
    for (const ov of Object.values(overrideMap)) {
      manualStreams = Math.max(
        manualStreams,
        (ov.manualStreams || []).filter((s) => s.active !== false).length
          ? manualStreams
          : manualStreams
      );
    }

    const storedManual = Object.values(overrideMap).reduce(
      (n, ov) => n + (ov.manualStreams || []).length,
      0
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
      failedSources: sources.filter((s) => s.lastError).length,
      sources,
      leaguesEnabled: this.leagues.list().filter((l) => l.enabled).length,
      leaguesTotal: this.leagues.list().length,
      lastScraperRun: this.pipeline.lastRun || null,
      scraperRunning: Boolean(this.pipeline.running),
      lastGithubUpload: this.publish.lastGithub || current?.meta?.lastGithub || null,
      generatedAt: current?.generatedAt || null,
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

module.exports = { DashboardService };
