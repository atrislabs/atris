'use strict';

// One table for every `atris task <verb> --help` guard. Each verb must print
// its one usage line, must not touch the task db or scaffold a workspace, and
// `task <verb> <id> --help` must leave the row exactly as it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');

const { hasNodeSqlite, makeTempDir, cleanupTempDir, runCli } =
  createTaskHelpFixture('atris-task-help-');

const VERBS = [
  {
    verb: 'accept',
    usage: 'Usage: atris task accept <id> [--proof "..."] [--public]',
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task claim|say yes:/,
    acted: /accepted|id required|proof required/i,
    idTitle: 'task accept <id> --help does not accept the task',
    rowTitle: 'Keep accept help from saying yes',
  },
  {
    verb: 'claim',
    usage: 'Usage: atris task claim <id> --as <member>',
    listed: /atris task claim <id> --as <member>/,
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task accept|say yes:/,
    acted: /claimed|id required|actor_not_on_roster|reserved_actor/i,
    idTitle: 'task claim <id> --help does not claim the task',
    rowTitle: 'Keep claim help from taking the row',
    sameOwner: true,
  },
  {
    verb: 'next',
    usage: 'Usage: atris task next [--tag <tag>] [--create-next]',
    listed: /atris task next \[--tag <tag>\] \[--create-next\]/,
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|say yes:/,
    acted: /claimed|id required|next:|No open tasks/i,
    idTitle: 'task next <id> --help does not claim the task',
    rowTitle: 'Keep next help from taking the row',
    sameOwner: true,
  },
  {
    verb: 'ready',
    usage: 'Usage: atris task ready <id> --proof "..." --result "<sentence>"',
    listed: /atris task ready <id> --proof "\.\.\." --result "<sentence>"/,
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task claim|say yes:/,
    acted: /id required|proof required|verifier failed|ready:/i,
    idTitle: 'task ready <id> --help does not ready the task',
    rowTitle: 'Keep ready help from sending the row to review',
  },
  {
    verb: 'show',
    usage: 'Usage: atris task show <id> [--json]',
    listed: /atris task show <id> \[--json\]/,
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|say yes:/,
    acted: /Technical details|Dialogue:|id required|task not found|missing_id/i,
    idTitle: 'task show <id> --help does not show the task',
    rowTitle: 'Keep show help from dumping the card',
    hidesRow: true,
  },
  {
    verb: 'step',
    usage: 'Usage: atris task step <id> [--json]',
    noise: /durable local task state|Confidence Gate|TASK DESK|atris task list|atris task accept|say yes:/,
    acted: /id required|no safe agent|missing_id|step:/i,
    idTitle: 'task step <id> --help does not step the task',
    rowTitle: 'Keep step help from advancing the row',
  },
];

function assertHelpOnly(spec, res, label) {
  assert.equal(res.status, 0, `${label}: ${res.stdout}\n${res.stderr}`);
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1 && lines.length <= 2, `${label} should print one usage line: ${res.stdout}`);
  assert.equal(lines[0], spec.usage, `${label}: ${res.stdout}`);
  const blob = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(blob, spec.noise);
  assert.doesNotMatch(blob, spec.acted);
}

for (const spec of VERBS) {
  const { verb } = spec;

  test(`task ${verb} --help prints one usage line and does not list or mutate`, () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'tasks.db');
    try {
      for (const flag of ['--help', '-h', 'help', '-?']) {
        const args = ['task', verb, flag];
        const res = runCli(args, { cwd: dir, env: { ATRIS_TASKS_DB: dbPath } });
        assertHelpOnly(spec, res, args.join(' '));
      }
      assert.equal(fs.existsSync(dbPath), false, `${verb} --help must not open the task db`);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false, `${verb} --help must not create .atris`);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${verb} --help must not scaffold atris/`);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test(spec.idTitle, () => {
    if (!hasNodeSqlite()) return;
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'tasks.db');
    const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
    try {
      fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

      const add = runCli(['task', 'add', spec.rowTitle, '--tag', 'cli', '--json'], { cwd: dir, env });
      assert.equal(add.status, 0, add.stderr || add.stdout);
      const ref = JSON.parse(add.stdout).task.display_id;
      const before = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);

      const help = runCli(['task', verb, ref, '--help'], { cwd: dir, env });
      assertHelpOnly(spec, help, `task ${verb} ${ref} --help`);
      if (spec.hidesRow) {
        assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, new RegExp(ref));
        assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, new RegExp(spec.rowTitle));
      }

      const after = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
      assert.equal(after.status, before.status);
      assert.equal(after.updated_at, before.updated_at);
      if (spec.sameOwner) {
        assert.equal(after.claimed_by || after.owner || null, before.claimed_by || before.owner || null);
      }
      if (spec.hidesRow) assert.equal(after.title, before.title);
    } finally {
      cleanupTempDir(dir);
    }
  });
}

test('task --help still prints the full task usage', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['task', '--help'], { cwd: dir });
    assert.equal(res.status, 0, `task --help: ${res.stdout}\n${res.stderr}`);
    const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 10, `task --help should stay the encyclopedia: ${res.stdout}`);
    assert.match(res.stdout, /atris task - durable local task state/);
    for (const spec of VERBS) {
      if (spec.listed) assert.match(res.stdout, spec.listed);
      assert.notEqual(lines[0], spec.usage);
    }
  } finally {
    cleanupTempDir(dir);
  }
});
