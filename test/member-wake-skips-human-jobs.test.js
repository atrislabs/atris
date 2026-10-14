'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const taskDb = require('../lib/task-db');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
const check = 'node --test test/example.test.js';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-human-'));
  t.after(() => { taskDb.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const member = path.join(root, 'atris', 'team', 'demo');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n\n# demo\n');
  fs.writeFileSync(path.join(member, 'MISSION.md'), '# Mission\n\n## North Star\n\nKeep the example project healthy.\n');
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  taskDb.close();
  const dbPath = path.join(root, 'tasks.db');
  const db = taskDb.open(dbPath);
  let clock = 1000;
  const add = (title, options = {}) => {
    const row = taskDb.addTask(db, {
      title, workspaceRoot: taskDb.workspaceRoot(root),
      ...options, metadata: { verify: check, owner: 'demo', ...options.metadata },
    });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(clock += 1000, row.id);
    return row.id;
  };
  const run = (args) => {
    const rows = taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot(root) });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: rows }));
    const result = spawnSync(process.execPath, [cli, 'member', 'wake', 'demo', ...args], {
      cwd: root, encoding: 'utf8', timeout: 20000,
      env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: dbPath, ATRIS_HOME: path.join(root, 'home'), ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  return { db, add, run };
}

function heldJobs(add) {
  return [
    add('Choose the example copy', { tag: 'needs-human' }),
    add('Choose the example date', { tag: 'decision' }),
    add('Choose the example label', { metadata: { tags: ['needs-human'] } }),
    add('Choose the example heading', { metadata: { tags: ['decision'] } }),
    add('Choose the example wording', { metadata: { tag: 'needs-human' } }),
    add('Choose the example theme', { metadata: { tag: 'decision' } }),
    add('Choose the example size #needs-human'),
    add('Choose the example color #decision'),
  ];
}

test('kept wake picks only the untagged checked job and leaves held jobs unclaimed', (t) => {
  const { db, add, run } = project(t);
  const held = heldJobs(add);
  const runnable = add('Fix the example typo');
  for (const args of [['--keep', '--dry-run'], ['--keep', '--dry-run', '--max', '1']]) {
    assert.equal(run(args).trim(), 'would start demo on: Fix the example typo');
  }
  for (const id of [...held, runnable]) {
    assert.equal(taskDb.getTask(db, id).status, 'open');
    assert.equal(taskDb.getTask(db, id).claimed_by, null);
  }
});

test('kept wake stays idle when all checked jobs need a person', (t) => {
  const { add, run } = project(t);
  heldJobs(add);
  assert.equal(run(['--keep', '--dry-run']).trim(), 'nothing to start: no free member has a task with a runnable check');
});

test('single-member wake excludes held jobs from its real task evidence', (t) => {
  const { add, run } = project(t);
  heldJobs(add);
  add('Fix the example typo');
  const result = JSON.parse(run(['--plan', '--json']));
  const evidence = result.evidence.task_projection;
  assert.equal(evidence.task_count, 9);
  assert.equal(evidence.candidate_count, 1);
  assert.equal(evidence.nearest.title, 'Fix the example typo');
  assert.deepEqual(evidence.candidates.map((candidate) => candidate.title), ['Fix the example typo']);
});

test('single-member wake preserves legacy human holds and normalizes decision tags', (t) => {
  const { add, run } = project(t);
  add('Choose the first label', { tag: 'human-only' });
  add('Choose the second label', { metadata: { human_only: true } });
  add('Choose the third label', { metadata: { needs_human: true } });
  add('Choose the fourth label', { metadata: { tags: ['build; #Decision'] } });
  add('Choose the fifth label', { tag: 'needs_human' });
  const result = JSON.parse(run(['--plan', '--json']));
  assert.equal(result.evidence.task_projection.candidate_count, 0);
  assert.equal(result.evidence.task_projection.nearest, null);
});
