'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { engineTerminalReason } = require('../lib/engine-job-lifecycle');

test('an explicit failure preserves its supplied reason', () => {
  assert.strictEqual(
    engineTerminalReason({ ok: false, reason: 'permission_denied' }),
    'permission_denied',
  );
});
