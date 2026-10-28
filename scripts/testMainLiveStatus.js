/**
 * MainLive hybrid auto/manual status — targeted checks (no network).
 */
const assert = require('assert');
const {
  isMainLiveAutoStatusEligible,
  resolveMainLiveAutoStatus,
} = require('../src/admin/services/mainLiveStatus');
const { MainLiveService } = require('../src/admin/services/mainLiveService');
const fs = require('fs');
const os = require('os');
const path = require('path');

function yangonKickoffIso(hour, minute = 0) {
  // Fixed calendar day in Asia/Yangon → ISO instant
  const { DateTime } = require('luxon');
  return DateTime.fromObject(
    { year: 2026, month: 10, day: 28, hour, minute },
    { zone: 'Asia/Yangon' }
  ).toISO();
}

// --- eligibility ---
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(22, 59)), false);
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(23, 0)), true);
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(23, 30)), true);

const kick2300 = yangonKickoffIso(23, 0);
const kickSec = Math.floor(new Date(kick2300).getTime() / 1000);

// --- locked keeps admin status ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'LIVE', statusLocked: true, kickoff: kick2300, streams: [] },
    { nowSec: kickSec + 60 }
  ),
  'LIVE',
  'manual lock must not be overwritten'
);

// --- before preparing window ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'Scheduled', statusLocked: false, kickoff: kick2300, streams: [] },
    { nowSec: kickSec - 2 * 60 * 60 }
  ),
  'Scheduled'
);

// --- preparing (no stream) ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'Scheduled', statusLocked: false, kickoff: kick2300, streams: [] },
    { nowSec: kickSec - 10 * 60 }
  ),
  'PREPARING_STREAM'
);

// --- kickoff reached, no stream → still PREPARING (never LIVE on clock alone) ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'PREPARING_STREAM', statusLocked: false, kickoff: kick2300, streams: [] },
    { nowSec: kickSec + 60 }
  ),
  'PREPARING_STREAM',
  'no LIVE without stream'
);

// --- kickoff + verified stream → LIVE ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    {
      status: 'PREPARING_STREAM',
      statusLocked: false,
      kickoff: kick2300,
      streams: [{ url: 'https://cdn.example/live.m3u8', active: true, validation: { ok: true } }],
      streamUrl: 'https://cdn.example/live.m3u8',
    },
    { nowSec: kickSec + 60 }
  ),
  'LIVE'
);

// --- daytime kickoff ignores auto even if unlocked ---
const kick2000 = yangonKickoffIso(20, 0);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'Scheduled', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: Math.floor(new Date(kick2000).getTime() / 1000) + 60 }
  ),
  'Scheduled'
);

// --- persist apply + unlock on MainLiveService ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-status-'));
const svc = new MainLiveService(tmp);
const created = svc.create({
  homeTeam: 'Home FC',
  awayTeam: 'Away FC',
  league: 'Test League',
  date: '2026-10-28',
  time: '23:30',
  status: 'Scheduled',
});
assert.strictEqual(created.statusLocked, false, 'late-night create starts unlocked');

const day = svc.create({
  homeTeam: 'Day Home',
  awayTeam: 'Day Away',
  league: 'Test League',
  date: '2026-10-28',
  time: '19:00',
  status: 'Scheduled',
});
assert.strictEqual(day.statusLocked, true, 'daytime create stays locked');

svc.update(created.matchId, { status: 'LIVE' });
assert.strictEqual(svc.get(created.matchId).statusLocked, true, 'manual status locks');

svc.update(created.matchId, { statusLocked: false, status: 'Scheduled' });
assert.strictEqual(svc.get(created.matchId).statusLocked, false, 'explicit unlock');
assert.strictEqual(svc.get(created.matchId).status, 'Scheduled');

const unlockedLate = svc.get(created.matchId);
const nowAfterKick = Math.floor(new Date(unlockedLate.kickoff).getTime() / 1000) + 120;
svc.update(created.matchId, {
  streams: [{ url: 'https://cdn.example/a.m3u8', name: 'HD' }],
  statusLocked: false,
});
const changed = svc.applyAutoStatuses({ nowSec: nowAfterKick });
assert.ok(changed >= 1, 'auto status should advance unlocked late match');
assert.strictEqual(svc.get(created.matchId).status, 'LIVE');

const dayBefore = svc.get(day.matchId).status;
svc.applyAutoStatuses({ nowSec: nowAfterKick });
assert.strictEqual(svc.get(day.matchId).status, dayBefore, 'locked daytime untouched');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('testMainLiveStatus: ok');
