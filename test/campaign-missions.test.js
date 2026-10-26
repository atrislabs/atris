'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkCampaignStart, defaultReserve, missionCost, recordCampaignMissionEnded, recordCampaignMissionStarted, recordCampaignTick,
} = require('../lib/campaign-missions');
const { createMemoryStore, createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { makeLoop } = require('../lib/campaign-loop');
const { missionObjectiveIsJunk } = require('../commands/mission');

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

test('each tick records its cost in the campaign; mission cost adds them and counts ticks with no dollars', () => {
  const store = campaign(20);
  const deps = { store };
  const m1 = { id: 'm1', owner: 'builder', campaign_id: 'cmp-a' };
  recordCampaignMissionStarted('/x', m1, 0, deps);
  recordCampaignMissionStarted('/x', { ...m1, id: 'm2' }, 0, deps);
  recordCampaignTick('/x', m1, { cost_usd: 1.105, tokens: 900 }, deps);
  recordCampaignTick('/x', m1, { cost_usd: 0.5 }, deps);
  recordCampaignTick('/x', m1, { tokens: 4000 }, deps);
  recordCampaignTick('/x', { ...m1, id: 'm2' }, { cost_usd: 9 }, deps);
  recordCampaignTick('/x', { id: 'plain' }, { cost_usd: 1 }, deps);
  assert.deepEqual(missionCost('/x', 'm1', deps), { cost_usd: 1.61, runs: 3, uncosted_runs: 1 });
  assert.equal(getCampaign(store, 'cmp-a').missions[0].steps, 3);
});

test('a mission starts with its reserve and ends once, releasing it with its real cost', () => {
  const store = campaign(20);
  const deps = { store };
  const mission = { id: 'm1', owner: 'builder', objective: 'ship it', campaign_id: 'cmp-a', status: 'planning' };
  recordCampaignMissionStarted('/x', mission, 3, deps);
  recordCampaignTick('/x', mission, { cost_usd: 2.22 }, deps);
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

test('a mission that paused for review ends held, not failed', () => {
  const store = campaign(20);
  const deps = { store };
  const held = { id: 'm1', owner: 'builder', campaign_id: 'cmp-a', status: 'running' };
  const plain = { ...held, id: 'm2' };
  recordCampaignMissionStarted('/x', held, 0, deps);
  recordCampaignMissionStarted('/x', plain, 0, deps);
  recordCampaignMissionEnded('/x', held, { ...held, status: 'stopped', last_tick_status: 'paused-for-review' }, TERMINAL, deps);
  recordCampaignMissionEnded('/x', plain, { ...plain, status: 'stopped', last_tick_status: 'errored' }, TERMINAL, deps);
  const view = getCampaign(store, 'cmp-a');
  assert.deepEqual(view.missions.map((m) => [m.id, m.status, m.outcome]), [['m1', 'ended', 'held'], ['m2', 'ended', 'failed']]);
});

function makeTempDir(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function workspace(t) {
  const root = makeTempDir(t, 'atris-campaign-missions-');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# Builder\n', 'utf8');
  return root;
}

test('the real commands: atris mission start --campaign reports into the campaign, and refusals leave no mission', (t) => {
  const root = workspace(t);
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

for (const source of ['planned single line', 'planned multiline', 'claimed', 'legacy multiline']) {
  test(`a campaign brief reaches a real mission start from ${source} work`, async (t) => {
    const root = workspace(t);
    const db = path.join(root, 'campaign.db');
    const env = { ...process.env, HOME: root, ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
      ATRIS_CAMPAIGN_DB: db, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
    const cli = (args) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    const brief = source === 'planned single line' ? 'Keep the existing output style.'
      : 'Keep the existing output style.\n\nReuse the current helpers.\r\n\tAdd focused checks.';
    const briefFile = path.join(root, 'notes.md');
    fs.writeFileSync(briefFile, brief);
    cli(['campaign', 'start', 'Ship the brief fix', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-brief', '--brief', briefFile]);
    const store = createSqliteStore(db);
    t.after(() => store.close());
    const objective = 'Fix the route handler';
    const expected = `${objective} ${brief.replace(/\s+/g, ' ')}`;
    const started = [];
    const loop = makeLoop(root, { runner: 'manual', parallel: 1 }, {
      store, skipReconcile: true, log: () => {},
      ask: async (cwd, view, prompt) => {
        assert.ok(prompt.includes(brief), 'planning retains the original brief formatting');
        return { ok: true, engine: 'claude', text: JSON.stringify([{ objective, member: 'builder', estimate_usd: 1 }]) };
      },
      cli: async (args) => {
        // Exercise the real start and its campaign hooks, then stop without running an engine.
        const result = cli(args[1] === 'run' ? ['mission', 'stop', args[2], '--json'] : args);
        if (args[1] === 'start') {
          assert.equal(missionObjectiveIsJunk(args[2]), false);
          started.push(JSON.parse(result.stdout).mission);
        }
        return { code: result.status, out: result.stdout, err: result.stderr };
      },
    });
    if (source.startsWith('planned')) {
      await loop.propose('cmp-brief');
      assert.equal(store.read('cmp-brief').find(e => e.type === 'mission_proposed').data.objective, expected);
    } else {
      store.append({ campaign_id: 'cmp-brief', type: 'mission_proposed', actor: 'builder', data: {
        mission_id: 'm-brief', member: 'builder', objective: source === 'claimed' ? objective : `${objective}\n\n${brief}`,
      } });
      store.append({ campaign_id: 'cmp-brief', type: 'mission_claimed', actor: 'builder', data: { mission_id: 'm-brief', claim_key: objective } });
    }
    assert.equal((await loop.step('cmp-brief')).did, 'missions');
    assert.equal(started.length, 1);
    assert.equal(started[0].objective, expected);
    assert.equal(started[0].campaign_id, 'cmp-brief');
    assert.ok(store.read('cmp-brief').some(e => e.type === 'mission_started'));
  });
}

test('a campaign mission records the engine that ran it, for traces and per-engine cost', () => {
  const store = campaign(20);
  const deps = { store };
  const mission = { id: 'm-e', owner: 'builder', campaign_id: 'cmp-a', runner: 'codex', model: 'gpt-6' };
  recordCampaignMissionStarted('/x', mission, 0, deps);
  recordCampaignTick('/x', mission, { cost_usd: 0.1, engine: 'claude' }, deps);
  recordCampaignMissionStarted('/x', { ...mission, id: 'm-auto', runner: 'auto', model: undefined }, 0, deps);
  const events = store.read('cmp-a');
  const started = events.find((e) => e.type === 'mission_started' && e.data.mission_id === 'm-e').data;
  assert.equal(started.engine, 'codex');
  assert.equal(started.model, 'gpt-6');
  assert.equal(events.find((e) => e.type === 'step').data.engine, 'claude');
  assert.equal(events.find((e) => e.data.mission_id === 'm-auto').data.engine, undefined);
});
