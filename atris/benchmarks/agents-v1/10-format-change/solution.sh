set -eu
cat > ledger.js <<'JS'
'use strict';

function formatEntries(entries) {
  const header = 'sku,qty,priceCents';
  const lines = entries.map((e) => `${e.sku},${e.qty},${e.priceCents}`);
  return [header, ...lines].join('\n');
}

module.exports = { formatEntries };
JS
cat > checks/ledger.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEntries } = require('../ledger');

test('formats entries as csv with a header row', () => {
  assert.equal(
    formatEntries([{ sku: 'A1', qty: 3, priceCents: 250 }]),
    'sku,qty,priceCents\nA1,3,250',
  );
});
JS
