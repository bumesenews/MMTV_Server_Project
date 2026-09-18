/**
 * Stream URL AES-256-GCM (ENC:v1:) — GitHub matches.json and mainlive.json.
 * Run: node scripts/testStreamUrlCrypto.js
 */
const {
  PREFIX,
  parseStreamUrlKey,
  encryptStreamUrl,
  decryptStreamUrl,
  encryptPublicMatchesPayload,
  decryptMatchesList,
  isEncryptedStreamUrl,
} = require('../src/utils/streamUrlCrypto');
const { generateFlutterJson, toPublicMatch } = require('../src/services/jsonGenerator');
const { formatMatchesDelivery, formatMainLiveDelivery } = require('../src/services/deliveryFormats');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const KEY = parseStreamUrlKey('0'.repeat(64));
const M3U8 = 'https://cdn.example/live/abc/index.m3u8?token=a+b/c==';

console.log('\n=== stream URL crypto ===');

const enc = encryptStreamUrl(M3U8, KEY);
check('prefix ENC:v1:', typeof enc === 'string' && enc.startsWith(PREFIX));
check('round-trip exact', decryptStreamUrl(enc, KEY) === M3U8);
check('deterministic', encryptStreamUrl(M3U8, KEY) === enc);
check('plain passthrough', decryptStreamUrl(M3U8, KEY) === M3U8);
check('empty string unchanged', encryptStreamUrl('', KEY) === '');
check('null unchanged', encryptStreamUrl(null, KEY) === null);
check('undefined unchanged', encryptStreamUrl(undefined, KEY) === undefined);
check('no key leaves plaintext', encryptStreamUrl(M3U8, null) === M3U8);
check('invalid payload empty', decryptStreamUrl(`${PREFIX}%%%not-base64%%%`, KEY) === '');
check(
  'wrong key empty',
  decryptStreamUrl(enc, parseStreamUrlKey('1'.repeat(64))) === ''
);

const hd = 'https://cdn.example/hd.m3u8';
const fhd = 'https://cdn.example/fhd.m3u8';
const payload = {
  version: 1,
  generatedAt: '2026-09-11T00:00:00.000+06:30',
  timezone: 'Asia/Yangon',
  matches: [
    {
      matchId: 'a_b_20260911',
      homeTeam: 'Team A',
      awayTeam: 'Team B',
      league: 'Serie A',
      date: '11/9',
      time: '7:00 PM',
      kickoff: '2026-09-11T19:00:00.000+06:30',
      status: 'LIVE',
      h2h: { matches: [{ score: '1-0' }] },
      matchUrl: 'https://secret.example/page',
      streams: [
        { name: 'HD', url: hd },
        { name: 'Full HD', url: fhd },
        { name: 'Empty', url: '' },
        { name: 'Missing' },
      ],
      streamUrl: hd,
    },
    {
      matchId: 'c_d_20260911',
      homeTeam: 'Team C',
      awayTeam: 'Team D',
      league: 'Serie A',
      status: 'Scheduled',
      streams: [],
    },
  ],
};

const encrypted = encryptPublicMatchesPayload(payload, KEY);
const m0 = encrypted.matches[0];
const m1 = encrypted.matches[1];
check('matchId unchanged', m0.matchId === 'a_b_20260911');
check('home unchanged', m0.homeTeam === 'Team A');
check('away unchanged', m0.awayTeam === 'Team B');
check('league unchanged', m0.league === 'Serie A');
check('h2h unchanged', m0.h2h.matches[0].score === '1-0');
check('matchUrl unchanged', m0.matchUrl === 'https://secret.example/page');
check('status unchanged', m0.status === 'LIVE');
check('stream names unchanged', m0.streams[0].name === 'HD' && m0.streams[1].name === 'Full HD');
check('order preserved', m0.streams[0].name === 'HD' && m0.streams[1].name === 'Full HD');
check('hd encrypted', isEncryptedStreamUrl(m0.streams[0].url) && m0.streams[0].url !== hd);
check('fhd encrypted', isEncryptedStreamUrl(m0.streams[1].url) && m0.streams[1].url !== fhd);
check('empty stream url not invented', m0.streams[2].url === '');
check('missing url field stays missing', m0.streams[3].url === undefined);
check('top-level streamUrl encrypted', isEncryptedStreamUrl(m0.streamUrl));
check('second match untouched streams', Array.isArray(m1.streams) && m1.streams.length === 0);

const decrypted = decryptMatchesList(encrypted.matches, KEY);
check('decrypt hd exact', decrypted[0].streams[0].url === hd);
check('decrypt fhd exact', decrypted[0].streams[1].url === fhd);
check('decrypt streamUrl exact', decrypted[0].streamUrl === hd);

const originalKey = process.env.STREAM_URL_ENCRYPTION_KEY;
process.env.STREAM_URL_ENCRYPTION_KEY = '0'.repeat(64);
try {
  const fixture = {
    matchId: 'cagliari_lecce_20990101',
    homeTeam: 'Cagliari',
    awayTeam: 'Lecce',
    league: 'Serie A',
    kickoff: '2099-01-01T23:00:00.000+06:30',
    date: '1/1',
    time: '11:00 PM',
    status: 'LIVE',
    streams: [{ name: 'HD ROY', url: M3U8, active: true }],
    streamUrl: M3U8,
    matchUrl: 'https://cakhia.example/page',
  };
  const generated = generateFlutterJson([fixture]);
  check(
    'internal generateFlutterJson still plaintext',
    generated.matches[0].streams[0].url === M3U8 && generated.matches[0].streamUrl === M3U8
  );
  const pub = toPublicMatch(generated.matches[0]);
  check('toPublicMatch still plaintext (admin/internal)', pub.streams[0].url === M3U8);
  const delivery = formatMatchesDelivery(generated);
  check('delivery encrypts streams[].url', isEncryptedStreamUrl(delivery.matches[0].streams[0].url));
  check('delivery encrypts streamUrl', isEncryptedStreamUrl(delivery.matches[0].streamUrl));
  check('delivery does not encrypt matchId', delivery.matches[0].matchId === fixture.matchId);
  check('delivery has no matchUrl', !('matchUrl' in delivery.matches[0]));
  const back = decryptStreamUrl(delivery.matches[0].streams[0].url, KEY);
  check('delivery decrypt exact m3u8', back === M3U8);

  const mainlive = formatMainLiveDelivery({
    matches: [
      {
        matchId: 'ml_1',
        homeTeam: 'A',
        awayTeam: 'B',
        league: 'Cup',
        status: 'LIVE',
        streams: [{ name: 'HD', url: M3U8, type: 'm3u8', active: true }],
        streamUrl: M3U8,
      },
    ],
  });
  check(
    'mainlive.json encrypts admin stream url',
    isEncryptedStreamUrl(mainlive.matches[0].streams[0].url) &&
      isEncryptedStreamUrl(mainlive.matches[0].streamUrl)
  );
  check(
    'mainlive decrypt exact m3u8',
    decryptStreamUrl(mainlive.matches[0].streams[0].url, KEY) === M3U8
  );
} finally {
  if (originalKey === undefined) delete process.env.STREAM_URL_ENCRYPTION_KEY;
  else process.env.STREAM_URL_ENCRYPTION_KEY = originalKey;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
