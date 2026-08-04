'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasFlag, readFlag, readIntFlag, readNumberFlag } = require('../lib/arg-parser');

test('hasFlag matches only a standalone flag token', () => {
  assert.equal(hasFlag(['--json'], '--json'), true);
  assert.equal(hasFlag(['--json=true'], '--json'), false);
});

test('readFlag accepts split and inline values and removes paired quotes', () => {
  assert.equal(readFlag(['--owner', 'codex'], '--owner', ''), 'codex');
  assert.equal(readFlag(['--owner', '"codex"'], '--owner', ''), 'codex');
  assert.equal(readFlag(['--owner="codex"'], '--owner', ''), 'codex');
  assert.equal(readFlag(["--owner='codex'"], '--owner', ''), 'codex');
});

test('readFlag rejects a following flag and preserves the requested fallback', () => {
  assert.equal(readFlag(['--owner', '--json'], '--owner', 'fallback'), 'fallback');
  assert.equal(readFlag([], '--owner', null), null);
});

test('numeric readers distinguish missing, valid, and invalid values', () => {
  assert.equal(readIntFlag(['--ticks', '12px'], '--ticks', 3), 12);
  assert.equal(readIntFlag([], '--ticks', 3), 3);
  assert.equal(readIntFlag(['--ticks', 'nope'], '--ticks', 3), null);
  assert.equal(readNumberFlag(['--hours=1.5'], '--hours', 2), 1.5);
  assert.equal(readNumberFlag([], '--hours', 2), 2);
  assert.equal(readNumberFlag(['--hours', 'nope'], '--hours', 2), null);
});
