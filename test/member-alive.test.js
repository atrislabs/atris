'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAliveTick } = require('../lib/member-alive');

test('alive dry-run plans without execute', () => {
  const tick = runAliveTick('__missing_member__', { execute: false, confirmed: false });
  assert.equal(tick.mode, 'dry_run');
  assert.equal(tick.operate.skipped, true);
  assert.equal(tick.auto_accept.skipped, true);
});
