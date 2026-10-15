'use strict';

// Read-only runtime comparison through the actual completion receipt writer.
// Writes evidence under atris/runs; does not change tasks or delete folders.
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeTaskReceipt } = require('../../lib/task-receipt');

const root = path.resolve(__dirname, '../..');
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const cases = [
  ['login selection', 'node --version'],
  ['parent runtime control', `${shellQuote(process.execPath)} --version`],
];
console.log(`parent runtime: ${process.execPath} ${process.version}`);
for (const [name, command] of cases) {
  const result = writeTaskReceipt({ taskId: 'completion-runtime-probe', command, root });
  assert.equal(result.exit, 0, `${name}: ${result.output || result.error}`);
  if (name === 'parent runtime control') assert.equal(result.output, process.version);
  console.log(`${name}: ${result.output}, exit ${result.exit}`);
  console.log(`command: ${command}`);
  console.log(`receipt: ${result.receiptPath}`);
}
