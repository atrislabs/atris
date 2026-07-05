'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

module.exports = {
  id: 'mission-lifecycle',
  title: 'Mission start, tick, receipt, and complete lifecycle stays parseable',
  timeoutMs: 30000,
  async run(ctx) {
    const verifier = `${process.execPath} -e "process.exit(0)"`;
    const started = parseJson(ctx.runCli([
      'mission', 'start', 'Bench receipts keep mission proof reviewable',
      '--owner', 'mission-lead',
      '--verify', verifier,
      '--json',
    ]));
    assert.ok(['planning', 'ready', 'running'].includes(started.mission.status));
    assert.ok(started.mission.id);

    const ticked = parseJson(ctx.runCli([
      'mission', 'tick', started.mission.id,
      '--summary', 'Operators can audit the receipt because the verifier passed; layer: capabilities',
      '--verify',
      '--json',
    ]));
    assert.equal(ticked.verifier_result.passed, true);
    assert.equal(ticked.tick.layer, 'capabilities');
    assert.ok(ticked.receipt_path);
    const receiptPath = path.join(ctx.workspace, ticked.receipt_path);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.schema, 'atris.mission_receipt.v1');
    assert.equal(receipt.result.tick.verifier_passed, true);

    const completed = parseJson(ctx.runCli(['mission', 'complete', started.mission.id, '--proof', ticked.receipt_path, '--json']));
    assert.equal(completed.mission.status, 'complete');
    const ledger = fs.readFileSync(path.join(ctx.workspace, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(ledger.some((row) => row.id === started.mission.id && row.status === 'complete'));
  },
};
