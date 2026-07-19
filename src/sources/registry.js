const { LuongSonSource } = require('./luongson');
const { SocoliveSource } = require('./socolive');
const { XoilacSource } = require('./xoilac');
const { GenericStreamingSource } = require('./genericStreamingSource');

/**
 * Parser registry for Puppeteer streaming sources.
 *
 * To add a new website:
 * 1. Add an entry in config/sources.json (type: "streaming", enabled, domains, selectors…)
 * 2. Optionally register a custom parser class here if discovery/extraction differs
 * 3. Enable the source
 *
 * Sources without a custom parser use GenericStreamingSource (config-driven).
 * HTTP scrapers like `soco` stay outside this registry (handled by Pipeline).
 */
const PARSER_REGISTRY = {
  luongson: LuongSonSource,
  socolive: SocoliveSource,
  xoilac: XoilacSource,
  // Optional site-specific parsers (uncomment / add when needed):
  // cakhia: CakhiaSource,
  // '90phut': NinetyPhutSource,
  // yyzb: YyzbSource,
};

/** Sources collected via StreamEngine (Puppeteer multi-source merge). */
const ENGINE_STREAMING_TYPES = new Set(['streaming']);

/** Handled on separate pipeline paths (not StreamEngine). */
const NON_ENGINE_STREAMING = new Set(['soco']);

function resolveStreamingParser(config = {}) {
  const parserKey = String(config.parser || config.name || '').toLowerCase();
  return PARSER_REGISTRY[parserKey] || GenericStreamingSource;
}

function isEngineStreamingSource(config = {}) {
  if (!config || config.enabled === false) return false;
  if (!ENGINE_STREAMING_TYPES.has(config.type)) return false;
  if (NON_ENGINE_STREAMING.has(String(config.name || '').toLowerCase())) return false;
  const method = String(config.extractionMethod || 'puppeteer').toLowerCase();
  return method === 'puppeteer' || method === 'browser' || method === 'generic';
}

/**
 * Build enabled StreamEngine sources from sources.json, sorted by priority (desc).
 */
function buildEngineStreamingSources(sourcesDoc, { browserManager, normalizer, isEnabled } = {}) {
  const list = sourcesDoc?.sources || [];
  const enabled = list
    .filter((cfg) => isEngineStreamingSource(cfg))
    .filter((cfg) => (typeof isEnabled === 'function' ? isEnabled(cfg.name) : true))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  return enabled.map((config) => {
    const Cls = resolveStreamingParser(config);
    return new Cls({
      name: config.name,
      config,
      browserManager,
      normalizer,
    });
  });
}

function listManageableSourceNames(sourcesDoc) {
  const fromConfig = (sourcesDoc?.sources || [])
    .filter((s) => ['streaming', 'highlights', 'channels'].includes(s.type))
    .map((s) => s.name);
  const defaults = [
    'luongson',
    'socolive',
    'xoilac',
    'cakhia',
    '90phut',
    'yyzb',
    'soco',
    'highlight',
    'myanmartv',
  ];
  return [...new Set([...defaults, ...fromConfig])];
}

function priorityMapFromSourcesDoc(sourcesDoc, extras = { manual: 1000 }) {
  const map = { ...extras };
  for (const s of sourcesDoc?.sources || []) {
    if (s?.name == null) continue;
    if (s.priority != null) map[String(s.name).toLowerCase()] = Number(s.priority) || 0;
  }
  return map;
}

module.exports = {
  PARSER_REGISTRY,
  GenericStreamingSource,
  resolveStreamingParser,
  isEngineStreamingSource,
  buildEngineStreamingSources,
  listManageableSourceNames,
  priorityMapFromSourcesDoc,
};
