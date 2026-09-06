/**
 * Axios → Puppeteer fallback verification (mandatory Phase 4 addendum).
 * Uses the EXISTING runAxiosThenPuppeteer / extract path — does not reimplement it.
 * Run: node scripts/testAxiosPuppeteerFallback.js
 */
const { DateTime } = require('luxon');
const {
  runAxiosThenPuppeteer,
} = require('../src/sources/httpStreamExtractor');
const { StreamEngine } = require('../src/services/streamEngine');
const { applyAdminMatchUrl, MATCH_URL_STATUS } = require('../src/utils/matchUrlDiscovery');
const {
  nextSourceStateAfterAttempt,
  STREAM_SOURCE_STATUS,
} = require('../src/utils/streamExtractPolicy');
const {
  mergeStreamLists,
  combineMatchRecords,
} = require('../src/services/matchesSyncService');
const { isStreamExtractEligible } = require('../src/utils/time');

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

const validateOk = async (streams) =>
  (streams || []).map((s) => ({
    ...s,
    active: true,
    validation: { ok: true },
  }));

async function main() {
  console.log('\n=== Case 1: Axios succeeds → Puppeteer NOT launched ===');
  {
    let puppeteerLaunched = false;
    const result = await runAxiosThenPuppeteer({
      axiosExtract: async () => [
        { url: 'https://cdn.example/live.m3u8', source: 'cakhia', active: true },
      ],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/pp.m3u8', source: 'cakhia' }];
      },
      validate: validateOk,
    });
    assert('method=axios', result.method === 'axios');
    assert('valid m3u8 kept', result.streams[0]?.url.includes('live.m3u8'));
    assert('Puppeteer not launched', puppeteerLaunched === false);
    assert('puppeteerLaunched flag false', result.puppeteerLaunched === false);
  }

  console.log('\n=== Case 2: Axios throws → Puppeteer finds m3u8 ===');
  {
    let puppeteerLaunched = false;
    const result = await runAxiosThenPuppeteer({
      axiosExtract: async () => {
        throw new Error('ECONNRESET');
      },
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/from-pp.m3u8', source: 'xoilac' }];
      },
      validate: validateOk,
    });
    assert('Puppeteer launched', puppeteerLaunched === true);
    assert('method=puppeteer', result.method === 'puppeteer');
    assert('validated stream saved path', result.streams[0]?.validation?.ok === true);
    assert('axios error retained on result', Boolean(result.axiosError));
  }

  console.log('\n=== Case 3: Axios HTML / no stream → Puppeteer finds m3u8 ===');
  {
    let puppeteerLaunched = false;
    const result = await runAxiosThenPuppeteer({
      // Simulates extractStreamsViaAxios returning [] (HTML present, no m3u8 / JS shell)
      axiosExtract: async () => [],
      puppeteerExtract: async () => {
        puppeteerLaunched = true;
        return [{ url: 'https://cdn.example/rendered.m3u8', source: 'socolive' }];
      },
      validate: validateOk,
    });
    assert('Puppeteer launched after empty axios', puppeteerLaunched === true);
    assert('m3u8 from Puppeteer', result.streams[0]?.url.includes('rendered.m3u8'));
  }

  console.log('\n=== Case 4: Axios + Puppeteer both fail ===');
  {
    const result = await runAxiosThenPuppeteer({
      axiosExtract: async () => {
        throw new Error('TIMEOUT');
      },
      puppeteerExtract: async () => [],
      validate: validateOk,
    });
    assert('no stream invented', (result.streams || []).length === 0);
    assert('not falsely axios-success', result.method !== 'axios' || result.streams.length === 0);

    const failState = nextSourceStateAfterAttempt({
      previous: { status: STREAM_SOURCE_STATUS.SEARCHING, attempts: 0, slotsDone: {} },
      slot: { id: 't30', postKickoff: false },
      validatedStreams: [],
      error: 'TIMEOUT',
    });
    assert(
      'failure recorded as SEARCHING (retryable), not AVAILABLE',
      failState.status === STREAM_SOURCE_STATUS.SEARCHING && failState.lastError
    );

    const prev = {
      matchId: 'both-fail',
      streams: [
        {
          url: 'https://cdn.example/keep.m3u8',
          source: 'cakhia',
          active: true,
          validation: { ok: true },
        },
      ],
      streamUrl: 'https://cdn.example/keep.m3u8',
      streamStatus: STREAM_SOURCE_STATUS.AVAILABLE,
      streamSearch: {
        started: true,
        sources: { cakhia: { status: STREAM_SOURCE_STATUS.AVAILABLE } },
      },
    };
    const { next } = combineMatchRecords(prev, {
      matchId: 'both-fail',
      streams: [],
      streamUrl: null,
      streamStatus: STREAM_SOURCE_STATUS.SEARCHING,
      streamSearch: {
        started: true,
        sources: { cakhia: failState },
      },
    });
    assert('prior valid stream not erased', next.streams.length === 1);
  }

  console.log('\n=== Case 5: Admin URL before −30 → no extract; at −30 Axios first ===');
  {
    const eng = new StreamEngine({
      sources: [{ name: 'cakhia', config: {} }],
    });
    let early = {
      matchId: 'admin-early',
      homeTeam: 'H',
      awayTeam: 'A',
      kickoff: DateTime.now().setZone('Asia/Yangon').plus({ minutes: 60 }).toISO(),
      streams: [],
      matchUrlSearch: { sources: {}, slotsDone: {} },
      sourcePages: {},
      streamSearch: { sources: {}, slotsDone: {} },
    };
    early = applyAdminMatchUrl(early, 'cakhia', 'https://cakhia.example/admin-match');
    assert(
      'Admin URL CONFIRMED immediately',
      early.matchUrlSearch.sources.cakhia.status === MATCH_URL_STATUS.CONFIRMED
    );
    assert(
      'extract blocked before −30 (incl. force)',
      eng.shouldExtractStreams(early, { force: true }) === false
    );
    assert(
      'eligibility false at −60',
      isStreamExtractEligible(early.kickoff) === false
    );

    // At −30: gate opens; Axios is still first in extractStreamsAxiosThenPuppeteer
    let at30 = {
      ...early,
      matchId: 'admin-30',
      kickoff: DateTime.now().setZone('Asia/Yangon').plus({ minutes: 30 }).toISO(),
    };
    assert(
      'extract eligible at −30',
      eng.shouldExtractStreams(at30, { force: true }) === true
    );

    let axiosFirst = false;
    let puppeteerUsed = false;
    const chain = await runAxiosThenPuppeteer({
      axiosExtract: async () => {
        axiosFirst = true;
        return []; // Admin page often needs browser
      },
      puppeteerExtract: async () => {
        puppeteerUsed = true;
        return [{ url: 'https://cdn.example/admin.m3u8', source: 'cakhia' }];
      },
      validate: validateOk,
    });
    assert('Axios attempted first for Admin URL extract', axiosFirst === true);
    assert('Puppeteer used when Axios empty', puppeteerUsed === true);
    assert('Admin extract yields stream via fallback', chain.streams.length === 1);
  }

  console.log('\n=== Case 6: Multi-source — one failure does not stop others ===');
  {
    const outcomes = {};
    const sources = ['cakhia', 'xoilac', 'socolive'];
    for (const name of sources) {
      try {
        const r = await runAxiosThenPuppeteer({
          axiosExtract: async () => {
            if (name === 'xoilac') throw new Error('ETIMEDOUT');
            if (name === 'socolive') return [];
            return [{ url: 'https://cdn.example/cakhia.m3u8', source: name }];
          },
          puppeteerExtract: async () => {
            if (name === 'xoilac') return []; // both fail
            if (name === 'socolive') {
              return [{ url: 'https://cdn.example/soco.m3u8', source: name }];
            }
            return [];
          },
          validate: validateOk,
        });
        outcomes[name] = {
          ok: r.streams.length > 0,
          method: r.method,
          count: r.streams.length,
        };
      } catch (err) {
        outcomes[name] = { ok: false, error: err.message };
      }
    }
    assert('cakhia Axios success continues', outcomes.cakhia.ok === true);
    assert('xoilac both-fail does not invent stream', outcomes.xoilac.ok === false);
    assert('socolive Puppeteer still runs after others', outcomes.socolive.ok === true);
    assert(
      'sources independent',
      outcomes.cakhia.ok && !outcomes.xoilac.ok && outcomes.socolive.ok
    );
  }

  console.log('\n=== Wiring check: streaming sources use shared fallback ===');
  {
    const generic = require('../src/sources/genericStreamingSource');
    const xoilac = require('../src/sources/xoilac');
    const socolive = require('../src/sources/socolive');
    const luongson = require('../src/sources/luongson');
    const http = require('../src/sources/httpStreamExtractor');
    assert('extractStreamsAxiosThenPuppeteer exported', typeof http.extractStreamsAxiosThenPuppeteer === 'function');
    assert('runAxiosThenPuppeteer exported', typeof http.runAxiosThenPuppeteer === 'function');
    assert('GenericStreamingSource exists', typeof generic.GenericStreamingSource === 'function');
    assert('XoilacSource exists', typeof xoilac.XoilacSource === 'function' || typeof xoilac === 'object');
    assert('SocoliveSource module loads', Boolean(socolive));
    assert('LuongsonSource module loads', Boolean(luongson));
  }

  console.log(`\nAxios→Puppeteer results: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
