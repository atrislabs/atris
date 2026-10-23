'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { engineRunsView } = require('../lib/roster-models');

test('mercury without a pin runs its own default', () => {
  const view = engineRunsView('mercury');
  assert.equal(view.model_source, 'own default');
  assert.equal(view.model, '');
});
