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

assert.strictEqual(
  needsMainLiveExtract({
    matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
    status: 'Scheduled',
    streams: [],
  }),
  true
);
assert.strictEqual(
  needsMainLiveExtract({
    matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
    status: 'END',
    streams: [],
  }),
  false
);
assert.strictEqual(
  needsMainLiveExtract({
    matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
    status: 'LIVE',
    streams: [{ source: 'cakhia', url: 'https://cdn.example/a.m3u8' }],
  }),
  false
);
assert.strictEqual(
  needsMainLiveExtract(
    {
      matchUrl: 'https://cakhiazaa.tv/truc-tiep/foo',
      status: 'LIVE',
      streams: [{ source: 'cakhia', url: 'https://cdn.example/a.m3u8' }],
    },
    { force: true }
  ),
  true
);

console.log('testMainLiveExtract: ok');
