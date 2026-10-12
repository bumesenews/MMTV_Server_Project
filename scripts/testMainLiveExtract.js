const assert = require('assert');
const {
  looksLikeM3u8,
  resolveSourceFromUrl,
  needsMainLiveExtract,
} = require('../src/admin/services/mainLiveExtractPolicy');

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

console.log('testMainLiveExtract: ok');
