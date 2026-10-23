const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCard } = require('../lib/receipt-block');

test('a nested Claude summary supplies the headline when no direct summary exists', () => {
  const receipt = {
    objective: 'Improve account access',
    result: {
      tick: {
        status: 'ran',
        claude: { summary: 'Invite checks now block unauthorized accounts.' },
      },
    },
  };

  assert.match(renderCard(receipt).headline, /Invite checks/);
});
