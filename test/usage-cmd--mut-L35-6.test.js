'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUsage } = require('../commands/usage');

test('a null usage metric remains visible as null', () => {
  const output = renderUsage({ usage: { remaining: null } });
  const metric = output.split('\n').find((line) => line.startsWith('remaining:'));
  assert.strictEqual(metric?.split(':')[1].trim(), 'null');
});
