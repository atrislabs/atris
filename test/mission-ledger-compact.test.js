'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactMissionLedger, compactRows } = require('../lib/mission-ledger-compact');

function tempLedger(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ledger-compact-'));
  const file = path.join(dir, 'missions.jsonl');
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
}

test('compaction keeps the latest state, the first display number, and first-seen order', () => {
  const rows = [
    { id: 'a', n: 7, status: 'planning' },
    { id: 'b', status: 'ready' },
    { id: 'a', n: 99, status: 'ready' },
    { id: 'b', n: 12, status: 'complete' },
    { id: 'a', status: 'complete', proof: 'atris/runs/new-receipt.json' },
  ];
  const compacted = compactRows(rows);
  assert.deepEqual(compacted.map((row) => row.id), ['a', 'b']);
  assert.equal(compacted[0].status, 'complete');
  assert.equal(compacted[0].n, 7, 'first assigned number survives, later renumber attempts do not');
  assert.equal(compacted[0].proof, 'atris/runs/new-receipt.json');
  assert.equal(compacted[1].status, 'complete');
  assert.equal(compacted[1].n, 12, 'a number assigned later still sticks');
});

test('below the ratio threshold the file is left untouched', () => {
  const rows = Array.from({ length: 70 }, (unused, i) => ({ id: `m${i}`, status: 'ready' }));
  const file = tempLedger(rows);
  const before = fs.readFileSync(file, 'utf8');
  const receipt = compactMissionLedger(file, { minBytes: 0 });
  assert.equal(receipt.compacted, false);
  assert.equal(receipt.reason, 'below_threshold');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('history-heavy ledger compacts to one row per mission and shrinks on disk', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    for (let save = 0; save < 10; save += 1) {
      rows.push({ id: `m${i}`, n: i + 1, status: save === 9 ? 'complete' : 'running', tick: save });
    }
  }
  const file = tempLedger(rows);
  const receipt = compactMissionLedger(file, { minBytes: 0 });
  assert.equal(receipt.compacted, true);
  assert.equal(receipt.rows_before, 200);
  assert.equal(receipt.rows_after, 20);
  assert.ok(receipt.bytes_after < receipt.bytes_before);
  const survived = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(survived.length, 20);
  assert.ok(survived.every((row) => row.status === 'complete' && row.tick === 9));
});

test('rows without an id (cloud mission receipts) survive compaction in order', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({ cloud: true, task_id: `t${i}`, text: `receipt ${i}` });
    for (let save = 0; save < 10; save += 1) rows.push({ id: `m${i}`, status: 'running', tick: save });
  }
  const file = tempLedger(rows);
  const receipt = compactMissionLedger(file, { minBytes: 0 });
  assert.equal(receipt.compacted, true);
  const survived = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const cloudRows = survived.filter((row) => row.cloud === true);
  assert.equal(cloudRows.length, 30, 'every cloud receipt survives');
  assert.equal(cloudRows[29].task_id, 't29', 'cloud order preserved so latest-receipt readers still work');
  assert.equal(survived.filter((row) => row.id).length, 30, 'missions still compact to one row each');
});

test('malformed lines are dropped by compaction, not crashed on', () => {
  const file = tempLedger([]);
  const junk = Array.from({ length: 80 }, () => JSON.stringify({ id: 'x', status: 'running' }));
  fs.writeFileSync(file, `${junk.join('\n')}\nnot json at all\n{"broken": \n`, 'utf8');
  const receipt = compactMissionLedger(file, { minBytes: 0 });
  assert.equal(receipt.compacted, true);
  assert.equal(receipt.rows_after, 1);
});

test('a missing ledger reports missing instead of throwing', () => {
  const receipt = compactMissionLedger(path.join(os.tmpdir(), 'atris-ledger-compact-none', 'missions.jsonl'));
  assert.equal(receipt.compacted, false);
  assert.equal(receipt.reason, 'missing');
});
