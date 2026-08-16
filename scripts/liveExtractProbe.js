/**
 * Live Match URL / Stream URL probe (no GitHub upload).
 * Usage: node scripts/liveExtractProbe.js [matchId]
 */
require('dotenv').config();

process.env.LOW_MEMORY_MODE = process.env.LOW_MEMORY_MODE || 'false';
process.env.PUPPETEER_CONCURRENCY = '1';

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { extractStreamsViaAxios, findStreamPatterns, parseListStreamGroups, extractIframeSrcs, axiosGetHtml } = require('../src/sources/httpStreamExtractor');
const { PuppeteerManager, resolveChromePath } = require('../src/browser/puppeteerManager');
const { extractStreamsAxiosThenPuppeteer } = require('../src/sources/httpStreamExtractor');
const { StreamValidator } = require('../src/services/streamValidator');
const sources = require('../config/sources.json').sources;
const sourceConfigs = Object.fromEntries(sources.filter((s) => s.name).map((s) => [s.name, s]));

const ZONE = 'Asia/Yangon';
const MATCHES = path.join(__dirname, '..', 'data', 'delivery', 'matches.json');

function summarize(matches) {
  const now = DateTime.now().setZone(ZONE);
  console.log(`\nNow ${now.toISO()} (${ZONE})\n`);
  console.log(
    [
      'matchId'.padEnd(36),
      'status'.padEnd(8),
      'kickoff'.padEnd(8),
      'mins'.padStart(6),
      'matchUrl'.padEnd(22),
      'stream'.padEnd(12),
      'streamUrl',
    ].join(' ')
  );
  for (const m of matches) {
    const ko = DateTime.fromISO(m.kickoff, { setZone: true });
    const mins = Math.round(ko.diff(now, 'minutes').minutes);
    const sources = Object.entries(m.matchUrlSearch?.sources || {})
      .filter(([, s]) => s.matchUrl)
      .map(([n]) => n)
      .join(',') || (m.matchUrl ? m.matchUrlSource || 'yes' : 'none');
    console.log(
      [
        String(m.matchId || '').padEnd(36),
        String(m.status || '').padEnd(8),
        String(m.time || '').padEnd(8),
        String(mins).padStart(6),
        String(sources).padEnd(22),
        String(m.streamStatus || '').padEnd(12),
        m.streamUrl ? 'YES' : 'no',
      ].join(' ')
    );
  }
}

function pickTarget(matches, wantedId) {
  if (wantedId) {
    const hit = matches.find((m) => m.matchId === wantedId);
    if (!hit) throw new Error(`match not found: ${wantedId}`);
    return hit;
  }
  const now = DateTime.now().setZone(ZONE);
  const withUrl = matches.filter((m) => m.matchUrl || Object.values(m.sourcePages || {}).some(Boolean));
  const liveish = withUrl
    .map((m) => ({
      m,
      mins: DateTime.fromISO(m.kickoff, { setZone: true }).diff(now, 'minutes').minutes,
    }))
    .sort((a, b) => Math.abs(a.mins + 5) - Math.abs(b.mins + 5));
  return (liveish[0] || { m: withUrl[0] }).m;
}

function sourcePages(match) {
  const pages = { ...(match.sourcePages || {}) };
  if (match.matchUrl && match.matchUrlSource) pages[match.matchUrlSource] = match.matchUrl;
  const search = match.matchUrlSearch?.sources || {};
  for (const [name, st] of Object.entries(search)) {
    if (st?.matchUrl) pages[name] = st.matchUrl;
  }
  return pages;
}

async function probeAxios(sourceName, url) {
  const started = Date.now();
  try {
    const html = await axiosGetHtml(url, { referer: url });
    const groups = parseListStreamGroups(html);
    const iframes = extractIframeSrcs(html, url);
    const patterns = findStreamPatterns(html, url);
    const streams = await extractStreamsViaAxios({
      matchPageUrl: url,
      sourceName,
      config: { name: sourceName, priority: 1 },
    });
    return {
      ok: true,
      ms: Date.now() - started,
      htmlBytes: html.length,
      listStream: groups.length,
      iframes: iframes.slice(0, 5),
      patternCount: patterns.length,
      streamCount: streams.length,
      urls: streams.map((s) => s.url),
      title: (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '',
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.message };
  }
}

async function probePuppeteer(sourceName, url) {
  const chrome = resolveChromePath();
  if (!chrome) {
    return { ok: false, error: 'no Chrome executable on this machine' };
  }
  const browser = new PuppeteerManager({
    lowMemory: false,
    executablePath: chrome,
    timeout: 28000,
    maxConcurrentPages: 1,
  });
  try {
    await browser.launch();
    const streams = await extractStreamsAxiosThenPuppeteer({
      matchPageUrl: url,
      sourceName,
      config: { name: sourceName, priority: 1 },
      browser,
      validateStreams: async (raw) => raw,
    });
    return {
      ok: true,
      chrome,
      streamCount: streams.length,
      urls: streams.map((s) => s.url),
      method: streams[0]?.extractionMethod || streams[0]?.via || null,
    };
  } catch (err) {
    return { ok: false, chrome, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(MATCHES, 'utf8'));
  const matches = doc.matches || [];
  summarize(matches);

  const target = pickTarget(matches, process.argv[2]);
  const pages = sourcePages(target);
  console.log(`\n=== Probe ${target.matchId} ${target.homeTeam} vs ${target.awayTeam} ===`);
  console.log(JSON.stringify({
    status: target.status,
    kickoff: target.kickoff,
    matchUrl: target.matchUrl,
    streamStatus: target.streamStatus,
    streamUrl: target.streamUrl,
    validationStatus: target.validationStatus,
    validationReason: target.validationReason,
    pages,
  }, null, 2));

  const axiosResults = {};
  for (const [name, url] of Object.entries(pages)) {
    if (!url) continue;
    console.log(`\n--- axios ${name} ---`);
    const result = await probeAxios(name, url);
    axiosResults[name] = result;
    console.log(JSON.stringify(result, null, 2));
  }

  const axiosHit = Object.values(axiosResults).find((r) => r.streamCount > 0);
  if (axiosHit) {
    const sourceName = Object.keys(axiosResults).find((k) => axiosResults[k] === axiosHit);
    const validator = new StreamValidator({ sourceConfigs });
    const candidates = axiosHit.urls.map((url) => ({
      url,
      source: sourceName,
      matchPageUrl: pages[sourceName] || target.matchUrl,
    }));
    const checked = await validator.validateMany(candidates, {
      sourceConfig: sourceConfigs[sourceName] || {},
    });
    const ok = checked.find((s) => s.validation?.ok);
    console.log('\n=== HLS validate axios URLs ===');
    console.log(JSON.stringify(checked.map((s) => ({
      url: s.url,
      ok: s.validation?.ok,
      state: s.validation?.state,
      referer: s.headers?.Referer || s.streamHeaders?.Referer,
    })), null, 2));
    if (ok) {
      console.log('\nPLAYABLE', ok.url);
    }
    return;
  }

  const firstPage = Object.entries(pages).find(([, u]) => u);
  if (!firstPage) {
    console.log('\nNo Match URL to extract.');
    return;
  }
  console.log(`\n--- puppeteer ${firstPage[0]} (axios empty) ---`);
  const p = await probePuppeteer(firstPage[0], firstPage[1]);
  console.log(JSON.stringify(p, null, 2));
}

main().catch((err) => {
  console.error('probe failed', err);
  process.exit(1);
});
