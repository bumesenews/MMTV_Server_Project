const axios = require('axios');

async function main() {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const url = 'https://socolivekz.cc/sport/football/filter/today';

  const ax = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/json,*/*',
      Referer: 'https://socolivekz.cc/',
    },
    validateStatus: () => true,
    // force text to see raw
    transformResponse: [(d) => d],
  });
  const raw = String(ax.data);
  console.log('axios raw starts', raw.slice(0, 120).replace(/\s+/g, ' '));
  console.log('content-type', ax.headers['content-type']);

  try {
    const parsed = JSON.parse(raw);
    console.log('JSON success', parsed.success, 'htmls', parsed?.data?.htmls?.length);
    if (parsed?.data?.htmls?.[0]) {
      const sample = parsed.data.htmls[0].slice(0, 200);
      console.log('html0', sample.replace(/\s+/g, ' '));
      console.log('has match-football-item', parsed.data.htmls.join('').includes('match-football-item'));
    }
  } catch (e) {
    console.log('not json', e.message);
  }

  // native fetch like soco.js
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://socolivekz.cc/',
    },
  });
  const text = await res.text();
  console.log('\nfetch status', res.status, 'starts', text.trim().slice(0, 100).replace(/\s+/g, ' '));
  console.log('fetch content-type', res.headers.get('content-type'));
}

main().catch(console.error);
