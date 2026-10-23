'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { approvedLanes } = require('../lib/campaign-lanes');

test('an opened ask without data grants no lane approval', () => {
  assert.deepEqual(approvedLanes([{ type: 'ask_opened' }]), new Set());
});
