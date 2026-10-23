'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { swapList } = require('../lib/roster-swap');

test('swap list preserves an offered model name when normalization rejects it', () => {
  const tools = [{ engine: 'claude', tool: 'claude code', models: ['custom-model'] }];
  const result = swapList(undefined, {
    offer: { tools, shortlist: [] },
  });

  assert.deepEqual(result.options, [{
    engine: 'claude',
    tool: 'claude code',
    model: 'custom-model',
    label: 'custom-model',
  }]);
});
