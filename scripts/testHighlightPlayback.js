/**
 * Highlight playback check: every 2 days, drop videos that cannot play.
 * Run: node scripts/testHighlightPlayback.js
 */
const { VALIDATION_STATE } = require('../src/services/streamValidator');
const {
  INTERVAL_DAYS,
  isHighlightPlaybackDue,
  playbackDecision,
  checkHighlightPlayable,
} = require('../src/services/highlightPlayback');

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

const hour = 60 * 60 * 1000;
const now = Date.parse('2026-09-08T04:00:00.000Z');

console.log('\n=== due every two days ===');
assert('interval is 2 days', INTERVAL_DAYS === 2);
assert('never checked is due', isHighlightPlaybackDue(null, now, 2) === true);
assert('invalid stamp is due', isHighlightPlaybackDue('nope', now, 2) === true);
assert(
  '47 hours is not due',
  isHighlightPlaybackDue(new Date(now - 47 * hour).toISOString(), now, 2) === false
);
assert(
  '48 hours is due',
  isHighlightPlaybackDue(new Date(now - 48 * hour).toISOString(), now, 2) === true
);

console.log('\n=== keep or remove ===');
assert('playable playlist stays', playbackDecision({ state: VALIDATION_STATE.AVAILABLE, statusCode: 200 }) === 'keep');
assert('timeout stays', playbackDecision({ state: VALIDATION_STATE.TIMEOUT }) === 'keep');
assert('403 stays', playbackDecision({ state: VALIDATION_STATE.HTTP_403, statusCode: 403 }) === 'keep');
assert('401 stays', playbackDecision({ state: VALIDATION_STATE.HTTP_401, statusCode: 401 }) === 'keep');
assert('500 stays', playbackDecision({ state: VALIDATION_STATE.INVALID, statusCode: 500 }) === 'keep');
assert('429 stays', playbackDecision({ state: VALIDATION_STATE.INVALID, statusCode: 429 }) === 'keep');
assert('404 is removed', playbackDecision({ state: VALIDATION_STATE.HTTP_404, statusCode: 404 }) === 'remove');
assert('410 is removed', playbackDecision({ state: VALIDATION_STATE.HTTP_410, statusCode: 410 }) === 'remove');
assert('empty playlist is removed', playbackDecision({ state: VALIDATION_STATE.EMPTY_PLAYLIST }) === 'remove');
assert('no segments is removed', playbackDecision({ state: VALIDATION_STATE.NO_SEGMENTS }) === 'remove');
assert('not hls is removed', playbackDecision({ state: VALIDATION_STATE.NOT_HLS, statusCode: 200 }) === 'remove');
assert('http 451 is removed', playbackDecision({ state: VALIDATION_STATE.INVALID, statusCode: 451 }) === 'remove');

function httpResponding(statusByUrl) {
  return {
    async get(url) {
      const status = statusByUrl[url];
      if (status == null) {
        const err = new Error('timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { status, data: '' };
    },
  };
}

console.log('\n=== per video ===');
(async () => {
  const missing = await checkHighlightPlayable({ id: '1', title: 'No file', m3u8: null });
  assert('missing media is removed', missing.remove === true && missing.reason === 'no_media');

  const dead = await checkHighlightPlayable(
    { id: '2', m3u8: 'https://cdn.example/dead.m3u8' },
    {
      probeSegments: false,
      validator: {
        async validate() {
          return {
            validation: { state: VALIDATION_STATE.HTTP_404, statusCode: 404, reason: 'http_404' },
          };
        },
      },
    }
  );
  assert('404 playlist is removed', dead.remove === true);

  const blocked = await checkHighlightPlayable(
    { id: '3', m3u8: 'https://cdn.example/blocked.m3u8' },
    {
      probeSegments: false,
      validator: {
        async validate() {
          return {
            validation: { state: VALIDATION_STATE.HTTP_403, statusCode: 403, reason: 'HTTP_403' },
          };
        },
      },
    }
  );
  assert('403 playlist stays', blocked.remove === false);

  const playable = await checkHighlightPlayable(
    { id: '4', m3u8: 'https://cdn.example/ok.m3u8' },
    {
      probeSegments: false,
      validator: {
        async validate() {
          return { validation: { state: VALIDATION_STATE.AVAILABLE, statusCode: 200, reason: 'ok' } };
        },
      },
    }
  );
  assert('available playlist stays', playable.remove === false);

  const mp4ok = await checkHighlightPlayable(
    { id: '5', m3u8: 'https://cdn.example/clip.mp4' },
    { http: httpResponding({ 'https://cdn.example/clip.mp4': 206 }) }
  );
  assert('206 mp4 stays', mp4ok.remove === false);

  const mp4dead = await checkHighlightPlayable(
    { id: '6', m3u8: 'https://cdn.example/gone.mp4' },
    { http: httpResponding({ 'https://cdn.example/gone.mp4': 404 }) }
  );
  assert('404 mp4 is removed', mp4dead.remove === true);

  const mp4timeout = await checkHighlightPlayable(
    { id: '7', m3u8: 'https://cdn.example/slow.mp4' },
    { http: httpResponding({}) }
  );
  assert('timed-out mp4 stays', mp4timeout.remove === false);

  const segmentDead = await checkHighlightPlayable(
    { id: '8', m3u8: 'https://cdn.example/list.m3u8' },
    {
      validator: {
        async validate() {
          return {
            headers: {},
            validation: { state: VALIDATION_STATE.AVAILABLE, statusCode: 200, reason: 'ok' },
          };
        },
      },
      http: {
        async get(url) {
          if (url.endsWith('.m3u8')) {
            return {
              status: 200,
              data: '#EXTM3U\n#EXTINF:10,\nhttps://cdn.example/seg0.ts\n',
            };
          }
          return { status: 404, data: '' };
        },
      },
    }
  );
  assert('dead first segment is removed', segmentDead.remove === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
