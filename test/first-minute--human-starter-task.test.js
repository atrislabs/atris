'use strict';

// humanStarterTask picks the onboarding task a person is working on. It takes
// only the task list, so the tests pass fixed timestamps and never touch the
// clock, the filesystem, or the environment.

const { test } = require('node:test');
const assert = require('node:assert');
const { humanStarterTask } = require('../lib/first-minute');

const starterBySource = (fields) => ({
  metadata: { source: 'context_gatherer' },
  ...fields,
});

const starterByTag = (fields) => ({
  tag: 'onboarding',
  ...fields,
});

test('picks the newest starter task the person claimed', () => {
  const older = starterBySource({ id: 'older', status: 'claimed', claimed_by: 'maya', updated_at: 1000 });
  const newest = starterByTag({ id: 'newest', status: 'review', claimed_by: 'maya', updated_at: 3000 });
  const otherPerson = starterBySource({ id: 'other', status: 'claimed', claimed_by: 'sam', updated_at: 5000 });
  const notStarter = { id: 'seed', metadata: { source: 'init_seed' }, status: 'claimed', claimed_by: 'maya', updated_at: 9000 };
  const wrongStatus = starterBySource({ id: 'done', status: 'done', claimed_by: 'maya', updated_at: 8000 });

  const picked = humanStarterTask([older, otherPerson, notStarter, wrongStatus, newest], 'maya');

  assert.strictEqual(picked, newest);
  assert.strictEqual(picked.id, 'newest');
});

test('falls back to the newest starter in the list when the person has none', () => {
  const maya = starterBySource({ id: 'maya', status: 'claimed', claimed_by: 'maya', updated_at: 1000 });
  const sam = starterBySource({ id: 'sam', status: 'claimed', claimed_by: 'sam', updated_at: 5000 });
  const tasks = [maya, sam];

  assert.strictEqual(humanStarterTask(tasks, 'nobody').id, 'sam');
  assert.strictEqual(humanStarterTask(tasks, '').id, 'sam');
  assert.strictEqual(humanStarterTask(tasks).id, 'sam');
});

test('returns null for empty, missing, or non-list input', () => {
  assert.strictEqual(humanStarterTask([]), null);
  assert.strictEqual(humanStarterTask([], 'maya'), null);
  assert.strictEqual(humanStarterTask(undefined, 'maya'), null);
  assert.strictEqual(humanStarterTask(null, 'maya'), null);
  assert.strictEqual(humanStarterTask('not a list', 'maya'), null);
});

test('returns null when no task is a starter, even if it is claimed by the person', () => {
  const seed = { id: 'seed', metadata: { source: 'init_seed' }, status: 'claimed', claimed_by: 'maya', updated_at: 1000 };
  const plain = { id: 'plain', status: 'claimed', claimed_by: 'maya', updated_at: 2000 };

  assert.strictEqual(humanStarterTask([seed, plain], 'maya'), null);
});

test('the statuses option replaces the default claimed and review list', () => {
  const done = starterBySource({ id: 'done', status: 'done', claimed_by: 'maya', updated_at: 4000 });
  const claimed = starterBySource({ id: 'claimed', status: 'claimed', claimed_by: 'maya', updated_at: 6000 });

  assert.strictEqual(humanStarterTask([done, claimed], 'maya').id, 'claimed');
  assert.strictEqual(humanStarterTask([done, claimed], 'maya', { statuses: ['done'] }).id, 'done');
  assert.strictEqual(humanStarterTask([done], 'maya', { statuses: [] }), null);
});

test('trims the person name before matching claimed_by', () => {
  const maya = starterBySource({ id: 'maya', status: 'claimed', claimed_by: 'maya', updated_at: 1000 });
  const sam = starterBySource({ id: 'sam', status: 'claimed', claimed_by: 'sam', updated_at: 5000 });

  assert.strictEqual(humanStarterTask([maya, sam], '  maya  ').id, 'maya');
});

test('ranks by created_at when updated_at is missing', () => {
  const early = starterBySource({ id: 'early', status: 'claimed', claimed_by: 'maya', created_at: 100 });
  const late = starterBySource({ id: 'late', status: 'claimed', claimed_by: 'maya', created_at: 200 });

  assert.strictEqual(humanStarterTask([late, early], 'maya').id, 'late');
});

test('does not reorder the caller array', () => {
  const first = starterBySource({ id: 'first', status: 'claimed', claimed_by: 'maya', updated_at: 1000 });
  const second = starterBySource({ id: 'second', status: 'claimed', claimed_by: 'maya', updated_at: 2000 });
  const tasks = [first, second];

  assert.strictEqual(humanStarterTask(tasks, 'maya').id, 'second');
  assert.deepStrictEqual(tasks.map((task) => task.id), ['first', 'second']);
});
