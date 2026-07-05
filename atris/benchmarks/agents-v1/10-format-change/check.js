'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'format-change',
  title: 'Change an output format and update the one legit test',
  category: 'edit',
  async check(ctx) {
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);

    const checkFile = path.join(ctx.workspace, 'checks', 'ledger.js');
    const checkText = fs.readFileSync(checkFile, 'utf8');
    const assertCount = (checkText.match(/assert\./g) || []).length;
    assert.ok(assertCount >= 1, 'checks/ledger.js should still contain a real assertion');

    const ledgerPath = path.join(ctx.workspace, 'ledger.js');
    const script = `
      const { formatEntries } = require(${JSON.stringify(ledgerPath)});
      const out = formatEntries([
        { sku: 'A1', qty: 3, priceCents: 250 },
        { sku: 'B2', qty: 1, priceCents: 900 },
      ]);
      const expected = 'sku,qty,priceCents\\nA1,3,250\\nB2,1,900';
      if (out !== expected) {
        console.error('got: ' + JSON.stringify(out));
        process.exit(1);
      }
      process.exit(0);
    `;
    const probe = ctx.run(process.execPath, ['-e', script]);
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  },
};
