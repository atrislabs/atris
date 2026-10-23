'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { unreadableMissionGuard } = require('../lib/mission-protected-lane');

test('an Error input pauses for retry and carries the error message', () => {
  const result = unreadableMissionGuard(new Error('git diff blew up'));

  assert.equal(result.ok, false);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'paused-for-retry');
  assert.equal(result.unreadable, true);
  assert.equal(result.detail, 'git diff blew up');
  assert.equal(
    result.reason,
    'mission diff could not be read; repair the tooling failure and rerun',
  );
  assert.deepEqual(result.surfaces, ['unreadable diff']);
  assert.deepEqual(result.matches, []);
});

test('a non-Error input is stringified into the detail field', () => {
  const result = unreadableMissionGuard('spawn git ENOENT');

  assert.equal(result.ok, false);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'paused-for-retry');
  assert.equal(result.unreadable, true);
  assert.equal(result.detail, 'spawn git ENOENT');
  assert.deepEqual(result.surfaces, ['unreadable diff']);
});

test('a missing input falls back to the unknown-failure detail', () => {
  for (const input of [undefined, null, '', 0]) {
    const result = unreadableMissionGuard(input);

    assert.equal(result.ok, false);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 'paused-for-retry');
    assert.equal(result.unreadable, true);
    assert.equal(result.detail, 'unknown diff read failure');
    assert.deepEqual(result.surfaces, ['unreadable diff']);
    assert.deepEqual(result.matches, []);
  }
});

test('an object with a message uses it, one without stringifies itself', () => {
  const withMessage = unreadableMissionGuard({ message: 'custom failure' });
  assert.equal(withMessage.detail, 'custom failure');

  const withoutMessage = unreadableMissionGuard({ code: 'ENOENT' });
  assert.equal(withoutMessage.detail, '[object Object]');
});
