'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeVoiceCard } = require('../lib/voice-card');

test('custom specificity principle survives voice card composition', () => {
  const card = composeVoiceCard(
    '## voice\n\n- **Specific over buzzy** Use concrete names for customer actions.\n',
  );

  assert.match(card, /concrete names for customer actions/);
});
