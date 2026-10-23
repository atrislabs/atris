'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultObjectiveRunner } = require('../lib/default-runner');

test('ignores an inherited goal flag beyond the argument array length', () => {
  const args = [];
  const prototype = Object.create(Array.prototype);
  prototype[0] = '--native-goal-status=active';
  Object.setPrototypeOf(args, prototype);

  assert.equal(defaultObjectiveRunner(args, {}), 'claude');
});
