const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractReceiptEvidence } = require('../lib/receipt-evidence');

test('flat mission completion evidence survives an empty nested mission field', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-flat-completion-'));
  try {
    const state = path.join(root, '.atris', 'state');
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-flat-completion',
      mission: null,
      status: 'complete',
      completion_gate: { ok: false, forced: true },
    }) + '\n');
    fs.writeFileSync(path.join(runs, 'mission-flat-receipt.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-flat-completion',
      result: { kind: 'mission_tick', tick: { verifier_passed: true } },
    }) + '\n');
    const evidence = extractReceiptEvidence('Receipt: atris/runs/mission-flat-receipt.json', root);
    assert.strictEqual(evidence.any_forced, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
