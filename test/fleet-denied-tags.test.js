const test = require('node:test');
const assert = require('node:assert');
const { DENIED_TAGS, isSafeLane, protectedLaneOfTask, staffFlight } = require('../lib/fleet');

test('money and payments tags are denied lanes, same as billing', () => {
  for (const tag of ['money', 'payments', 'billing']) {
    assert.ok(DENIED_TAGS.includes(tag), `${tag} must be a denied lane`);
  }
});

// Landing and the ship gate ask protectedLaneOfTask, which also reads the tags a
// task was imported with from TODO.md (metadata.todo_tags). Staffing has to ask the
// same function, or the fleet builds a task it can then never merge.
test('a task protected only through metadata.todo_tags is not a safe lane', () => {
  const base = {
    display_id: 'CLI-902',
    status: 'open',
    title: 'Wire up the widget in commands/widget.js. Done: it renders. Check: node --test test/widget.test.js.',
  };
  // Control: with no tags the task is a safe lane and gets staffed.
  assert.equal(isSafeLane(base), true);
  assert.equal(staffFlight([base], { slots: 3 }).length, 1);

  // The lane lives only in todo_tags, none of the task's own tag fields.
  for (const [todoTags, lane] of [
    [['security'], 'security'],
    [['Deploy'], 'deploy'],
    [[' billing '], 'billing'],
    [['docs', 'payments'], 'payments'],
  ]) {
    const task = { ...base, tag: 'code', metadata: { todo_tags: todoTags } };
    assert.equal(protectedLaneOfTask(task), lane, `landing protects ${JSON.stringify(todoTags)}`);
    assert.equal(isSafeLane(task), false, `${JSON.stringify(todoTags)} must not be a safe lane`);
    assert.equal(staffFlight([task], { slots: 3 }).length, 0, `${JSON.stringify(todoTags)} must not be staffed`);
  }

  // todo_tags that name no protected lane leave the task staffable.
  const docs = { ...base, tag: 'code', metadata: { todo_tags: ['docs', 'cleanup'] } };
  assert.equal(protectedLaneOfTask(docs), null);
  assert.equal(isSafeLane(docs), true);
  assert.equal(staffFlight([docs], { slots: 3 }).length, 1);

  // Empty or missing todo_tags change nothing and never crash the pick.
  for (const todoTags of [[], null, undefined]) {
    const task = { ...base, metadata: { todo_tags: todoTags } };
    assert.equal(protectedLaneOfTask(task), null, `todo_tags ${JSON.stringify(todoTags)} is not a lane`);
    assert.equal(isSafeLane(task), true);
  }
  assert.equal(isSafeLane({ ...base, metadata: {} }), true);

  // The human-hold rule still applies on top, whatever the lane.
  assert.equal(isSafeLane({ ...base, metadata: { tags: ['needs-human'], todo_tags: ['docs'] } }), false);
});
