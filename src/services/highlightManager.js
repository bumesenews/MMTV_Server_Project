const { DateTime } = require('luxon');
const { logger, logEvent, events } = require('../utils/logger');
const { hashPayload } = require('../utils/compare');
const { formatHighlightsDelivery } = require('./deliveryFormats');

const TIMEZONE = 'Asia/Yangon';
const DEFAULT_RETENTION_DAYS = 7;

/**
 * Highlight retention / merge / dedupe / date normalization layer.
 * Does NOT scrape Hoofoot — works with HighlightSource output + existing JSON.
 */
class HighlightManager {
  constructor({ retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    this.retentionDays = Number(retentionDays) || DEFAULT_RETENTION_DAYS;
  }

  getAllowedDateSet(retentionDays = this.retentionDays) {
    const today = DateTime.now().setZone(TIMEZONE).startOf('day');
    // Keep N calendar days including today (e.g. 7 → today .. today-6)
    const days = Number(retentionDays) || DEFAULT_RETENTION_DAYS;
    const set = new Set();
    for (let i = 0; i < days; i += 1) {
      set.add(today.minus({ days: i }).toFormat('yyyy-MM-dd'));
    }
    return set;
  }

  /**
   * Convert Hoofoot relative dates (Today, Yesterday, N days ago, 1 week ago)
   * or absolute strings into yyyy-MM-dd (Asia/Yangon). Never store relative text.
   */
  normalizeDate(value, { now = null } = {}) {
    if (value == null || value === '') return null;
    const today = (now || DateTime.now().setZone(TIMEZONE)).startOf('day');
    const raw = String(value).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const dt = DateTime.fromFormat(raw, 'yyyy-MM-dd', { zone: TIMEZONE });
      return dt.isValid ? dt.toFormat('yyyy-MM-dd') : null;
    }

    const fromUrl = raw.match(/(\d{4})[_-](\d{2})[_-](\d{2})/);
    if (fromUrl) {
      return `${fromUrl[1]}-${fromUrl[2]}-${fromUrl[3]}`;
    }

    // Pull relative phrase out of longer card text when needed
    const relative =
      raw.match(
        /\b(today|yesterday|\d+\s+days?\s+ago|\d+\s+weeks?\s+ago|a\s+week\s+ago)\b/i
      )?.[0] || raw;

    const lower = String(relative).toLowerCase().replace(/\s+/g, ' ').trim();
    if (lower === 'today') return today.toFormat('yyyy-MM-dd');
    if (lower === 'yesterday') return today.minus({ days: 1 }).toFormat('yyyy-MM-dd');

    const daysAgo = lower.match(/^(\d+)\s+days?\s+ago$/);
    if (daysAgo) {
      return today.minus({ days: Number(daysAgo[1]) }).toFormat('yyyy-MM-dd');
    }

    const weekAgo = lower.match(/^(\d+)\s+weeks?\s+ago$/);
    if (weekAgo) {
      return today.minus({ weeks: Number(weekAgo[1]) }).toFormat('yyyy-MM-dd');
    }
    if (lower === 'a week ago' || lower === '1 week ago') {
      return today.minus({ weeks: 1 }).toFormat('yyyy-MM-dd');
    }

    const iso = DateTime.fromISO(raw, { zone: TIMEZONE });
    if (iso.isValid) return iso.toFormat('yyyy-MM-dd');

    return null;
  }

  parseTeamsFromTitle(title) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    if (!text) return { homeTeam: '', awayTeam: '', league: '' };

    // "League: Home v Away" or "Home v Away"
    let league = '';
    let matchPart = text;
    const leagueSplit = text.match(/^(.+?)\s*[:|–—-]\s*(.+)$/);
    if (leagueSplit && /\bv(?:s\.?)?\b/i.test(leagueSplit[2])) {
      league = leagueSplit[1].trim();
      matchPart = leagueSplit[2].trim();
    }

    const parts = matchPart.split(/\s+v(?:s\.?)?\s+/i);
    if (parts.length >= 2) {
      return {
        league,
        homeTeam: parts[0].trim(),
        awayTeam: parts.slice(1).join(' v ').trim(),
      };
    }
    return { league, homeTeam: text, awayTeam: '' };
  }

  dedupeKey(highlight) {
    const id = String(highlight?.id || '').trim();
    if (id) return `id:${id}`;

    const date =
      this.normalizeDate(highlight?.matchDate || highlight?.match_date) || '';
    const teams = this.parseTeamsFromTitle(highlight?.title || '');
    const league = String(highlight?.league || teams.league || '')
      .toLowerCase()
      .trim();
    const home = teams.homeTeam.toLowerCase();
    const away = teams.awayTeam.toLowerCase();
    return `meta:${league}|${home}|${away}|${date}`;
  }

  normalizeHighlight(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const matchDate = this.normalizeDate(
      raw.matchDate || raw.match_date || raw.url || ''
    );
    const title = String(raw.title || '').trim();
    const id = raw.id != null && String(raw.id).trim() !== '' ? String(raw.id) : null;

    return {
      id: id || raw.url || null,
      title,
      img: raw.img || null,
      url: raw.url || null,
      matchDate,
      embedUrl: raw.embedUrl || raw.embed_url || null,
      m3u8: raw.m3u8 || null,
      headers: raw.headers || null,
      source: raw.source || 'highlight',
      league: raw.league || this.parseTeamsFromTitle(title).league || null,
    };
  }

  /**
   * Merge scraped highlights with existing store.
   * - Prefer scraped fields when updating an existing key (newer m3u8/embed)
   * - Drop items older than retention window
   * - Deduplicate by id or league/home/away/date
   */
  merge({ existing = [], scraped = [], retentionDays = this.retentionDays } = {}) {
    const allowed = this.getAllowedDateSet(retentionDays);
    const existingList = (existing || []).map((h) => this.normalizeHighlight(h)).filter(Boolean);
    const scrapedList = (scraped || []).map((h) => this.normalizeHighlight(h)).filter(Boolean);

    const beforeKeys = new Set(existingList.map((h) => this.dedupeKey(h)));
    const map = new Map();

    let duplicatesRemoved = 0;
    let oldRemoved = 0;

    const upsert = (item, { fromScraped = false } = {}) => {
      if (!item) return;
      if (!item.matchDate || !allowed.has(item.matchDate)) {
        oldRemoved += 1;
        return;
      }
      const key = this.dedupeKey(item);
      if (map.has(key)) {
        duplicatesRemoved += 1;
        const prev = map.get(key);
        // Prefer richer scraped data; keep previous m3u8 if new scrape missed it
        map.set(key, {
          ...prev,
          ...item,
          m3u8: item.m3u8 || prev.m3u8 || null,
          embedUrl: item.embedUrl || prev.embedUrl || null,
          headers: item.headers || prev.headers || null,
          img: item.img || prev.img || null,
          title: item.title || prev.title,
          fromScraped: fromScraped || prev.fromScraped,
        });
        return;
      }
      map.set(key, { ...item, fromScraped });
    };

    // Existing first, then scraped overwrites/extends
    for (const h of existingList) upsert(h, { fromScraped: false });
    for (const h of scrapedList) upsert(h, { fromScraped: true });

    for (const item of map.values()) {
      delete item.fromScraped;
    }

    const merged = [...map.values()].sort((a, b) => {
      const da = a.matchDate || '';
      const db = b.matchDate || '';
      if (da !== db) return db.localeCompare(da);
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

    const existingKept = existingList.filter((h) => h.matchDate && allowed.has(h.matchDate)).length;
    oldRemoved = Math.max(0, existingList.length - existingKept);
    const totalIn = existingList.length + scrapedList.length;
    duplicatesRemoved = Math.max(0, totalIn - oldRemoved - merged.length);

    const stats = {
      scrapedCount: scrapedList.length,
      existingCount: existingList.length,
      totalAfterMerge: merged.length,
      newAdded: merged.filter((h) => !beforeKeys.has(this.dedupeKey(h))).length,
      duplicatesRemoved,
      oldRemoved,
    };

    logger.info('Highlight merge completed', stats);
    return { highlights: merged, stats };
  }

  /**
   * Compare highlight payloads ignoring scraped_at / volatile fields.
   */
  hasChanged(previousDelivery, nextDelivery) {
    const prev = sanitizeHighlightPayload(previousDelivery);
    const next = sanitizeHighlightPayload(nextDelivery);
    if (!prev) return true;
    return hashPayload(prev) !== hashPayload(next);
  }

  buildDelivery(highlights, meta = {}) {
    return formatHighlightsDelivery(highlights, {
      source: meta.source || 'https://hoofoot.com/',
      scraped_at: meta.scraped_at || new Date().toISOString(),
    });
  }

  /**
   * Load highlights array from delivery JSON or current.json extras.
   */
  extractList(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (Array.isArray(source.highlights)) return source.highlights;
    return [];
  }

  logLifecycle(event, message, meta = {}) {
    logEvent(event, message, { feed: 'highlight', ...meta });
  }
}

function sanitizeHighlightPayload(payload) {
  if (!payload) return null;
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.scraped_at;
  delete clone.generatedAt;
  if (Array.isArray(clone.highlights)) {
    clone.highlights = clone.highlights.map((h) => {
      if (!h || typeof h !== 'object') return h;
      const copy = { ...h };
      // Normalize field names for stable compare
      return {
        id: copy.id ?? null,
        title: copy.title || '',
        img: copy.img || null,
        url: copy.url || null,
        match_date: copy.match_date || copy.matchDate || null,
        embed_url: copy.embed_url || copy.embedUrl || null,
        m3u8: copy.m3u8 || null,
        source: copy.source || 'highlight',
      };
    });
  }
  clone.count = Array.isArray(clone.highlights) ? clone.highlights.length : 0;
  return clone;
}

module.exports = {
  HighlightManager,
  DEFAULT_RETENTION_DAYS,
  TIMEZONE,
};
