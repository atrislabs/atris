'use strict';

// Regressions for what the adversarial and newcomer validators found.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const { campaignCommand, runJudgeCommand } = require('../commands/campaign');
const { campaignGate, missionCost, reconcileCampaign, reserveCampaignMission } = require('../lib/campaign-missions');
const { createMemoryStore, createSqliteStore, getCampaign, listCampaigns } = require('../lib/campaign-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const TERMINAL = new Set(['stopped', 'complete']);

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-hard-')));
}

function startCampaign(store, budget = 10) {
  store.append({ campaign_id: 'cmp-h', type: 'campaign_started', actor: 'mission-lead', data: { title: 'H', judge: 'exit 1', budget } });
}

test('missions starting at the same moment can never hold more than the campaign has', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# Builder\n');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(root, 'c.db'), ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_HUMAN: '1' };
  assert.equal(spawnSync(process.execPath, [CLI, 'campaign', 'start', 'Race', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-race'], { cwd: root, env }).status, 0);
  const start = (i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mission', 'start', `write parser module number ${i}`, '--owner', 'builder', '--no-verify', '--campaign', 'cmp-race', '--reserve', '6', '--json'], { cwd: root, env, stdio: 'ignore' });
    child.on('close', resolve);
  });
  const codes = await Promise.all([1, 2, 3, 4].map(start));
  assert.equal(codes.filter((c) => c === 0).length, 1, `exit codes ${codes}`);
  const view = JSON.parse(spawnSync(process.execPath, [CLI, 'campaign', 'show', 'cmp-race', '--json'], { cwd: root, env, encoding: 'utf8' }).stdout).campaign;
  assert.equal(view.budget.reserved, 6);
  assert.ok(view.budget.available >= 0);
});

test('the reserve is checked and held in one step; closed campaigns refuse it', () => {
  const store = createMemoryStore();
  startCampaign(store, 10);
  reserveCampaignMission('/x', 'cmp-h', 'm1', 6, 'builder', { store });
  assert.throws(() => reserveCampaignMission('/x', 'cmp-h', 'm2', 6, 'builder', { store }), { code: 'campaign_tank' });
  store.append({ campaign_id: 'cmp-h', type: 'paused', actor: 'human:k', data: {} });
  assert.throws(() => reserveCampaignMission('/x', 'cmp-h', 'm3', 1, 'builder', { store }), { code: 'campaign_closed' });
});

test('a paused, finished, or broke campaign stops its missions before the next tick', () => {
  const store = createMemoryStore();
  startCampaign(store, 1);
  const mission = { id: 'm1', campaign_id: 'cmp-h' };
  assert.equal(campaignGate('/x', mission, { store }), null);
  store.append({ campaign_id: 'cmp-h', type: 'paused', actor: 'human:k', data: {} });
  assert.equal(campaignGate('/x', mission, { store }), 'campaign-paused');
  store.append({ campaign_id: 'cmp-h', type: 'resumed', actor: 'human:k', data: {} });
  store.append({ campaign_id: 'cmp-h', type: 'mission_ended', actor: 'b', data: { mission_id: 'm0', outcome: 'kept', cost_usd: 2 } });
  assert.equal(campaignGate('/x', mission, { store }), 'campaign-out-of-budget');
  assert.equal(campaignGate('/x', { id: 'plain' }, { store }), null);
});

test('reconcile gives back reserves of missions that died or never existed, even with a bad cost on file', () => {
  const store = createMemoryStore();
  startCampaign(store, 20);
  reserveCampaignMission('/x', 'cmp-h', 'ghost', 3, 'builder', { store });
  store.append({ campaign_id: 'cmp-h', type: 'mission_started', actor: 'builder', data: { mission_id: 'dead', member: 'builder' } });
  store.append({ campaign_id: 'cmp-h', type: 'budget_reserved', actor: 'builder', data: { mission_id: 'dead', amount_usd: 4 } });
  store.append({ campaign_id: 'cmp-h', type: 'step', actor: 'builder', data: { mission_id: 'dead', cost_usd: -50 } });
  store.append({ campaign_id: 'cmp-h', type: 'step', actor: 'builder', data: { mission_id: 'dead', cost_usd: 0.4 } });
  assert.deepEqual(missionCost('/x', 'dead', { store }), { cost_usd: 0.4, runs: 2, uncosted_runs: 1 });
  const ledger = new Map([['dead', { id: 'dead', owner: 'builder', status: 'stopped' }]]);
  const ended = reconcileCampaign('/x', 'cmp-h', TERMINAL, { store, readLedger: () => ledger });
  assert.deepEqual(ended.sort(), ['dead', 'ghost']);
  const view = getCampaign(store, 'cmp-h');
  assert.deepEqual(view.budget, { total: 20, spent: 0.4, reserved: 0, available: 19.6 });
  assert.deepEqual(reconcileCampaign('/x', 'cmp-h', TERMINAL, { store, readLedger: () => ledger }), []);
});

async function cli(store, args, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const out = [];
  const log = console.log;
  const err = console.error;
  console.log = (line) => out.push(String(line));
  console.error = (line) => out.push(String(line));
  try {
    const code = await campaignCommand(args, { store, runJudge: async () => ({ passed: false, exit: 1, summary: 'no', seconds: 0 }) });
    return { code, out: out.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('an agent shell is never recorded as a person, and nobody can claim to be one', async () => {
  const store = createMemoryStore();
  await cli(store, ['start', 'T', '--judge', 'exit 1', '--budget', '5', '--id', 'cmp-t'], { CLAUDECODE: '1', ATRIS_AGENT_ID: '', ATRIS_HUMAN: '' });
  const startedBy = store.read('cmp-t')[0].actor;
  assert.equal(startedBy, 'agent');
  assert.equal((await cli(store, ['pause', 'cmp-t', '--as', 'human:keshav'])).code, 2);
  await cli(store, ['event', 'cmp-t', 'ask_opened', '--data', '{"ask_id":"a1","question":"Send it?"}']);
  const forged = await cli(store, ['event', 'cmp-t', 'judge_ran', '--data', '{"passed":true}']);
  assert.equal(forged.code, 2);
  assert.match(forged.out, /use atris campaign judge/);
  assert.equal((await cli(store, ['event', 'cmp-t', 'budget_added', '--data', '{"amount_usd":1000000}'])).code, 2);
  assert.equal(getCampaign(store, 'cmp-t').state, 'needs_you');
});

test('a bad id is refused before the judge runs, and a failing judge exits 1', async () => {
  const store = createMemoryStore();
  let judged = 0;
  const code = await campaignCommand(['start', 'X', '--judge', 'exit 1', '--budget', '1', '--id', 'cmp x', '--json'], { store, runJudge: async () => { judged++; return { passed: false }; } });
  assert.equal(code, 2);
  assert.equal(judged, 0);
  await campaignCommand(['start', 'X', '--judge', 'exit 1', '--budget', '1', '--id', 'cmp-x', '--json'], { store, runJudge: async () => ({ passed: false, exit: 1, summary: 'no', seconds: 0 }) });
  assert.equal(await campaignCommand(['judge', 'cmp-x', '--json'], { store, runJudge: async () => ({ passed: false, exit: 1, summary: 'fail 2', seconds: 0 }) }), 1);
});

test('the judge kills everything it started on timeout and survives a huge output', async () => {
  const dir = tempDir();
  const marker = path.join(dir, 'grandchild-alive');
  const slow = await runJudgeCommand(`(sleep 3; touch ${marker}) & sleep 3`, dir, 1);
  assert.equal(slow.passed, false);
  assert.match(slow.summary, /timed out after 1s/);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(fs.existsSync(marker), false, 'a grandchild outlived the judge timeout');

  const big = await runJudgeCommand("head -c 40000000 /dev/zero | tr '\\0' 'x'; echo; echo 'ℹ pass 3'; echo 'ℹ fail 0'", dir, 60);
  assert.equal(big.passed, true);
  assert.equal(big.summary, 'pass 3, fail 0');
});

test('one corrupt campaign never hides the others, and a read-only store still lists', () => {
  const file = path.join(tempDir(), 'atris.db');
  const store = createSqliteStore(file, { origin: 'laptop' });
  store.append({ campaign_id: 'cmp-good', type: 'campaign_started', actor: 'm', data: { title: 'Good', judge: 'exit 1', budget: 1 } });
  store.append({ campaign_id: 'cmp-bad', type: 'campaign_started', actor: 'm', data: { title: 'Bad', judge: 'exit 1', budget: 1 } });
  store.close();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec("UPDATE events SET data = '{oops' WHERE campaign_id = 'cmp-bad'");
  db.close();
  const reopened = createSqliteStore(file);
  const listed = listCampaigns(reopened);
  assert.deepEqual(listed.map((c) => [c.id, Boolean(c.error)]), [['cmp-good', false], ['cmp-bad', true]]);
  reopened.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o444);
  const readOnly = createSqliteStore(file);
  assert.equal(readOnly.readOnly, true);
  assert.equal(listCampaigns(readOnly)[0].title, 'Good');
  assert.throws(() => readOnly.append({ campaign_id: 'cmp-good', type: 'paused', actor: 'h', data: {} }), { code: 'read_only' });
  readOnly.close();
});
