// Missions that belong to a campaign (build.md Phase 3). commands/mission.js
// calls these at start and on every save; a mission with no campaign_id never
// reaches the store, so plain missions run exactly as before.

'use strict';

const { decide } = require('./campaign-core');
const { getCampaign, openCampaignStore } = require('./campaign-store');
const { readRosterRuns } = require('./roster-runs');

const DEFAULT_RESERVE_USD = 5;
const CLOSED_STATES = new Set(['done', 'out_of_budget', 'paused']);

function storeFor(root, deps = {}) {
  return deps.store || openCampaignStore(root);
}

function warn(message) {
  process.stderr.write(`campaign: ${message}\n`);
}

// How much a new mission holds back: what missions in this campaign have cost
// on average, or $5 before any has ended. --reserve overrides.
function defaultReserve(view) {
  const ended = view.missions.filter((m) => m.status === 'ended' && typeof m.cost_usd === 'number');
  if (!ended.length) return DEFAULT_RESERVE_USD;
  const average = ended.reduce((sum, m) => sum + m.cost_usd, 0) / ended.length;
  return Math.max(0.01, Math.ceil(average * 100) / 100);
}

// Checked before a mission creates anything, so a refusal leaves nothing behind.
function checkCampaignStart(root, campaignId, options = {}, deps = {}) {
  const store = storeFor(root, deps);
  const view = getCampaign(store, campaignId);
  if (!view) return { ok: false, error: `no campaign ${campaignId}. See them with: atris campaign` };
  if (view.error) return { ok: false, error: `campaign ${campaignId} cannot be read: ${view.error}` };
  if (CLOSED_STATES.has(view.state)) {
    return { ok: false, error: `campaign ${campaignId} is ${view.state.replace(/_/g, ' ')}, so it takes no new missions` };
  }
  if (options.missionId) {
    const owner = store.campaignForMission(options.missionId);
    if (owner && owner !== campaignId) return { ok: false, error: `mission ${options.missionId} already belongs to campaign ${owner}` };
  }
  const reserve = options.reserveUsd !== undefined && options.reserveUsd !== null && options.reserveUsd !== ''
    ? Number(options.reserveUsd)
    : defaultReserve(view);
  if (!(reserve >= 0) || !Number.isFinite(reserve)) return { ok: false, error: '--reserve takes dollars, for example --reserve 5' };
  if (reserve > view.budget.available) {
    return {
      ok: false,
      error: `campaign ${campaignId} has $${view.budget.available.toFixed(2)} left and this mission would hold $${reserve.toFixed(2)}. Add money with: atris campaign budget ${campaignId} --add <dollars>`,
    };
  }
  return { ok: true, campaign: view, reserve };
}

function memberOf(mission) {
  return mission.owner || mission.executed_by || 'mission-lead';
}

// After the mission is saved: it starts in the campaign and holds its reserve.
function recordCampaignMissionStarted(root, mission, reserve, deps = {}) {
  if (!mission || !mission.campaign_id) return null;
  try {
    const store = storeFor(root, deps);
    const actor = memberOf(mission);
    store.append({
      campaign_id: mission.campaign_id, type: 'mission_started', actor,
      data: { mission_id: mission.id, member: actor, objective: String(mission.objective || '').slice(0, 200) },
    });
    if (reserve > 0) {
      store.append({ campaign_id: mission.campaign_id, type: 'budget_reserved', actor, data: { mission_id: mission.id, amount_usd: reserve } });
    }
    return getCampaign(store, mission.campaign_id);
  } catch (error) {
    warn(`mission ${mission.id} started, but campaign ${mission.campaign_id} did not record it: ${error.message}`);
    return null;
  }
}

// Dollars the mission's runs reported. Runs without a dollar figure (engines
// that print tokens only) are counted so the campaign can say spend is partial.
function missionCost(root, missionId, deps = {}) {
  const rows = (deps.readRuns || ((r) => readRosterRuns(r, { days: 3650, tailBytes: 64 * 1024 * 1024 })))(root)
    .filter((row) => row.task === missionId);
  let cents = 0;
  let uncosted = 0;
  for (const row of rows) {
    if (typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd)) cents += Math.floor(row.cost_usd * 100 + 0.5);
    else uncosted += 1;
  }
  return { cost_usd: cents / 100, runs: rows.length, uncosted_runs: uncosted };
}

function outcomeFor(mission) {
  return mission.status === 'complete' ? 'kept' : 'failed';
}

// Called from saveMission with the record before and after. Only the step
// into a final status ends the mission in its campaign.
function recordCampaignMissionEnded(root, previous, next, terminalStatuses, deps = {}) {
  if (!next || !next.campaign_id || !terminalStatuses.has(next.status)) return null;
  if (previous && terminalStatuses.has(previous.status)) return null;
  try {
    const store = storeFor(root, deps);
    const view = getCampaign(store, next.campaign_id);
    const known = view && !view.error && view.missions.find((m) => m.id === next.id);
    if (known && known.status === 'ended') return null;
    const cost = missionCost(root, next.id, deps);
    const actor = memberOf(next);
    store.append({
      campaign_id: next.campaign_id, type: 'mission_ended', actor,
      data: {
        mission_id: next.id, outcome: outcomeFor(next), cost_usd: cost.cost_usd,
        runs: cost.runs, uncosted_runs: cost.uncosted_runs, receipt_path: next.receipt_path || null,
      },
    });
    const after = getCampaign(store, next.campaign_id);
    return after ? { campaign: after, next: decide(after), cost } : null;
  } catch (error) {
    warn(`mission ${next.id} ended, but campaign ${next.campaign_id} did not record it: ${error.message}`);
    return null;
  }
}

module.exports = {
  DEFAULT_RESERVE_USD,
  checkCampaignStart,
  defaultReserve,
  missionCost,
  recordCampaignMissionEnded,
  recordCampaignMissionStarted,
};
