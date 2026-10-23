'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSimulationArgs } = require('../lib/business-simulate');

test('a trailing --name reports the exact missing-value error', () => {
  assert.throws(() => parseSimulationArgs(['a coffee cart', '--name']), {
    name: 'Error',
    message: 'Missing value for --name.\nUsage: atris business simulate "<idea>" [--roles a,b,c,d] [--name <business name>] [--dry-run]',
  });
});
