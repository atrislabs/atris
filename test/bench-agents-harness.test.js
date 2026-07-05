'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ENGINE_NAMES, getEngineAdapter, normalizeEngineName } = require('../lib/bench/engines');
const { packMetadata, runBench } = require('../lib/bench/runner');

const repoRoot = path.resolve(__dirname, '..');

test('bench engine adapters expose the frozen roster', () => {
  assert.deepEqual(ENGINE_NAMES, [
    'codex',
    'cursor',
    'claude',
    'atris-fast',
    'null',
    'solution',
  ]);
  assert.equal(normalizeEngineName('codex'), 'codex');
  assert.equal(getEngineAdapter('null').run('ignored', process.cwd(), 1).status, 0);
  assert.throws(() => normalizeEngineName('missing'), /unknown bench engine/);
});

test('unavailable real engines skip every selected task symmetrically', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-agent-skip-'));
  try {
    const { record, exitCode } = await runBench({
      repoRoot,
      pack: 'agents-v1',
      engine: 'atris-fast',
      taskIds: ['find-the-bug-line', 'add-json-flag'],
      stateRoot,
      persist: false,
    });
    assert.equal(exitCode, 0, JSON.stringify(record, null, 2));
    assert.deepEqual(record.passed, []);
    assert.deepEqual(record.failed, []);
    assert.deepEqual(record.skipped, ['find-the-bug-line', 'add-json-flag']);
    assert.equal(record.summary, '0/0 gate cases passed');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('bench pack discovery lists core-v1 and agents-v1', () => {
  const packs = packMetadata({ repoRoot });
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  assert.equal(byId.get('core-v1').default, true);
  assert.equal(byId.get('agents-v1').taskCount, 25);
});

test('agents-v1 result records include pack and engine fields', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-agent-record-'));
  try {
    const { record, exitCode } = await runBench({
      repoRoot,
      pack: 'agents-v1',
      engine: 'solution',
      taskIds: ['add-json-flag'],
      stateRoot,
      persist: false,
    });
    assert.equal(exitCode, 0, JSON.stringify(record, null, 2));
    assert.equal(record.schema, 'atris.bench.run.v1');
    assert.equal(record.pack, 'agents-v1');
    assert.equal(record.engine, 'solution');
    assert.deepEqual(record.passed, ['add-json-flag']);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
