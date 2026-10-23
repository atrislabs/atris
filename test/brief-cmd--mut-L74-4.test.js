'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../commands/brief');

test('operator title boundary retains trailing content when space equals limit threshold', () => {
  const render = mod[Object.keys(mod).find((k) => k.startsWith('render') && !k.endsWith('Html'))];
  const title = 'word '.repeat(15) + 'ab ' + 'tail'.repeat(20);
  const out = render({ landed: [{ title }] });
  assert.ok(out.includes('tail'));
});
