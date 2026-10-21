const axios = require('axios');
const { DateTime } = require('luxon');
const { ZONE, nowYangon } = require('../../utils/time');

const SOURCE_PAGE = 'https://socolivezu.tv/kqbd/';
const API_ROOT = 'https://fb-api.apiscoreflow.com/football/match/recent/';

const STATUS_LABEL = {
  2: '1H',
  3: 'HT',
  4: '2H',
  5: 'ET',
  6: 'ET',
  7: 'Pen',
  8: 'FT',
};

function splitRows(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split('!!')
    .filter(Boolean)
    .map((row) => row.split('^'));
}

function parseResultsPayload(data) {
  const competitions = new Map();
  for (const row of splitRows(data?.competitions)) {
    if (row[0]) competitions.set(row[0], row[1] || row[2] || '');
  }

  const results = [];
  for (const row of splitRows(data?.matches)) {
    const statusId = Number(row[5]);
    const status = STATUS_LABEL[statusId];
    if (!status) continue;
    const homeTeam = String(row[7] || '').trim();
    const awayTeam = String(row[17] || '').trim();
    const homeScore = Number(row[8]);
    const awayScore = Number(row[18]);
    const kickoffSec = Number(row[1]);
    if (!homeTeam || !awayTeam) continue;
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    if (!Number.isFinite(kickoffSec)) continue;
    const kickoff = DateTime.fromSeconds(kickoffSec, { zone: 'utc' });
    if (!kickoff.isValid) continue;
    results.push({
      id: row[0],
      competition: competitions.get(row[3]) || '',
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      status,
      kickoff: kickoff.toISO(),
      date: kickoff.setZone(ZONE).toISODate(),
    });
  }

  results.sort((a, b) => String(b.kickoff).localeCompare(String(a.kickoff)));
  return results;
}

function resultDates(now = null) {
  const today = (now && DateTime.isDateTime(now) ? now.setZone(ZONE) : nowYangon()).startOf('day');
  return [today.toISODate(), today.minus({ days: 1 }).toISODate()];
}

async function fetchRecentResults(date, env = process.env) {
  const response = await axios.get(`${API_ROOT}${date}`, {
    timeout: Number(env.RESULTS_HTTP_TIMEOUT_MS || 20000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: SOURCE_PAGE,
    },
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.data || response.data.code !== 0) {
    throw new Error(response.data?.message || 'results_api_error');
  }
  return parseResultsPayload(response.data.data);
}

function buildResultsDelivery(results, { generatedAt, source = SOURCE_PAGE } = {}) {
  const list = results || [];
  return {
    source,
    timezone: ZONE,
    generatedAt: generatedAt || nowYangon().toISO(),
    count: list.length,
    results: list,
  };
}

module.exports = {
  SOURCE_PAGE,
  API_ROOT,
  STATUS_LABEL,
  parseResultsPayload,
  resultDates,
  fetchRecentResults,
  buildResultsDelivery,
};
