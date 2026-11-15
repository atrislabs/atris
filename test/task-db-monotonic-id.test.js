'use strict';

// Task ids sort in the order they were made, even within one millisecond,
// so "oldest first" lists never flip two tasks made at the same moment.

const test = require('node:test');
const assert = require('node:assert/strict');
const tasks = require('../lib/task-db');

test('task ids: many made in the same millisecond sort in the order they were made', () => {
  const ids = [];
  const started = Date.now();
  while (ids.length < 2000) ids.push(tasks._newIdForTest());
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([...ids].sort(), ids, 'sorted equals made order');
  assert.equal(new Set(ids).size, ids.length, 'all different');
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const samePrefix = ids.filter((id, i) => i && id.slice(0, 10) === ids[i - 1].slice(0, 10));
  assert.ok(samePrefix.length > 0, 'the check really covered ids made in one millisecond');
});
