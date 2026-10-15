// Missions that belong to a campaign (build.md Phase 3). commands/mission.js
// calls these at start and on every save; a mission with no campaign_id never
// reaches the store, so plain missions run exactly as before.

'use strict';

const { decide } = require('./campaign-core');
const { getCampaign, openCampaignStore } = require('./campaign-store');

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

// Hold the reserve in one transaction with the check, so missions starting at
// the same moment can never hold more than the campaign has left.
function reserveCampaignMission(root, campaignId, missionId, amount, actor, deps = {}) {
  if (!(amount > 0)) return null;
  const store = storeFor(root, deps);
  return store.append({ campaign_id: campaignId, type: 'budget_reserved', actor, data: { mission_id: missionId, amount_usd: amount } }, {
    check: (view) => {
      if (view.error) throw Object.assign(new Error(`campaign ${campaignId} cannot be read: ${view.error}`), { code: 'campaign_unreadable' });
      if (CLOSED_STATES.has(view.state)) throw Object.assign(new Error(`campaign ${campaignId} is ${view.state.replace(/_/g, ' ')}, so it takes no new missions`), { code: 'campaign_closed' });
      if (amount > view.budget.available) {
        throw Object.assign(new Error(`campaign ${campaignId} has $${view.budget.available.toFixed(2)} left and this mission would hold $${amount.toFixed(2)}. Add money with: atris campaign budget ${campaignId} --add <dollars>`), { code: 'campaign_tank' });
      }
    },
  });
}

// Before each tick: a mission stops working when its campaign is done,
// paused, or out of money. Returns the pause reason, or null to keep going.
function campaignGate(root, mission, deps = {}) {
  if (!mission || !mission.campaign_id) return null;
  try {
    const view = getCampaign(storeFor(root, deps), mission.campaign_id);
    if (!view || view.error) return null;
    if (CLOSED_STATES.has(view.state)) return `campaign-${view.state.replace(/_/g, '-')}`;
  } catch {
    return null;
  }
  return null;
}

function readMissionLedger(root) {
  const file = require('path').join(root, '.atris', 'state', 'missions.jsonl');
  const latest = new Map();
  let text = '';
  try { text = require('fs').readFileSync(file, 'utf8'); } catch { return latest; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.id) latest.set(row.id, row);
    } catch {}
  }
  return latest;
}

// Missions the campaign still counts as running whose mission record says
// they are over, or that never got a record (a start that crashed after its
// reserve): end them in the campaign so their reserve comes back.
function reconcileCampaign(root, campaignId, terminalStatuses, deps = {}) {
  const store = storeFor(root, deps);
  const view = getCampaign(store, campaignId);
  if (!view || view.error) return [];
  const ledger = (deps.readLedger || readMissionLedger)(root);
  const ended = [];
  const reservedOnly = new Set();
  for (const event of store.read(campaignId)) {
    if (event.type === 'budget_reserved' && !view.missions.some((m) => m.id === event.data.mission_id)) reservedOnly.add(event.data.mission_id);
    if (event.type === 'budget_released') reservedOnly.delete(event.data.mission_id);
  }
  for (const missionId of reservedOnly) {
    if (ledger.has(missionId)) continue;
    store.append({ campaign_id: campaignId, type: 'budget_released', actor: 'system', data: { mission_id: missionId, reason: 'mission was never created' } });
    ended.push(missionId);
  }
  for (const m of view.missions) {
    if (m.status !== 'running' || m.id.startsWith('plan-')) continue;
    const record = ledger.get(m.id);
    if (record && !terminalStatuses.has(record.status)) continue;
    if (!record && !deps.endMissing) continue;
    const result = recordCampaignMissionEnded(root, { status: 'running' }, { ...(record || { id: m.id, owner: m.member, status: 'stopped' }), campaign_id: campaignId }, terminalStatuses, deps);
    if (result) ended.push(m.id);
  }
  return ended;
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
      data: {
        mission_id: mission.id, member: actor, objective: String(mission.objective || '').slice(0, 200),
        ...(mission.runner && mission.runner !== 'auto' ? { engine: mission.runner } : {}),
        ...(mission.model ? { model: mission.model } : {}),
      },
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

// Each tick writes a step into the campaign with the dollars its engine
// reported, so the campaign's own log holds the spend: no lookback window, and
// every runner counts, including ones that run without a roster pick.
function recordCampaignTick(root, mission, usage = {}, deps = {}) {
  if (!mission || !mission.campaign_id) return;
  const data = { mission_id: mission.id };
  if (typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd)) data.cost_usd = usage.cost_usd;
  if (typeof usage.tokens === 'number' && Number.isFinite(usage.tokens)) data.tokens = usage.tokens;
  // Which engine did the work: traces and per-engine cost need it.
  if (typeof usage.engine === 'string' && usage.engine) data.engine = usage.engine;
  try {
    storeFor(root, deps).append({ campaign_id: mission.campaign_id, type: 'step', actor: memberOf(mission), data });
  } catch (error) {
    warn(`a tick of mission ${mission.id} was not recorded in campaign ${mission.campaign_id}: ${error.message}`);
  }
}

// Dollars the mission's ticks reported, from the campaign's own steps. Ticks
// without a dollar figure (engines that print tokens only) are counted so the
// campaign can say spend is partial.
function missionCost(root, missionId, deps = {}) {
  const store = storeFor(root, deps);
  const campaignId = store.campaignForMission(missionId);
  const rows = campaignId
    ? store.read(campaignId).filter((e) => e.type === 'step' && e.data.mission_id === missionId).map((e) => e.data)
    : [];
  let cents = 0;
  let uncosted = 0;
  // A cost that is not a real, non-negative number never blocks the mission's
  // end; that tick counts as one without a dollar figure.
  for (const row of rows) {
    if (typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) cents += Math.floor(row.cost_usd * 100 + 0.5);
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
  campaignGate,
  reconcileCampaign,
  reserveCampaignMission,
  checkCampaignStart,
  defaultReserve,
  missionCost,
  recordCampaignMissionEnded,
  recordCampaignMissionStarted,
  recordCampaignTick,
};
