const path = require('path');
const { AdminUserService } = require('./adminUserService');
const { AdminLogService } = require('./adminLogService');
const { OverrideService } = require('./overrideService');
const { LeagueAdminService } = require('./leagueAdminService');
const { ManualMatchService } = require('./manualMatchService');
const { TeamAdminService } = require('./teamAdminService');
const { SourceAdminService } = require('./sourceAdminService');
const { ConfigAdminService } = require('./configAdminService');
const { NotificationService } = require('./notificationService');
const { PublishService } = require('./publishService');
const { DashboardService } = require('./dashboardService');

function createAdminContext({ pipeline, cache, github, env = process.env }) {
  const dataDir = path.resolve(process.cwd(), 'data/admin');
  const logService = new AdminLogService(dataDir);
  const users = new AdminUserService(dataDir, env);
  const overrides = new OverrideService(dataDir);
  const leagues = new LeagueAdminService(dataDir);
  const manualMatches = new ManualMatchService(dataDir);
  const teams = new TeamAdminService(dataDir, env);
  const sources = new SourceAdminService(dataDir);
  const config = new ConfigAdminService(env);
  const notifications = new NotificationService({ dataDir, env, logService });
  const publish = new PublishService({
    cache,
    github,
    overrideService: overrides,
    leagueAdminService: leagues,
    manualMatchService: manualMatches,
    teamAdminService: teams,
    logService,
  });
  const dashboard = new DashboardService({
    pipeline,
    cache,
    overrideService: overrides,
    sourceAdminService: sources,
    leagueAdminService: leagues,
    publishService: publish,
  });

  return {
    dataDir,
    users,
    logService,
    overrides,
    leagues,
    manualMatches,
    teams,
    sources,
    config,
    notifications,
    publish,
    dashboard,
    pipeline,
    cache,
    github,
    env,
  };
}

module.exports = { createAdminContext };
