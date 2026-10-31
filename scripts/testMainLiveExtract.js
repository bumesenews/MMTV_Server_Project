const assert = require('assert');
const {
  looksLikeM3u8,
  resolveSourceFromUrl,
  needsMainLiveExtract,
} = require('../src/admin/services/mainLiveExtractPolicy');
const { mapExtractedStream } = require('../src/admin/services/mainLiveExtract');
const { toPublicMatch } = require('../src/services/jsonGenerator');

function source(name, domains) {
  return { name, config: { name, domains } };
}

const sources = [
  source('cakhia', ['https://cakhiazaa.tv/']),
  source('xoilac', ['https://xoilacxtr.tv/']),
  source('socolive', ['https://socolivepp.tv/']),
];

assert.strictEqual(looksLikeM3u8('https://cdn.example/live/index.m3u8'), true);
assert.strictEqual(looksLikeM3u8('https://cakhiazaa.tv/truc-tiep/abc'), false);

assert.strictEqual(
  resolveSourceFromUrl(sources, 'https://cakhiazaa.tv/truc-tiep/foo', '').name,
  'cakhia'
);
assert.strictEqual(
  resolveSourceFromUrl(sources, 'https://other.example/match', 'xoilac').name,
  'xoilac'
);
assert.strictEqual(
  resolveSourceFromUrl(sources, 'https://unknown.example/match', '').name,
  'cakhia'
);

const kickoff = 1_700_000_000;
const page = {
  matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
  status: 'Scheduled',
  kickoff: new Date(kickoff * 1000).toISOString(),
  streams: [],
  matchUrlExtractAttempts: 0,
};

assert.strictEqual(
  needsMainLiveExtract(page, { nowSec: kickoff - 31 * 60 }),
  false,
  'no search before kickoff−30'
);
assert.strictEqual(
  needsMainLiveExtract(page, { nowSec: kickoff - 30 * 60 }),
  true,
  'first search at kickoff−30'
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      ...page,
      matchUrlExtractAttempts: 1,
      matchUrlExtractAt: new Date((kickoff - 30 * 60) * 1000).toISOString(),
    },
    { nowSec: kickoff - 16 * 60 }
  ),
  false,
  'second search waits 15 minutes'
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      ...page,
      matchUrlExtractAttempts: 1,
      matchUrlExtractAt: new Date((kickoff - 30 * 60) * 1000).toISOString(),
    },
    { nowSec: kickoff - 15 * 60 }
  ),
  true,
  'second search 15 minutes after the first'
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      ...page,
      matchUrlExtractAttempts: 2,
      matchUrlExtractAt: new Date((kickoff - 15 * 60) * 1000).toISOString(),
    },
    { nowSec: kickoff }
  ),
  false,
  'stop after the retry'
);
assert.strictEqual(
  needsMainLiveExtract({ ...page, status: 'END' }, { nowSec: kickoff - 30 * 60 }),
  false
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      ...page,
      status: 'LIVE',
      streams: [{ source: 'cakhia', url: 'https://cdn.example/a.m3u8' }],
    },
    { nowSec: kickoff - 10 * 60 }
  ),
  false
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      ...page,
      status: 'LIVE',
      streams: [{ source: 'cakhia', url: 'https://cdn.example/a.m3u8' }],
    },
    { force: true, nowSec: kickoff - 45 * 60 }
  ),
  false,
  'force still waits for kickoff−30'
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      matchUrl: 'https://cdn.example/live/index.m3u8',
      status: 'Scheduled',
      kickoff: page.kickoff,
      streams: [],
    },
    { nowSec: kickoff - 120 * 60 }
  ),
  true,
  'a pasted m3u8 is stored without waiting'
);

// --- MainLive headers include Cookie like matches.json ---
{
  const withBrowserCookie = mapExtractedStream(
    {
      url: 'https://cdn.example/live/index.m3u8',
      quality: 'HD',
      keepPlaybackHeaders: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 Browser',
        Referer: 'https://player.example/embed/',
        Origin: 'https://player.example',
        Cookie: 'session=abc; cf_clearance=xyz',
      },
    },
    {
      sourceName: 'cakhia',
      matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
      sourceConfig: {
        playbackHeaders: {
          'User-Agent': 'Mozilla/5.0 Source',
          Referer: 'https://cakhiazaa.tv/',
          Cookie: 'source=only',
        },
      },
    }
  );
  assert.strictEqual(
    withBrowserCookie.headers.Cookie,
    'session=abc; cf_clearance=xyz',
    'browser Cookie wins for MainLive'
  );
  assert.strictEqual(
    withBrowserCookie.streamHeaders.Cookie,
    'session=abc; cf_clearance=xyz',
    'streamHeaders mirrors headers Cookie'
  );

  const fillFromSource = mapExtractedStream(
    {
      url: 'https://cdn.example/live/index.m3u8',
      quality: 'HD',
      keepPlaybackHeaders: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 Browser',
        Referer: 'https://player.example/embed/',
      },
    },
    {
      sourceName: 'cakhia',
      matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
      sourceConfig: {
        playbackHeaders: {
          Cookie: 'source=fallback',
          Referer: 'https://cakhiazaa.tv/',
        },
      },
    }
  );
  assert.strictEqual(
    fillFromSource.headers.Cookie,
    'source=fallback',
    'source Cookie fills gap when browser Cookie is missing'
  );

  const published = toPublicMatch({
    matchId: 'test_cookie',
    homeTeam: 'A',
    awayTeam: 'B',
    league: 'L',
    status: 'LIVE',
    streams: [withBrowserCookie],
  });
  const pubStream = published.streams[0];
  assert.ok(pubStream.headers.Cookie, 'mainlive.json stream keeps Cookie');
  assert.ok(pubStream.streamHeaders.Cookie, 'mainlive.json streamHeaders keeps Cookie');
  assert.strictEqual(
    pubStream.headers.Cookie,
    'session=abc; cf_clearance=xyz',
    'published Cookie matches captured value'
  );
}

console.log('testMainLiveExtract: ok');
