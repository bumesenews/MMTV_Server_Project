const {
  formatHighlightsDelivery,
  formatTipsDelivery,
  formatChannelsDelivery,
} = require('../../services/deliveryFormats');

const FEED_KEYS = new Set(['highlight1', 'highlight2', 'tips', 'myanmartv']);

const FEED_META = {
  highlight1: {
    label: 'Highlight 1 (Hoofoot)',
    githubFile: 'highlight1.json',
    defaultSource: 'https://hoofoot.com/',
  },
  highlight2: {
    label: 'Highlight 2 (Socolive)',
    githubFile: 'highlight2.json',
    defaultSource: 'https://socolivepp.tv/',
  },
  tips: {
    label: 'Tips (PredictZ)',
    githubFile: 'tips.json',
    defaultSource: 'https://www.predictz.com/',
  },
  myanmartv: {
    label: 'Myanmar TV',
    githubFile: 'myanmartv.json',
    defaultSource: 'https://www.myanmartvchannels.com/',
  },
};

function assertFeedKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!FEED_KEYS.has(normalized)) {
    throw new Error(
      `Unknown feed "${key}". Allowed: highlight1, highlight2, tips, myanmartv`
    );
  }
  return normalized;
}

/**
 * Normalize admin-uploaded JSON into the canonical delivery shape for each feed.
 */
function normalizeFeed(feedKey, raw) {
  const key = assertFeedKey(feedKey);
  if (raw == null || typeof raw !== 'object') {
    throw new Error('Payload must be a JSON object or array');
  }

  const now = new Date().toISOString();

  if (key === 'highlight1' || key === 'highlight2') {
    const highlights = Array.isArray(raw) ? raw : raw.highlights;
    if (!Array.isArray(highlights)) {
      throw new Error('Expected { highlights: [...] } or a highlights array');
    }
    const meta = FEED_META[key];
    return formatHighlightsDelivery(
      highlights.map((h) => ({ ...h, source: h.source || key })),
      {
        source: raw.source || meta.defaultSource,
        scraped_at: raw.scraped_at || now,
      }
    );
  }

  if (key === 'tips') {
    if (!raw.today && !raw.tomorrow) {
      throw new Error('Expected tips object with today and/or tomorrow sections');
    }
    return formatTipsDelivery({
      ...raw,
      scraped_at: raw.scraped_at || now,
      timezone: raw.timezone || 'Asia/Yangon',
    });
  }

  if (key === 'myanmartv') {
    const channels = Array.isArray(raw) ? raw : raw.channels;
    if (!Array.isArray(channels)) {
      throw new Error('Expected a channels array or plain JSON array');
    }
    return formatChannelsDelivery(channels);
  }

  throw new Error(`Unsupported feed: ${key}`);
}

function feedSummary(feedKey, data) {
  const key = assertFeedKey(feedKey);
  if (!data) return { feedKey: key, empty: true, count: 0 };

  if (key === 'highlight1' || key === 'highlight2') {
    return {
      feedKey: key,
      label: FEED_META[key].label,
      count: Number(data.count) || (data.highlights || []).length,
      scraped_at: data.scraped_at || null,
      empty: !(data.highlights || []).length,
    };
  }
  if (key === 'tips') {
    const today = data.today?.tips?.length || 0;
    const tomorrow = data.tomorrow?.tips?.length || 0;
    return {
      feedKey: key,
      label: FEED_META[key].label,
      count: Number(data.count) || today + tomorrow,
      scraped_at: data.scraped_at || null,
      empty: today + tomorrow === 0,
    };
  }
  if (key === 'myanmartv') {
    const count = Array.isArray(data) ? data.length : 0;
    return {
      feedKey: key,
      label: FEED_META[key].label,
      count,
      scraped_at: null,
      empty: count === 0,
    };
  }
  return { feedKey: key, count: 0, empty: true };
}

module.exports = {
  FEED_KEYS,
  FEED_META,
  assertFeedKey,
  normalizeFeed,
  feedSummary,
};
