const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractReceiptEvidence } = require('../lib/receipt-evidence');

test('receipt with forced completion gate is marked forced and not clean passing evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  try {
    const runsDir = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, 'receipt.json'),
      JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        result: { passed: true },
        completion_gate: { forced: true },
      }),
    );

    const evidence = extractReceiptEvidence('atris/runs/receipt.json', dir);
    assert.strictEqual(evidence?.receipts?.[0]?.forced, true);
    assert.strictEqual(evidence?.any_forced, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
