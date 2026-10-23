'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../commands/usage');

test('renders metrics instead of filtering them out', () => {
  const render = mod[Object.keys(mod).find((k) => k.startsWith('render'))];
  const out = render({ requests: 42 });
  assert.ok(out.includes('requests: 42'));
});
