const { FotMobSource } = require('../sources/fotmob');
const { logger } = require('../utils/logger');
const { MatchMerger } = require('./matchMerger');

class FixtureService {
  constructor({ config, normalizer }) {
    this.normalizer = normalizer;
    this.fotmob = new FotMobSource({
      config: config,
      normalizer,
    });
    this.merger = new MatchMerger();
  }

  async collect() {
    const fixtures = await this.fotmob.collectFixtures();
    const merged = this.merger.mergeFixtures(fixtures);

    logger.info('Fixtures ready after filter/normalize', {
      count: merged.length,
      leagues: [...new Set(merged.map((m) => m.league))],
    });

    return merged.sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  }
}

module.exports = { FixtureService };
