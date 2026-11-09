'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const { loadLocalTasks } = require('../lib/first-minute');
const {
  makeTempDir, cleanupTempDir, runCli, writeProjection, taskEnv,
} = require('./helpers/task-next-fixture');

function room(t) {
  const root = makeTempDir('atris-next-context-');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/atris.md'), '# workspace\n');
  t.after(() => { taskDb.close(); cleanupTempDir(root); });
  return { root, env: taskEnv(root) };
}

function write(root, name, body) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function next(root, env) {
  const result = runCli(['task', 'next', '--json'], { cwd: root, env, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { result, payload: JSON.parse(result.stdout) };
}

function promptContext(root, env, id) {
  const previous = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = env.ATRIS_TASKS_DB;
  try {
    const { buildTickPrompt } = require('../commands/mission');
    const prompt = buildTickPrompt({
      id: 'mission-1', owner: 'builder', objective: 'Repair calendar lookups',
      xp_task: { task_id: id }, status: 'running',
    }, 1, 1, { lane: 'code', verifier: 'node --test test/calendar.test.js' }, [], root);
    return JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"schema":"atris.next_work_context.v1"')));
  } finally {
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
  }
}

test('the original prioritization question routes to a read-only current-state lookup', (t) => {
  const { root, env } = room(t);
  for (const phrase of [
    'whats the most important work to work on',
    'what should we work on next',
    'what is the highest priority work',
  ]) {
    const result = runCli(['guide', phrase, '--json'], { cwd: root, env });
    assert.equal(result.status, 0, phrase + result.stderr + result.stdout);
    const route = JSON.parse(result.stdout).intent;
    assert.equal(route.id, 'prioritize_work');
    assert.equal(route.do, 'atris task next --json');
  }
  assert.equal(fs.existsSync(env.ATRIS_TASKS_DB), false);
});

test('a stale projection cannot resurrect a task the database already finished', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const added = taskDb.addTask(db, {
    workspaceRoot: root, title: 'Finish the calendar lookup', status: 'done',
  });
  writeProjection(root, [{ id: added.id, display_id: 'OLD-1', title: 'Finish the calendar lookup', status: 'open' }]);
  const before = db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;
  const { payload } = next(root, env);
  assert.equal(payload.task, null);
  assert.equal(payload.context.task_source, 'database');
  assert.equal(payload.context.next_step.kind, 'discover');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, before);
});

test('the fast boot reader also keeps database completion over the same stale task', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const added = taskDb.addTask(db, { workspaceRoot: root, title: 'A completed lookup', status: 'done' });
  writeProjection(root, [{ id: added.id, title: 'A completed lookup', status: 'open' }]);
  const previous = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = env.ATRIS_TASKS_DB;
  try {
    assert.equal(loadLocalTasks(root).find((row) => row.id === added.id).status, 'done');
  } finally {
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
  }
});

test('one CLI lookup includes the real goal, existing parts, prior lessons and unverified claims', (t) => {
  const { root, env } = room(t);
  write(root, '.atris/state/scoreboard.json', JSON.stringify({ goal: 'Make calendar lookups reliable', updated_at: new Date().toISOString() }));
  write(root, 'lib/calendar.js', 'module.exports = {};\n');
  write(root, 'atris/MAP.md', '| Task | Primary path | Notes |\n|---|---|---|\n| calendar lookup | `lib/calendar.js` | existing calendar reader |\n| calendar missing | `lib/missing.js` | absent code |\n');
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const added = taskDb.addTask(db, {
    workspaceRoot: root, title: 'Repair calendar lookup retries', status: 'open',
    metadata: { verify: 'node --test test/calendar.test.js', why_it_matters: 'Readers miss meetings after a timeout', done_looks_like: 'A retry returns the saved meeting' },
  });
  taskDb.addTask(db, {
    workspaceRoot: root, title: 'Calendar account selection', status: 'done',
    metadata: { result: 'Calendar account selection is implemented', latest_agent_lesson: 'Reuse the existing account picker', latest_agent_proof: 'reported, not independently checked' },
  });
  const { result, payload } = next(root, env);
  assert.equal(payload.task_id, added.id);
  assert.equal(payload.context.goal.text, 'Make calendar lookups reliable');
  assert.equal(payload.context.goal.source, '.atris/state/scoreboard.json');
  assert.ok(payload.context.parts.some((part) => part.path === 'lib/calendar.js'));
  assert.ok(!payload.context.parts.some((part) => part.path === 'lib/missing.js'));
  assert.equal(payload.context.recent_outcomes[0].lesson, 'Reuse the existing account picker');
  assert.equal(payload.context.recent_outcomes[0].validation, 'reported');
  assert.equal(payload.context.next_step.kind, 'execute');
  assert.match(payload.context.next_step.check, /calendar\.test\.js/);
  assert.ok(Buffer.byteLength(result.stdout) < 16000, 'one bounded packet, not the history');
});

test('missing context and checks produce discovery instead of invented certainty', (t) => {
  const { root, env } = room(t);
  writeProjection(root, [{ id: 'new-1', title: 'Improve the system', status: 'open' }]);
  const { payload } = next(root, env);
  assert.equal(payload.context.goal, null);
  assert.ok(payload.context.gaps.includes('current_goal_missing'));
  assert.ok(payload.context.gaps.includes('runnable_check_missing'));
  assert.equal(payload.context.next_step.kind, 'discover');
  assert.equal(payload.context.task_source, 'projection');
});

test('legacy display-only snapshots stay visible without gaining database authority', (t) => {
  const { root, env } = room(t);
  writeProjection(root, [{ display_id: 'OLD-1', title: 'Repair a saved lookup', status: 'open', metadata: { verify: 'node --test test/calendar.test.js' } }]);
  const { payload } = next(root, env);
  assert.equal(payload.task.display_id, 'OLD-1');
  assert.equal(payload.context.task_source, 'projection');
  assert.equal(payload.context.next_step.kind, 'discover');
  assert.ok(payload.context.gaps.includes('task_snapshot_not_authoritative'));
});

test('autonomous prompts receive the same current evidence without a second startup', (t) => {
  const { root } = room(t);
  write(root, '.atris/state/scoreboard.json', JSON.stringify({ goal: 'Reliable calendar lookups' }));
  write(root, 'lib/calendar.js', 'module.exports = {};\n');
  write(root, 'atris/MAP.md', '| calendar lookups | `lib/calendar.js` | account-aware reader |\n');
  writeProjection(root, [{ id: 'job-1', title: 'Repair calendar lookups', status: 'open' }]);
  const { buildTickPrompt } = require('../commands/mission');
  const prompt = buildTickPrompt({
    id: 'mission-1', owner: 'builder', objective: 'Repair calendar lookups',
    xp_task: { task_id: 'job-1', title: 'Repair calendar lookups' }, status: 'running',
  }, 1, 1, { lane: 'code', verifier: 'node check.js' }, [], root);
  assert.match(prompt, /## Current work evidence/);
  assert.match(prompt, /Reliable calendar lookups/);
  assert.match(prompt, /lib\/calendar\.js/);
  assert.match(prompt, /observed gap/);
  assert.match(prompt, /learned: <one line>/);
  assert.match(prompt, /Skip workspace boot and start-of-session routines/);
  assert.match(prompt, /\*\*Verifier \(frozen\):\*\* node check\.js/);
});

test('a projection cannot borrow a known task from another workspace', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const foreign = taskDb.addTask(db, { workspaceRoot: path.join(root, 'other-workspace'), title: 'Foreign private task', status: 'open' });
  writeProjection(root, [{ id: foreign.id, title: 'Foreign private task', status: 'open' }]);
  const { payload, result } = next(root, env);
  assert.equal(payload.task, null);
  assert.doesNotMatch(result.stdout, /Foreign private task/);
});

test('known completions beyond the boot row limit still defeat old projections', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const first = taskDb.addTask(db, { workspaceRoot: root, title: 'Oldest completion', status: 'done' });
  db.prepare('UPDATE tasks SET created_at = 1 WHERE id = ?').run(first.id);
  for (let i = 0; i < 205; i++) taskDb.addTask(db, { workspaceRoot: root, title: `Finished item ${i}`, status: 'done' });
  writeProjection(root, [{ id: first.id, title: 'Oldest completion', status: 'open' }]);
  const previous = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = env.ATRIS_TASKS_DB;
  try {
    assert.equal(loadLocalTasks(root).find((row) => row.id === first.id).status, 'done');
  } finally {
    if (previous === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previous;
  }
  assert.equal(next(root, env).payload.task, null);
});

test('a large source stays bounded and a long check is never returned as an executable ellipsis', (t) => {
  const { root, env } = room(t);
  write(root, '.atris/state/scoreboard.json', JSON.stringify({ goal: 'g'.repeat(30000) }));
  write(root, 'atris/MAP.md', 'x'.repeat(100000));
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  taskDb.addTask(db, { workspaceRoot: root, title: 'A bounded next step', status: 'open', metadata: { verify: `node --test ${'x'.repeat(1000)}` } });
  const { payload } = next(root, env);
  assert.equal(payload.context.goal, null);
  assert.equal(payload.context.next_step.kind, 'discover');
  assert.equal(payload.context.next_step.check, null);
  assert.ok(payload.context.gaps.includes('check_too_large_for_snapshot'));
  assert.ok(payload.context.gaps.includes('goal_source_truncated'));
  assert.ok(payload.context.gaps.includes('parts_map_truncated'));
  assert.ok(Buffer.byteLength(JSON.stringify(payload.context)) < 10000);
});

test('the context distinguishes human acceptance, another owner and untrusted snapshots', (t) => {
  const { root } = room(t);
  const { buildNextWorkContext } = require('../lib/next-work-context');
  const owned = { id: 'held', title: 'Calendar lookup', status: 'claimed', claimed_by: 'someone-else', metadata: { verify: 'node --test test/calendar.test.js' } };
  assert.equal(buildNextWorkContext({ root, selected: owned, owner: 'builder', taskSource: 'database' }).next_step.kind, 'wait');
  const certified = { ...owned, status: 'review', metadata: { agent_certified: true } };
  assert.equal(buildNextWorkContext({ root, selected: certified, owner: 'builder', taskSource: 'database' }).next_step.kind, 'human_decision');
  const projected = { ...owned, claimed_by: 'builder' };
  const context = buildNextWorkContext({ root, selected: projected, owner: 'builder', taskSource: 'projection', generatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(context.next_step.kind, 'discover');
  assert.ok(context.gaps.includes('task_snapshot_stale'));
  assert.ok(context.gaps.includes('task_snapshot_not_authoritative'));
});

test('other candidates expose recorded reasons and goal relevance without claiming business value', (t) => {
  const { root } = room(t);
  write(root, '.atris/state/scoreboard.json', JSON.stringify({ goal: 'Repair calendar retries' }));
  const { buildNextWorkContext } = require('../lib/next-work-context');
  const context = buildNextWorkContext({ root, tasks: [
    { id: 'one', title: 'Polish the toolbar', status: 'open' },
    { id: 'two', title: 'Repair calendar retries', status: 'open', metadata: { why_it_matters: 'Missing meetings after timeouts' } },
    { id: 'old', title: 'Repair calendar retries', status: 'done', metadata: { latest_agent_lesson: 'Use the existing picker', latest_agent_next_task: 'Check timeout recovery' } },
  ], taskSource: 'database' });
  assert.equal(context.candidates[0].task_id, 'two');
  assert.equal(context.candidates[0].why, 'Missing meetings after timeouts');
  assert.equal(context.recent_outcomes[0].next, 'Check timeout recovery');
  assert.match(context.selection_basis, /not measured business value/);
});

test('a bound job outside the shortlist retains its real owner', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const held = taskDb.addTask(db, { workspaceRoot: root, title: 'Calendar job held elsewhere', status: 'claimed', metadata: { verify: 'node --test test/calendar.test.js' } });
  db.prepare('UPDATE tasks SET claimed_by = ? WHERE id = ?').run('other-owner', held.id);
  for (let i = 0; i < 201; i++) taskDb.addTask(db, { workspaceRoot: root, title: `Open calendar job ${i}`, status: 'open' });
  assert.equal(promptContext(root, env, held.id).next_step.kind, 'wait');
});

test('a completed bound job remains completed and carries its result forward', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const done = taskDb.addTask(db, { workspaceRoot: root, title: 'Completed calendar lookup', status: 'done', metadata: { verify: 'node --test test/calendar.test.js', result: 'Calendar lookup is implemented', latest_agent_lesson: 'Reuse the account picker' } });
  const context = promptContext(root, env, done.id);
  assert.equal(context.next_step.kind, 'discover');
  assert.ok(context.gaps.includes('bound_task_already_finished'));
  assert.equal(context.recent_outcomes.find((row) => row.task_id === done.id).lesson, 'Reuse the account picker');
});

test('assignments constrain both the selected action and alternative candidates', (t) => {
  const { root } = room(t);
  const { buildNextWorkContext } = require('../lib/next-work-context');
  const assigned = { id: 'assigned', title: 'Calendar lookup', status: 'open', metadata: { assigned_to: 'other-owner', verify: 'node --test test/calendar.test.js' } };
  assert.equal(buildNextWorkContext({ root, selected: assigned, owner: 'builder', taskSource: 'database' }).next_step.kind, 'wait');
  assert.equal(buildNextWorkContext({ root, tasks: [assigned], owner: 'builder', taskSource: 'database' }).candidates[0].held, 'other_owner');
});

test('the latest completion contributes its lesson before older endgame outcomes in a busy queue', (t) => {
  const { root, env } = room(t);
  const db = taskDb.open(env.ATRIS_TASKS_DB);
  const old = taskDb.addTask(db, { workspaceRoot: root, title: 'Old job just completed', status: 'done', metadata: { latest_agent_lesson: 'Latest correction from the reviewer' } });
  db.prepare('UPDATE tasks SET created_at = 1, updated_at = 10000 WHERE id = ?').run(old.id);
  for (let i = 0; i < 3; i++) {
    const other = taskDb.addTask(db, { workspaceRoot: root, title: `Newer job finished earlier ${i}`, status: 'done', tag: 'endgame' });
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(100 + i, 10 + i, other.id);
  }
  for (let i = 0; i < 201; i++) taskDb.addTask(db, { workspaceRoot: root, title: `Open calendar job ${i}`, status: 'open' });
  const context = promptContext(root, env, 'unbound-current');
  assert.equal(context.recent_outcomes[0].task_id, old.id);
  assert.equal(context.recent_outcomes[0].lesson, 'Latest correction from the reviewer');
});
