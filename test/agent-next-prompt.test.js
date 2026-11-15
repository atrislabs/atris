'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const taskDb = require('../lib/task-db');
const { currentWorkPrompt } = require('../lib/member-context');

function room(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-next-prompt-')));
  fs.mkdirSync(path.join(dir, 'atris'));
  const oldDb = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
  const db = taskDb.open();
  t.after(() => {
    taskDb.close();
    if (oldDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = oldDb;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    root: dir,
    add: (values) => taskDb.addTask(db, { workspaceRoot: taskDb.workspaceRoot(dir), ...values }),
    get: (id) => taskDb.getTask(db, id),
  };
}
function recommendation(prompt) {
  const line = prompt.split('\n').find((value) => value.startsWith('Agent next: '));
  assert.ok(line);
  return JSON.parse(line.slice('Agent next: '.length));
}

test('an unbound worker prompt can plan owned work while human acceptance stays pending', (t) => {
  const c = room(t);
  const prior = c.add({ title: 'Human acceptance pending', status: 'review', metadata: { agent_certified: true } });
  const work = c.add({ title: 'Inspect saved note behavior', metadata: { assigned_to: 'builder' } });
  const prompt = currentWorkPrompt(c.root, { owner: 'builder', objective: 'Make saved notes reliable' });
  const next = recommendation(prompt);
  assert.equal(next.task_id, work.id);
  assert.equal(next.action, 'plan');
  assert.ok(next.needs.includes('runnable_check'));
  assert.ok(next.human_pending.some((task) => task.task_id === prior.id));
  assert.equal(c.get(prior.id).status, 'review');
  assert.equal(c.get(work.id).status, 'open');
});

test('a bound review cannot be silently replaced by a different open task', (t) => {
  const c = room(t);
  const bound = c.add({ title: 'Bound result awaiting acceptance', status: 'review', metadata: { agent_certified: true } });
  const other = c.add({ title: 'A different task', metadata: { assigned_to: 'builder' } });
  const prompt = currentWorkPrompt(c.root, { owner: 'builder', xp_task: { task_id: bound.id } });
  const next = recommendation(prompt);
  assert.equal(next.task_id, bound.id);
  assert.equal(next.action, 'blocked');
  assert.match(next.command, /^atris task page /);
  assert.ok(!next.command.includes(other.id));
  assert.match(prompt, /"kind":"human_decision"/);
});

test('missing and completed bindings stay bound instead of resurrecting or manufacturing work', (t) => {
  const c = room(t);
  const done = c.add({ title: 'Finished note repair', status: 'done' });
  c.add({ title: 'Different open task', metadata: { assigned_to: 'builder' } });
  for (const id of [done.id, 'missing-binding']) {
    const prompt = currentWorkPrompt(c.root, { owner: 'builder', xp_task: { task_id: id } });
    const next = recommendation(prompt);
    assert.equal(next.action, 'blocked');
    assert.equal(next.task_id, id === done.id ? done.id : null);
    assert.equal(next.safety.human_accept, false);
  }
});
