/**
 * Bounded job queue for stream extraction (1GB hosts).
 * Default concurrency 2; skips duplicate keys; can cancel pending jobs by matchId.
 */
class JobQueue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 2);
    this.active = 0;
    this.maxActiveSeen = 0;
    this.pending = [];
    this.activeKeys = new Set();
    this.pendingKeys = new Set();
    this.cancelledMatches = new Set();
    this._onCancel = null;
  }

  cancelMatch(matchId) {
    const id = String(matchId || '');
    if (!id) return 0;
    this.cancelledMatches.add(id);
    let removed = 0;
    const kept = [];
    const skipped = [];
    for (const job of this.pending) {
      if (String(job.matchId) === id) {
        this.pendingKeys.delete(job.key);
        skipped.push(job);
        removed += 1;
      } else {
        kept.push(job);
      }
    }
    this.pending = kept;
    if (typeof this._onCancel === 'function') this._onCancel(skipped);
    return removed;
  }

  isCancelled(matchId) {
    return this.cancelledMatches.has(String(matchId || ''));
  }

  hasJob(key) {
    return this.activeKeys.has(key) || this.pendingKeys.has(key);
  }

  /**
   * Run jobs with a concurrency cap. Duplicate keys are skipped.
   * Jobs cancelled by matchId before start resolve as { skipped, reason: 'stopped' }.
   */
  async run(jobs, worker) {
    this.cancelledMatches = new Set();
    this.maxActiveSeen = 0;
    const results = [];
    const unique = [];
    const seen = new Set();

    for (const job of jobs || []) {
      if (!job?.key) continue;
      if (seen.has(job.key) || this.hasJob(job.key)) {
        results.push({ key: job.key, skipped: true, reason: 'duplicate' });
        continue;
      }
      seen.add(job.key);
      unique.push(job);
    }

    if (!unique.length) return results;

    await new Promise((resolveAll) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        if (this.active === 0 && this.pending.length === 0) {
          settled = true;
          this._onCancel = null;
          resolveAll();
        }
      };

      const pump = () => {
        while (this.active < this.concurrency && this.pending.length) {
          const job = this.pending.shift();
          this.pendingKeys.delete(job.key);

          if (this.cancelledMatches.has(String(job.matchId))) {
            results.push({ key: job.key, skipped: true, reason: 'stopped' });
            continue;
          }

          this.active += 1;
          this.maxActiveSeen = Math.max(this.maxActiveSeen, this.active);
          this.activeKeys.add(job.key);

          Promise.resolve()
            .then(() => worker(job))
            .then((value) => {
              results.push({ key: job.key, skipped: false, value });
            })
            .catch((error) => {
              results.push({ key: job.key, skipped: false, error });
            })
            .finally(() => {
              this.active -= 1;
              this.activeKeys.delete(job.key);
              pump();
              done();
            });
        }
        done();
      };

      this._onCancel = (skippedJobs = []) => {
        for (const job of skippedJobs) {
          results.push({ key: job.key, skipped: true, reason: 'stopped' });
        }
        pump();
        done();
      };

      for (const job of unique) {
        this.pending.push(job);
        this.pendingKeys.add(job.key);
      }
      pump();
    });

    return results;
  }
}

function scraperConcurrency() {
  const { SCRAPER_CONCURRENCY } = require('./scraperConfig');
  return Math.max(1, Number(process.env.SCRAPER_CONCURRENCY || SCRAPER_CONCURRENCY || 2));
}

module.exports = { JobQueue, scraperConcurrency };
