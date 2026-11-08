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

// --- any valid kickoff can use auto; there is no 23:00 cutoff ---
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(19, 0)), true);
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(22, 59)), true);
assert.strictEqual(isMainLiveAutoStatusEligible(yangonKickoffIso(23, 0)), true);
assert.strictEqual(isMainLiveAutoStatusEligible('not-a-kickoff'), false);

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

// --- kickoff reached with no stream stays Preparing ---
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'PREPARING_STREAM', statusLocked: false, kickoff: kick2300, streams: [] },
    { nowSec: kickSec + 60 }
  ),
  'PREPARING_STREAM',
  'Auto does not go Live without a stream URL'
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

// --- daytime kickoff follows the same clock when auto is on ---
const kick2000 = yangonKickoffIso(20, 0);
const kick2000Sec = Math.floor(new Date(kick2000).getTime() / 1000);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'Scheduled', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: kick2000Sec + 60 }
  ),
  'PREPARING_STREAM'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'PREPARING_STREAM', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: kick2000Sec - 5 * 60 }
  ),
  'PREPARING_STREAM',
  '5 minutes before kickoff stays Preparing until a stream URL exists'
);
const withStream = {
  status: 'PREPARING_STREAM',
  statusLocked: false,
  kickoff: kick2000,
  streams: [{ url: 'https://cdn.example/live.m3u8' }],
  streamUrl: 'https://cdn.example/live.m3u8',
};
assert.strictEqual(
  resolveMainLiveAutoStatus(withStream, { nowSec: kick2000Sec - 6 * 60 }),
  'PREPARING_STREAM',
  'a stream URL before the live window stays Preparing'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(withStream, { nowSec: kick2000Sec - 5 * 60 }),
  'LIVE',
  'Live starts 5 minutes before kickoff once a stream URL exists'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { ...withStream, status: 'LIVE' },
    { nowSec: kick2000Sec + 119 * 60 }
  ),
  'LIVE',
  'still Live just before 2 hours when a stream URL exists'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'PREPARING_STREAM', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: kick2000Sec + 29 * 60 }
  ),
  'PREPARING_STREAM',
  'no stream stays Preparing until 30 minutes after kickoff'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'PREPARING_STREAM', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: kick2000Sec + 30 * 60 }
  ),
  'END',
  'no stream becomes End 30 minutes after kickoff'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'LIVE', statusLocked: false, kickoff: kick2000, streams: [] },
    { nowSec: kick2000Sec + 120 * 60 }
  ),
  'END',
  'End 2 hours after kickoff'
);

// 2:00 AM kickoff → Live at 1:55 AM, End at 4:00 AM
const kick0200 = yangonKickoffIso(2, 0);
const kick0200Sec = Math.floor(new Date(kick0200).getTime() / 1000);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'Scheduled', statusLocked: false, kickoff: kick0200, streams: [] },
    { nowSec: kick0200Sec - 5 * 60 }
  ),
  'PREPARING_STREAM'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    {
      status: 'PREPARING_STREAM',
      statusLocked: false,
      kickoff: kick0200,
      streamUrl: 'https://cdn.example/am.m3u8',
    },
    { nowSec: kick0200Sec - 5 * 60 }
  ),
  'LIVE',
  '2:00 AM kickoff goes Live at 1:55 AM once a stream URL exists'
);
assert.strictEqual(
  resolveMainLiveAutoStatus(
    { status: 'LIVE', statusLocked: false, kickoff: kick0200, streams: [] },
    { nowSec: kick0200Sec + 2 * 60 * 60 }
  ),
  'END'
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
assert.strictEqual(created.statusLocked, true, 'create starts in manual mode');

const day = svc.create({
  homeTeam: 'Day Home',
  awayTeam: 'Day Away',
  league: 'Test League',
  date: '2026-10-28',
  time: '19:00',
  status: 'Scheduled',
});
assert.strictEqual(day.statusLocked, true, 'daytime create also starts in manual mode');

svc.update(created.matchId, { status: 'LIVE' });
assert.strictEqual(svc.get(created.matchId).statusLocked, true, 'manual status locks');

svc.update(created.matchId, { statusLocked: false, status: 'Scheduled' });
assert.strictEqual(svc.get(created.matchId).statusLocked, false, 'explicit unlock');
assert.strictEqual(svc.get(created.matchId).status, 'Scheduled');

const unlockedLate = svc.get(created.matchId);
const nowAfterKick = Math.floor(new Date(unlockedLate.kickoff).getTime() / 1000) + 120;
svc.update(day.matchId, { status: 'Scheduled' });
assert.strictEqual(svc.get(day.matchId).statusLocked, true, 'manual status locks daytime too');

svc.update(created.matchId, {
  streams: [{ url: 'https://cdn.example/a.m3u8', name: 'HD' }],
  statusLocked: false,
});
const changed = svc.applyAutoStatuses({ nowSec: nowAfterKick });
assert.ok(changed >= 1, 'auto status should advance unlocked late match');
assert.strictEqual(svc.get(created.matchId).status, 'LIVE');
const dayBefore = svc.get(day.matchId).status;
svc.applyAutoStatuses({ nowSec: nowAfterKick });
assert.strictEqual(svc.get(day.matchId).status, dayBefore, 'locked match stays on the admin status');

const ended = svc.create({
  homeTeam: 'End Home',
  awayTeam: 'End Away',
  league: 'Test League',
  date: '2026-10-28',
  time: '18:00',
  status: 'Scheduled',
});
const endAt = Math.floor(new Date(ended.kickoff).getTime() / 1000) + 2 * 60 * 60;
svc.update(ended.matchId, { statusLocked: false });
svc.applyAutoStatuses({ nowSec: endAt });
assert.strictEqual(svc.get(ended.matchId), null, 'End removes the match from MainLive');

const manualEnd = svc.create({
  homeTeam: 'Manual End',
  awayTeam: 'Manual Away',
  league: 'Test League',
  date: '2026-10-28',
  time: '21:00',
  status: 'LIVE',
});
assert.strictEqual(svc.update(manualEnd.matchId, { status: 'END' }), null);
assert.strictEqual(svc.get(manualEnd.matchId), null, 'setting End removes the match');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('testMainLiveStatus: ok');
