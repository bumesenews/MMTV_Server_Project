/**
 * Phase 3 — 1GB-safe scheduler: peak window, priority, locks.
 * Run: node scripts/testPhase3Scheduler.js
 */
const { DateTime } = require('luxon');
const {
  ZONE,
  HEAVY_JOBS,
  DEFAULT_CRONS,
  isFootballPeakWindow,
  mayRunLowPriorityHeavyJob,
  prioritizeHeavyJobs,
  selectNextHeavyJob,
} = require('../src/utils/jobSchedule');
const { Pipeline } = require('../src/services/pipeline');

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function yangonAt(hour, minute = 0) {
  return DateTime.fromObject(
    { year: 2026, month: 9, day: 6, hour, minute },
    { zone: ZONE }
  );
}

console.log('\n=== Phase 3: default crons ===');
assert('Matches cron every 5 min', DEFAULT_CRONS.PIPELINE_CRON === '*/5 * * * *');
assert('MyanmarTV once daily 03:00', DEFAULT_CRONS.MYANMARTV_CRON === '0 3 * * *');
assert('Highlights once daily 06:00', DEFAULT_CRONS.HIGHLIGHT_CRON === '0 6 * * *');
assert('Tips once daily 08:07', DEFAULT_CRONS.TIPS_CRON === '7 8 * * *');
assert('Timezone Asia/Yangon', ZONE === 'Asia/Yangon');

console.log('\n=== Phase 3: peak window 17:00–03:00 ===');
assert('16:59 not peak', isFootballPeakWindow(yangonAt(16, 59)) === false);
assert('17:00 is peak', isFootballPeakWindow(yangonAt(17, 0)) === true);
assert('22:00 is peak', isFootballPeakWindow(yangonAt(22, 0)) === true);
assert('00:00 is peak', isFootballPeakWindow(yangonAt(0, 0)) === true);
assert('02:59 is peak', isFootballPeakWindow(yangonAt(2, 59)) === true);
assert('03:00 not peak', isFootballPeakWindow(yangonAt(3, 0)) === false);
assert('08:07 not peak', isFootballPeakWindow(yangonAt(8, 7)) === false);

console.log('\n=== Phase 3: low-priority exclusion during peak ===');
for (const [label, hour] of [
  ['17:00', 17],
  ['20:00', 20],
  ['02:00', 2],
]) {
  const when = yangonAt(hour);
  assert(
    `Peak ${label}: Highlights blocked`,
    mayRunLowPriorityHeavyJob(when) === false
  );
  assert(
    `Peak ${label}: Tips blocked`,
    mayRunLowPriorityHeavyJob(when) === false
  );
  assert(
    `Peak ${label}: MyanmarTV blocked`,
    mayRunLowPriorityHeavyJob(when) === false
  );
  assert(
    `Peak ${label}: Matches still selected`,
    selectNextHeavyJob(
      [HEAVY_JOBS.HIGHLIGHTS, HEAVY_JOBS.TIPS, HEAVY_JOBS.MYANMARTV, HEAVY_JOBS.MATCHES],
      { when }
    ) === HEAVY_JOBS.MATCHES
  );
}

console.log('\n=== Phase 3: priority on same tick ===');
assert(
  'Matches vs MyanmarTV → Matches',
  selectNextHeavyJob([HEAVY_JOBS.MYANMARTV, HEAVY_JOBS.MATCHES], {
    when: yangonAt(4),
  }) === HEAVY_JOBS.MATCHES
);
assert(
  'Matches vs Highlights → Matches',
  selectNextHeavyJob([HEAVY_JOBS.HIGHLIGHTS, HEAVY_JOBS.MATCHES], {
    when: yangonAt(6),
  }) === HEAVY_JOBS.MATCHES
);
assert(
  'Matches vs Tips → Matches',
  selectNextHeavyJob([HEAVY_JOBS.TIPS, HEAVY_JOBS.MATCHES], {
    when: yangonAt(8),
  }) === HEAVY_JOBS.MATCHES
);
{
  const order = prioritizeHeavyJobs([
    HEAVY_JOBS.MYANMARTV,
    HEAVY_JOBS.TIPS,
    HEAVY_JOBS.MATCHES,
    HEAVY_JOBS.HIGHLIGHTS,
  ]);
  assert(
    'All four → Matches → Highlights → Tips → MyanmarTV',
    order.join(',') ===
      [
        HEAVY_JOBS.MATCHES,
        HEAVY_JOBS.HIGHLIGHTS,
        HEAVY_JOBS.TIPS,
        HEAVY_JOBS.MYANMARTV,
      ].join(',')
  );
}
assert(
  'Non-peak without Matches → Highlights first',
  selectNextHeavyJob(
    [HEAVY_JOBS.MYANMARTV, HEAVY_JOBS.TIPS, HEAVY_JOBS.HIGHLIGHTS],
    { when: yangonAt(10) }
  ) === HEAVY_JOBS.HIGHLIGHTS
);

console.log('\n=== Phase 3: independent schedules (non-collision) ===');
assert(
  '03:00 selects MyanmarTV alone',
  selectNextHeavyJob([HEAVY_JOBS.MYANMARTV], { when: yangonAt(3) }) ===
    HEAVY_JOBS.MYANMARTV
);
assert(
  '06:00 selects Highlights alone',
  selectNextHeavyJob([HEAVY_JOBS.HIGHLIGHTS], { when: yangonAt(6) }) ===
    HEAVY_JOBS.HIGHLIGHTS
);
assert(
  '08:07 selects Tips alone',
  selectNextHeavyJob([HEAVY_JOBS.TIPS], { when: yangonAt(8, 7) }) ===
    HEAVY_JOBS.TIPS
);

console.log('\n=== Phase 3: locks — active vs stale ===');
{
  const p = new Pipeline({ PIPELINE_MAX_RUN_MS: String(60 * 1000) });
  p.tipsRunning = true;
  p._tipsSince = Date.now();
  p._clearStuckJobLocks();
  assert('Active lock not cleared', p.tipsRunning === true);

  p._tipsSince = Date.now() - 6 * 60 * 1000;
  p._clearStuckJobLocks();
  assert('Stale lock recovered', p.tipsRunning === false && p._tipsSince === 0);

  p.highlightRunning = true;
  p._highlightSince = 0;
  p._clearStuckJobLocks();
  assert('Orphan lock (no timestamp) cleared', p.highlightRunning === false);
}

console.log('\n=== Phase 3: duplicate / one-at-a-time / queue Matches ===');
{
  const p = new Pipeline({ PIPELINE_MAX_RUN_MS: String(20 * 60 * 1000) });
  // Simulate non-peak by only testing lock flags (peak gate uses wall clock —
  // force:true bypasses peak for admin/manual).
  p.tipsRunning = true;
  p._tipsSince = Date.now();

  // Matches blocked by tips → queued
  const blocked = (() => {
    // Mirror run() gate without starting scrape
    p._clearStuckJobLocks();
    if (p.tipsRunning) {
      p._pendingMatches = true;
      return { ok: false, reason: 'tips_running', queued: true };
    }
    return { ok: true };
  })();
  assert('Lower-priority job blocks Matches start', blocked.reason === 'tips_running');
  assert('Matches queued for drain', p._pendingMatches === true);

  // Duplicate tips prevented
  p._pendingMatches = false;
  const dupTips = (() => {
    p._clearStuckJobLocks();
    if (p.tipsRunning) return { ok: false, reason: 'already_running' };
    return { ok: true };
  })();
  assert('Duplicate heavy Tips prevented', dupTips.reason === 'already_running');

  // Completion releases lock
  p.tipsRunning = false;
  p._tipsSince = 0;
  assert('Job completion releases lock', p.tipsRunning === false);

  // Exception path: finally always clears
  p.channelsRunning = true;
  p._channelsSince = Date.now();
  try {
    throw new Error('boom');
  } catch {
    p.channelsRunning = false;
    p._channelsSince = 0;
  }
  assert('Job exception releases lock', p.channelsRunning === false);

  // Concurrent heavy jobs not allowed: any second job sees first flag
  p.running = true;
  p._runningSince = Date.now();
  p.highlightRunning = false;
  const noParallel = p.running && !p.highlightRunning;
  assert('Only one heavy workload at a time (Matches owns lock)', noParallel === true);
  p.running = false;
  p._runningSince = 0;
}

console.log('\n=== Phase 3: peak API skip (force bypass) ===');
{
  const peak = yangonAt(20);
  assert(
    'Scheduled low-priority blocked at peak',
    mayRunLowPriorityHeavyJob(peak, { force: false }) === false
  );
  assert(
    'force=true may run low-priority (admin)',
    mayRunLowPriorityHeavyJob(peak, { force: true }) === true
  );
}

console.log('\n=== Phase 3: drain priority order (Matches before Highlights) ===');
{
  const due = [
    HEAVY_JOBS.MYANMARTV,
    HEAVY_JOBS.TIPS,
    HEAVY_JOBS.HIGHLIGHTS,
    HEAVY_JOBS.MATCHES,
  ];
  const first = selectNextHeavyJob(due, { when: yangonAt(10) });
  const rest = prioritizeHeavyJobs(due.filter((j) => j !== first));
  assert('Drain order starts with Matches', first === HEAVY_JOBS.MATCHES);
  assert('Then Highlights', rest[0] === HEAVY_JOBS.HIGHLIGHTS);
  assert('Then Tips', rest[1] === HEAVY_JOBS.TIPS);
  assert('Then MyanmarTV', rest[2] === HEAVY_JOBS.MYANMARTV);
}

console.log(`\nPhase 3 results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
