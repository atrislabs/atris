const test = require('node:test');
const assert = require('node:assert/strict');

const { renderEmailLine, renderCard } = require('../lib/receipt-block');

test('a verifier result that is not a plain object is ignored, not read as a failed check', () => {
  const receipt = {
    mission_id: 'm1',
    objective: 'OBJ',
    at: '2026-07-09T15:30:00.000Z',
    result: {
      landing: { status: 'proof_ready', changed: 'Changed', next: 'Next' },
      verifier_result: [],
    },
  };

  assert.equal(renderCard(receipt).sub, '');
  assert.doesNotMatch(renderEmailLine(receipt), /check it/i);
});
