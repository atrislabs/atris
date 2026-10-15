'use strict';

// A planned job's "cannot approve yet" line names only the plan parts that
// are really missing. Before, it always listed goal, finish line, check, and
// first move, so a job given a check was still told it needed one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { taskApprovalFor } = require('../commands/task');

function plannedTask(metadata, extra = {}) {
  return { id: 'T-1', title: 'Make the button blue', status: 'open', metadata: { stage: 'plan', ...metadata }, ...extra };
}

test('a job given a check and a finish line is only asked for what is missing', () => {
  const approval = taskApprovalFor(plannedTask({ verify: 'npm test', exit_condition: 'button is blue' }));
  const reason = approval.approve.blocked_reason;
  assert.equal(reason, 'The plan still needs a goal and a first move before approval.');
  assert.doesNotMatch(reason, /check|finish line/);
});

test('an empty plan still names all four parts', () => {
  const approval = taskApprovalFor(plannedTask({}));
  assert.equal(
    approval.approve.blocked_reason,
    'The plan still needs a goal, a finish line, a check, and a first move before approval.',
  );
});

test('a complete plan can be approved with no blocked reason', () => {
  const approval = taskApprovalFor(plannedTask({
    task_goal: 'blue button',
    exit_condition: 'button is blue',
    verify: 'npm test',
    first_move: 'edit the css',
  }));
  assert.equal(approval.approve.enabled, true);
  assert.equal(approval.approve.blocked_reason, null);
});

// A job created with its own "done looks like" line already states its
// finish line. The same screen used to print that line and then say the plan
// still needed a finish line.
function doneLine(text) {
  return {
    done_looks_like: text,
    explanation: { sources: { done_looks_like: 'explicit' }, done_looks_like: `${text}.` },
  };
}

test('a job that says what done looks like is not asked for a finish line', () => {
  const approval = taskApprovalFor(plannedTask({ verify: 'npm test', ...doneLine('The button is blue') }));
  assert.equal(approval.approve.blocked_reason, 'The plan still needs a goal and a first move before approval.');
});

test('a derived done line does not count as a finish line', () => {
  const approval = taskApprovalFor(plannedTask({
    verify: 'npm test',
    explanation: { sources: { done_looks_like: 'derived' }, done_looks_like: 'The required check passes.' },
  }));
  assert.match(approval.approve.blocked_reason, /a finish line/);
});

test('planning a job uses its done line when no finish line is passed', () => {
  const taskDb = require('../lib/task-db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plan-done-line-'));
  try {
    taskDb.close();
    const db = taskDb.open(path.join(dir, 'tasks.db'));
    const ws = taskDb.workspaceRoot(dir);
    const { id } = taskDb.addTask(db, {
      title: 'Make the button blue',
      workspaceRoot: ws,
      metadata: { verify: 'npm test', ...doneLine('The button is blue') },
    });
    const planned = taskDb.stageTask(db, { id, actor: 'builder', stage: 'plan', goal: 'blue button' });
    assert.equal(planned.staged, true, `plan refused: ${planned.reason}`);
    assert.match(taskDb.getTask(db, id).metadata.exit_condition, /^The button is blue\.?$/);

    const bare = taskDb.addTask(db, { title: 'No done line', workspaceRoot: ws, metadata: { verify: 'npm test' } });
    const refused = taskDb.stageTask(db, { id: bare.id, actor: 'builder', stage: 'plan', goal: 'something' });
    assert.equal(refused.reason, 'exit_required');
  } finally {
    taskDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The approve line is meant to be pasted into a shell. A first move with a
// dollar sign or backticks used to sit inside double quotes, so pasting it
// ran a command and changed the words before the job started.
test('the approve line survives a real shell with quotes, dollars, and backticks intact', () => {
  const { execFileSync } = require('node:child_process');
  const firstMove = 'change "$PRICE" to `total` and say it\'s done!';
  const approval = taskApprovalFor(plannedTask({
    task_goal: 'real cost',
    exit_condition: 'price shows',
    verify: 'npm test',
    first_move: firstMove,
  }, { claimed_by: 'builder' }));
  assert.equal(approval.approve.enabled, true);
  const args = approval.approve.command.replace(/^atris /, '');
  const out = execFileSync('/bin/sh', ['-c', `set -- ${args}; printf '%s\\n' "$@"`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', PRICE: 'WRONG' },
  });
  assert.deepEqual(out.trimEnd().split('\n'), ['task', 'do', 'T1', '--as', 'builder', '--first-move', firstMove]);
});

test('a plain first move keeps its easy-to-read double quotes', () => {
  const approval = taskApprovalFor(plannedTask({
    task_goal: 'blue button', exit_condition: 'button is blue', verify: 'npm test', first_move: 'edit the css',
  }, { claimed_by: 'builder' }));
  assert.equal(approval.approve.command, 'atris task do T1 --as builder --first-move "edit the css"');
});
