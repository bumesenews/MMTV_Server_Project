const { FotMobSource } = require('./fotmob');
const { LuongSonSource } = require('./luongson');
const { SocoliveSource } = require('./socolive');
const { XoilacSource } = require('./xoilac');
const { HighlightSource } = require('./highlight');
const { MyanmarTvSource } = require('./myanmartv');
const { GenericStreamingSource } = require('./genericStreamingSource');
const {
  PARSER_REGISTRY,
  resolveStreamingParser,
  buildEngineStreamingSources,
  listManageableSourceNames,
  priorityMapFromSourcesDoc,
} = require('./registry');

module.exports = {
  FotMobSource,
  LuongSonSource,
  SocoliveSource,
  XoilacSource,
  HighlightSource,
  MyanmarTvSource,
  GenericStreamingSource,
  PARSER_REGISTRY,
  resolveStreamingParser,
  buildEngineStreamingSources,
  listManageableSourceNames,
  priorityMapFromSourcesDoc,
};
