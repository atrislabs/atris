'use strict';

// The second model that approves a mission tick must judge the work against
// what the job said done looks like, not only the mission headline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hasNodeSqlite: probeNodeSqlite } = require('./helpers/node-sqlite');

const { buildEngineVerifyPrompt, missionDoneLooksLike } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const hasNodeSqlite = () => probeNodeSqlite({ NODE_NO_WARNINGS: '1' });

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function withWorkspace(fn) {
  if (!hasNodeSqlite()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-done-line-test-'));
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), ATRIS_AGENT_PROOF_ONLY: '0' };
  const previousDb = process.env.ATRIS_TASKS_DB;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    process.env.ATRIS_TASKS_DB = env.ATRIS_TASKS_DB;
    fn({ dir, env });
  } finally {
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function newTask(dir, env, args) {
  const created = runCli(['task', 'new', ...args, '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  return JSON.parse(created.stdout).task;
}

test('the reviewer prompt carries the done line and fails work that misses it', () => {
  const prompt = buildEngineVerifyPrompt(
    { objective: 'Ship the export button' },
    2,
    'A person clicks  export and gets a csv file.',
  );
  assert.match(prompt, /The job says done looks like: A person clicks export and gets a csv file\./);
  assert.match(prompt, /Compare the work against that line/);
  assert.match(prompt, /verdict is FAIL even when the checks pass/);
  assert.match(prompt, /VERDICT: PASS' or 'VERDICT: FAIL'/);
});

test('with no done line the reviewer prompt stays as it was', () => {
  const prompt = buildEngineVerifyPrompt({ objective: 'Ship the export button' }, 1);
  assert.doesNotMatch(prompt, /done looks like/i);
  assert.match(prompt, /verify-only pass for mission: Ship the export button/);
});

test('the reviewer gets the done line the mission job wrote down', () => {
  withWorkspace(({ dir, env }) => {
    const task = newTask(dir, env, ['Ship the export button', '--done-looks-like', 'A person clicks export and gets a csv file']);
    const line = missionDoneLooksLike({ objective: 'Ship the export button', task_ids: [task.id] }, dir);
    assert.equal(line, 'A person clicks export and gets a csv file.');
  });
});

test('a job that never wrote a done line hands the reviewer nothing, not a generic guess', () => {
  withWorkspace(({ dir, env }) => {
    const task = newTask(dir, env, ['Ship the export button']);
    assert.equal(missionDoneLooksLike({ objective: 'Ship the export button', task_ids: [task.id] }, dir), '');
  });
});

test('a mission with no matching job hands the reviewer nothing', () => {
  withWorkspace(({ dir }) => {
    assert.equal(missionDoneLooksLike({ objective: 'Something nobody filed', task_ids: [] }, dir), '');
  });
});
