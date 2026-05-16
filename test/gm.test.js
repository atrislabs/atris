const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

test('gm mode shows local players missions and next review action', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'game-manager'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'game-manager', 'MEMBER.md'), '# Game Manager\n');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin\n');

    const delegated = runCli([
      'task',
      'delegate',
      'AgentXP Mode customer proof',
      '--to',
      'justin',
      '--tag',
      'agent-xp',
      '--json',
    ], { cwd: dir, env });
    assert.equal(delegated.status, 0, delegated.stderr);
    const ref = JSON.parse(delegated.stdout).task.display_id;
    const ready = runCli(['task', 'ready', ref, '--proof', 'artifact + verifier passed'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const gm = runCli(['gm'], { cwd: dir, env });
    assert.equal(gm.status, 0, gm.stderr);
    assert.match(gm.stdout, /AgentXP General Manager/);
    assert.match(gm.stdout, /Manager game-manager/);
    assert.match(gm.stdout, /Players 1 \| Missions 1 \| Review 1/);
    assert.match(gm.stdout, /justin/);
    assert.match(gm.stdout, new RegExp(`atris task show ${ref}`));
    assert.match(gm.stdout, new RegExp(`atris task accept ${ref}`));
    assert.match(gm.stdout, /Global sync: run atris login once before hosted leaderboard sync\./);
    assert.match(gm.stdout, /atris login/);
    assert.match(gm.stdout, /atris xp sync --local --as justin/);

    const json = runCli(['gm', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.schema, 'atris.agentxp_gm_mode.v1');
    assert.equal(body.manager, 'game-manager');
    assert.equal(body.manager_source, 'team');
    assert.equal(body.counts.players, 1);
    assert.equal(body.review_queue[0].ref, ref);
    assert.equal(body.global_sync_rule, 'Run atris login once before syncing to the hosted AgentXP leaderboard.');
    assert.ok(body.next_commands.indexOf('atris login') < body.next_commands.indexOf('atris xp sync --local --as justin'));
    assert.equal(body.next_commands.includes('atris xp sync --local --as justin'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('gm mode bootstraps a starter mission for a fresh single-player workspace', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', USER: 'owner' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin\n');

    const gm = runCli(['gm'], { cwd: dir, env });
    assert.equal(gm.status, 0, gm.stderr);
    assert.match(gm.stdout, /Starter mission created locally/);
    assert.match(gm.stdout, /justin/);
    assert.match(gm.stdout, /AgentXP Mode first rep/);

    const json = runCli(['gm', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.seeded, null);
    assert.equal(body.missions.length, 1);
    assert.equal(body.missions[0].assigned_to, 'justin');

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr);
    const tasks = JSON.parse(list.stdout).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].metadata.delegate_via, 'agentxp_gm');
  } finally {
    cleanupTempDir(dir);
  }
});

test('gm help is workspace-free and non-mutating', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['gm', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris gm/);
    assert.doesNotMatch(res.stdout + res.stderr, /Run "atris init"|Not logged in|CONTEXT LOADED/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});
