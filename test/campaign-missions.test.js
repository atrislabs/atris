'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkCampaignStart, defaultReserve, missionCost, recordCampaignMissionEnded, recordCampaignMissionStarted,
} = require('../lib/campaign-missions');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const TERMINAL = new Set(['stopped', 'complete']);

function campaign(budget = 20) {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({ campaign_id: 'cmp-a', type: 'campaign_started', actor: 'mission-lead', data: { title: 'A', judge: 'exit 1', budget } });
  return store;
}

test('a mission may join only an open campaign that can hold its reserve', () => {
  const store = campaign(10);
  assert.match(checkCampaignStart('/x', 'cmp-none', {}, { store }).error, /no campaign cmp-none/);
  assert.equal(checkCampaignStart('/x', 'cmp-a', {}, { store }).reserve, 5);
  assert.equal(checkCampaignStart('/x', 'cmp-a', { reserveUsd: '2.5' }, { store }).reserve, 2.5);
  assert.match(checkCampaignStart('/x', 'cmp-a', { reserveUsd: '11' }, { store }).error, /has \$10\.00 left and this mission would hold \$11\.00/);
  store.append({ campaign_id: 'cmp-a', type: 'paused', actor: 'human:keshav', data: {} });
  assert.match(checkCampaignStart('/x', 'cmp-a', {}, { store }).error, /is paused, so it takes no new missions/);
});

test('the default reserve follows what this campaign\'s missions have cost', () => {
  const view = { missions: [{ status: 'ended', cost_usd: 1 }, { status: 'ended', cost_usd: 2.005 }, { status: 'running', cost_usd: null }] };
  assert.equal(defaultReserve(view), 1.51);
  assert.equal(defaultReserve({ missions: [] }), 5);
});

test('mission cost adds the runs that reported dollars and counts the ones that did not', () => {
  const readRuns = () => [
    { task: 'm1', cost_usd: 1.105 }, { task: 'm1', cost_usd: 0.5 }, { task: 'm1' }, { task: 'm2', cost_usd: 9 },
  ];
  assert.deepEqual(missionCost('/x', 'm1', { readRuns }), { cost_usd: 1.61, runs: 3, uncosted_runs: 1 });
});

test('a mission starts with its reserve and ends once, releasing it with its real cost', () => {
  const store = campaign(20);
  const deps = { store, readRuns: () => [{ task: 'm1', cost_usd: 2.22 }] };
  const mission = { id: 'm1', owner: 'builder', objective: 'ship it', campaign_id: 'cmp-a', status: 'planning' };
  recordCampaignMissionStarted('/x', mission, 3, deps);
  let view = getCampaign(store, 'cmp-a');
  assert.deepEqual(view.budget, { total: 20, spent: 0, reserved: 3, available: 17 });
  assert.equal(view.missions[0].status, 'running');

  assert.equal(recordCampaignMissionEnded('/x', mission, { ...mission, status: 'running' }, TERMINAL, deps), null);
  const ended = recordCampaignMissionEnded('/x', { ...mission, status: 'running' }, { ...mission, status: 'complete', receipt_path: 'atris/runs/r.json' }, TERMINAL, deps);
  assert.deepEqual(ended.next, { action: 'run_judge' });
  view = getCampaign(store, 'cmp-a');
  assert.deepEqual(view.budget, { total: 20, spent: 2.22, reserved: 0, available: 17.78 });
  assert.deepEqual([view.missions[0].status, view.missions[0].outcome], ['ended', 'kept']);

  assert.equal(recordCampaignMissionEnded('/x', { ...mission, status: 'running' }, { ...mission, status: 'stopped' }, TERMINAL, deps), null);
  assert.equal(getCampaign(store, 'cmp-a').budget.spent, 2.22);
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-missions-'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# Builder\n', 'utf8');
  return root;
}

test('the real commands: atris mission start --campaign reports into the campaign, and refusals leave no mission', () => {
  const root = workspace();
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db'), ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });

  assert.equal(cli('campaign', 'start', 'Ship it', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-ship').status, 0);

  const refused = cli('mission', 'start', 'Too expensive', '--owner', 'builder', '--no-verify', '--campaign', 'cmp-ship', '--reserve', '50', '--json');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /has \$10\.00 left and this mission would hold \$50\.00/);
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'missions.jsonl')), false);

  const started = cli('mission', 'start', 'Write the backend fold', '--owner', 'builder', '--no-verify', '--campaign', 'cmp-ship', '--reserve', '4', '--json');
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  assert.equal(mission.campaign_id, 'cmp-ship');
  assert.equal(mission.objective, 'Write the backend fold');

  let view = JSON.parse(cli('campaign', 'show', 'cmp-ship', '--json').stdout).campaign;
  assert.deepEqual(view.missions.map((m) => [m.id, m.member, m.status]), [[mission.id, 'builder', 'running']]);
  assert.equal(view.budget.reserved, 4);

  const stopped = cli('mission', 'stop', mission.id, '--reason', 'priorities changed', '--json');
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  view = JSON.parse(cli('campaign', 'show', 'cmp-ship', '--json').stdout).campaign;
  assert.deepEqual([view.missions[0].status, view.missions[0].outcome, view.missions[0].cost_usd], ['ended', 'failed', 0]);
  assert.deepEqual(view.budget, { total: 10, spent: 0, reserved: 0, available: 10 });
  assert.equal(view.judge_due, true);

  const plain = cli('mission', 'start', 'No campaign here', '--owner', 'builder', '--no-verify', '--json');
  assert.equal(plain.status, 0, plain.stderr || plain.stdout);
  assert.equal(JSON.parse(plain.stdout).mission.campaign_id, undefined);
  assert.equal(JSON.parse(cli('campaign', 'show', 'cmp-ship', '--json').stdout).campaign.missions.length, 1);
});
