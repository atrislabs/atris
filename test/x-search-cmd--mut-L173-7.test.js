'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXSearchArgs } = require('../commands/x-search');

test('person without arguments returns the exact help options', () => {
  assert.deepEqual(parseXSearchArgs(['person']), {
    mode: 'person',
    help: true,
    json: false,
    save: false,
    check: true,
    name: null,
    handle: null,
    company: null,
    context: null,
    timeoutMs: 120000,
  });
});
