'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openCampaignStore, getCampaign } = require('../lib/campaign-store');
const { runOvernightRsi } = require('../lib/campaign-rsi');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-overnight-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, '.atris', 'state', 'atris.db');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: db, ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, db, env, cli };
}

function pendingJudge(cli, id = 'cmp-one') {
  cli('start', 'A real overnight check', '--judge', 'test -f result.txt', '--id', id, '--owner', 'auto-improver');
  cli('event', id, 'mission_started', '--data', JSON.stringify({ mission_id: `m-${id}`, member: 'auto-improver' }));
  cli('event', id, 'mission_ended', '--data', JSON.stringify({ mission_id: `m-${id}`, outcome: 'kept', cost_usd: 0 }));
}

test('the real overnight command runs a due judge and records the actual step', (t) => {
  const { root, cli } = workspace(t);
  pendingJudge(cli);
  fs.writeFileSync(path.join(root, 'result.txt'), 'the work is real\n');
  const result = cli('rsi', '--loop', '--rounds', '1');
  const view = cli('show', 'cmp-one').campaign;
  assert.equal(view.state, 'done', 'overnight must execute campaign work instead of only writing reports');
  assert.equal(view.judge_runs, 2);
  assert.equal(result.cycles[0].step.did, 'judge');
  assert.equal(result.cycles[0].step.ok, true);
  const log = fs.readFileSync(path.join(root, '.atris', 'state', 'rsi', 'overnight.jsonl'), 'utf8');
  assert.equal(JSON.parse(log.trim()).step.did, 'judge');
});

test('overnight waits for a real asynchronous judge before taking its after reading', async (t) => {
  const { root, db, cli } = workspace(t);
  pendingJudge(cli);
  const oldDb = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = db;
  t.after(() => { if (oldDb === undefined) delete process.env.ATRIS_CAMPAIGN_DB; else process.env.ATRIS_CAMPAIGN_DB = oldDb; });
  const store = openCampaignStore(root);
  const { makeLoop } = require('../lib/campaign-loop');
  const { runJudgeCommand } = require('../commands/campaign');
  const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 80)"`;
  const loop = makeLoop(root, {}, { store, log: () => {}, judge: () => runJudgeCommand(command, root, 5) });
  const result = await runOvernightRsi(root, { store, rounds: 1, stepCampaign: (id) => loop.step(id) });
  assert.equal(result.rsi.completed_count, 1, 'the report must include the finished async step');
  assert.equal(getCampaign(store, 'cmp-one').state, 'done');
});

test('overnight gives each open campaign a turn before repeating one', (t) => {
  const { cli } = workspace(t);
  pendingJudge(cli, 'cmp-one');
  pendingJudge(cli, 'cmp-two');
  const result = cli('rsi', '--loop', '--rounds', '2');
  assert.deepEqual(new Set(result.cycles.map((c) => c.top_campaign)), new Set(['cmp-one', 'cmp-two']));
  assert.equal(cli('show', 'cmp-one').campaign.judge_runs, 2);
  assert.equal(cli('show', 'cmp-two').campaign.judge_runs, 2);
});

test('an overnight dry run leaves campaign events unchanged and runs no judge', (t) => {
  const { root, cli } = workspace(t);
  pendingJudge(cli);
  fs.writeFileSync(path.join(root, 'result.txt'), 'ready\n');
  const before = cli('show', 'cmp-one').campaign;
  const result = cli('rsi', '--loop', '--rounds', '2', '--dry-run');
  assert.deepEqual(cli('show', 'cmp-one').campaign, before);
  assert.ok(result.cycles.every((c) => c.step === null));
});

test('a named overnight campaign leaves other campaigns alone', (t) => {
  const { root, cli } = workspace(t);
  pendingJudge(cli, 'cmp-one');
  pendingJudge(cli, 'cmp-two');
  fs.writeFileSync(path.join(root, 'result.txt'), 'ready\n');
  const result = cli('rsi', 'cmp-two', '--loop', '--rounds', '2');
  assert.equal(result.cycles.length, 1);
  assert.equal(cli('show', 'cmp-one').campaign.judge_runs, 1);
  assert.equal(cli('show', 'cmp-two').campaign.state, 'done');
});

test('a busy campaign records the refusal and the next campaign still gets a turn', (t) => {
  const { root, env, cli } = workspace(t);
  pendingJudge(cli, 'cmp-one');
  pendingJudge(cli, 'cmp-two');
  fs.writeFileSync(path.join(root, 'result.txt'), 'ready\n');
  const { acquireRunLock } = require('../lib/campaign-run-lock');
  const lock = acquireRunLock(path.join(root, '.atris', 'state'), 'cmp-one');
  assert.equal(lock.ok, true);
  t.after(lock.release);
  const run = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', '--loop', '--rounds', '5', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 1, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.cycles.length, 2, 'do not keep retrying a refused campaign in the same run');
  assert.match(result.cycles[0].step.error, /another run is driving/);
  assert.equal(cli('show', 'cmp-one').campaign.judge_runs, 1);
  assert.equal(cli('show', 'cmp-two').campaign.state, 'done');
});

test('overnight refuses invalid cycle limits before running work', (t) => {
  const { root, env } = workspace(t);
  for (const rounds of ['Infinity', '1.5', '-1', '0', 'junk']) {
    const run = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', '--loop', '--rounds', rounds, '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(run.status, 2, `${rounds}: ${run.stdout}${run.stderr}`);
    assert.match(JSON.parse(run.stdout).error, /positive whole number/);
  }
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'rsi', 'overnight.jsonl')), false);
});

test('a library caller cannot report live cycles without a runner', async (t) => {
  const { root } = workspace(t);
  await assert.rejects(runOvernightRsi(root), /needs a campaign runner/);
});

test('a real failed mission start makes the overnight run fail', (t) => {
  const { root, env, cli } = workspace(t);
  cli('start', 'Work must actually start', '--judge', 'false', '--id', 'cmp-start-fails', '--owner', 'auto-improver');
  cli('event', 'cmp-start-fails', 'mission_proposed', '--data', JSON.stringify({
    mission_id: 'm-start-fails', member: 'auto-improver', objective: 'Make the real result file', verify: 'test -f result.txt',
  }));
  cli('event', 'cmp-start-fails', 'mission_claimed', '--data', JSON.stringify({ mission_id: 'm-start-fails', claim_key: 'real-start' }));
  const run = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', 'cmp-start-fails', '--loop', '--rounds', '1', '--runner', 'nonexistent-engine', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.cycles[0].step.ok, false);
  assert.match(result.cycles[0].step.reason, /no claimed mission could start/);
  assert.equal(cli('show', 'cmp-start-fails').campaign.missions[0].status, 'vetoed');
});

test('a locked cold campaign keeps its seats until the active driver releases it', (t) => {
  const { root, env, cli } = workspace(t);
  cli('start', 'A cold but busy campaign', '--judge', 'false', '--id', 'cmp-cold', '--owner', 'cold-worker');
  for (let i = 0; i < 2; i += 1) {
    cli('event', 'cmp-cold', 'mission_started', '--data', JSON.stringify({ mission_id: `m-cold-${i}`, member: 'cold-worker' }));
    cli('event', 'cmp-cold', 'mission_ended', '--data', JSON.stringify({ mission_id: `m-cold-${i}`, outcome: 'failed', cost_usd: 0 }));
  }
  pendingJudge(cli, 'cmp-warm');
  const before = cli('show', 'cmp-cold').campaign;
  const { acquireRunLock } = require('../lib/campaign-run-lock');
  const lock = acquireRunLock(path.join(root, '.atris', 'state'), 'cmp-cold');
  t.after(lock.release);
  const run = spawnSync(process.execPath, [CLI, 'campaign', 'rsi', 'cmp-cold', '--loop', '--rounds', '1', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(cli('show', 'cmp-cold').campaign, before);
  assert.deepEqual(JSON.parse(run.stdout).cycles[0].auto_seated, []);
});
