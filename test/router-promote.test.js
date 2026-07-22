'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  groupPicksBySignature,
  nextLane,
  promotionCandidates,
  routerCommand,
} = require('../commands/router');

function missRecords(count, options = {}) {
  const lane = options.lane || 'fast';
  const first = options.first || 'what is';
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const pickId = `pick-${lane}-${index}`;
    records.push({
      at: new Date().toISOString(),
      pick_id: pickId,
      lane,
      message: `${first} example ${index}`,
    });
    records.push({
      event: 'outcome',
      pick_id: pickId,
      ok: false,
      error: 'miss',
    });
  }
  return records;
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test('groupPicksBySignature joins outcomes by pick id', () => {
  const records = [
    ...missRecords(2),
    { at: new Date().toISOString(), pick_id: 'other', lane: 'pro', message: 'draft this update' },
    { event: 'outcome', pick_id: 'other', ok: true, error: null },
  ];
  const groups = groupPicksBySignature(records);
  assert.equal(groups.get('what is|fast').picks.length, 2);
  assert.equal(groups.get('what is|fast').bad_picks.length, 2);
  assert.equal(groups.get('draft this|pro').bad_picks.length, 0);
});

test('promotion requires three bad picks on one signature and lane', () => {
  assert.equal(promotionCandidates(missRecords(2)).length, 0);
  const candidates = promotionCandidates(missRecords(3));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].from_lane, 'fast');
  assert.equal(candidates[0].override.lane, 'pro');
  assert.equal(candidates[0].override.reason, 'learned from 3 misses');
  assert.deepEqual(candidates[0].override.test, { startsWith: 'what is' });
});

test('lane ladder promotes fast and pro while code-fast jumps to max', () => {
  assert.equal(nextLane('fast'), 'pro');
  assert.equal(nextLane('pro'), 'max');
  assert.equal(nextLane('code-fast'), 'max');
  assert.equal(nextLane('max'), null);
});

test('promotion gate rejects an override that regresses weighted gold accuracy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-promote-'));
  try {
    const picksPath = path.join(dir, 'picks.jsonl');
    const overridesPath = path.join(dir, 'overrides.json');
    const goldPath = path.join(dir, 'gold.jsonl');
    writeJsonl(picksPath, missRecords(3));
    writeJsonl(goldPath, [
      { message: 'what is alpha', lane: 'fast' },
      { message: 'what is beta', lane: 'fast' },
      { message: 'what is gamma', lane: 'fast' },
    ]);
    fs.writeFileSync(overridesPath, '[]\n', 'utf8');
    const output = [];
    const code = routerCommand([
      'promote',
      '--picks', picksPath,
      '--overrides', overridesPath,
      '--gold', goldPath,
    ], {
      env: { ...process.env, HOME: dir },
      output: (line) => output.push(line),
    });
    assert.equal(code, 0);
    assert.match(output.join('\n'), /revert .*candidate rejected/);
    assert.deepEqual(JSON.parse(fs.readFileSync(overridesPath, 'utf8')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
