'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harvestCommand } = require('../commands/harvest');

test('a null landing proof produces a repair action without a rendered null marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-harvest-null-proof-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const logs = [];
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'receipt.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      objective: 'Publish the preview',
      result: { landing: { proof: null } },
    }));
    process.chdir(root);
    console.log = (line) => logs.push(line);

    const expected = {
      ok: true,
      action: 'harvest',
      write: false,
      count: 1,
      actions: [{
        id: 'I1',
        title: 'Repair proof mismatch where proof exists in metadata but renders as null',
        source: 'receipt',
        reason: 'Publish the preview',
        evidence: path.join('atris', 'runs', 'receipt.json'),
      }],
      writes: [],
    };
    assert.deepStrictEqual(harvestCommand(['--json']), expected);
    assert.deepStrictEqual(logs, [JSON.stringify(expected, null, 2)]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
