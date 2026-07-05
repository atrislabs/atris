set -eu
cat > convert.js <<'JS'
'use strict';

function toBaseUnits(value, unit) {
  const factors = { m: 1, km: 1000, ft: 0.3048, mi: 1609.34 };
  const factor = factors[unit];
  if (!factor) throw new Error(`unknown unit: ${unit}`);
  return value * factor;
}

module.exports = { toBaseUnits };
JS
cat > cli.js <<'JS'
'use strict';

const { toBaseUnits } = require('./convert');

const [, , amountArg, unitArg] = process.argv;
const amount = Number(amountArg);
console.log(toBaseUnits(amount, unitArg).toFixed(2));
JS
cat > checks/convert.js <<'JS'
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toBaseUnits } = require('../convert');

test('converts km to meters', () => {
  assert.equal(toBaseUnits(2, 'km'), 2000);
});
JS
