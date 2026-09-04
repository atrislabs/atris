'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ENGINE_NAMES, getEngineAdapter, normalizeEngineName } = require('../lib/bench/engines');
const { loadTaskSpecs, packMetadata, readTaskPrompt, runBench } = require('../lib/bench/runner');

const repoRoot = path.resolve(__dirname, '..');

test('bench engine adapters expose the frozen roster', () => {
  assert.deepEqual(ENGINE_NAMES, [
    'codex',
    'cursor',
    'claude',
    'atris-fast',
    'agy',
    'opencode',
    'devin',
    'null',
    'solution',
  ]);
  assert.equal(normalizeEngineName('codex'), 'codex');
  assert.equal(normalizeEngineName('opencode'), 'opencode');
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
  assert.equal(byId.get('agents-v1').taskCount, 28);
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

// Live prompt path (lesson: benchmark-prompt-paths): dry-run receipt tests use
// the solution/null engines, which never read prompt.md, so a malformed prompt
// used to pass every receipt test and only fail on a paid real-engine run.
// These assertions cover the same readTaskPrompt call the runner hands to
// real engines.
test('every agents-v1 prompt is well-formed on the live prompt path', () => {
  const specs = loadTaskSpecs({ repoRoot, pack: 'agents-v1' }).filter((spec) => spec.kind === 'agent');
  assert.ok(specs.length >= 28, `expected the full agents-v1 pack, saw ${specs.length}`);
  for (const spec of specs) {
    const prompt = readTaskPrompt(spec);
    assert.ok(prompt.trim().length >= 20, `${spec.id}: prompt too short`);
  }
  const one = specs.find((spec) => spec.id === 'find-the-bug-line');
  const promptText = readTaskPrompt(one);
  assert.match(promptText, /\w{4,}/, 'prompt carries no real instruction text');
  assert.doesNotMatch(promptText, /\{\{/, 'prompt carries unresolved template markers');
});

test('a malformed prompt fails the live path loudly instead of riding green receipts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-prompt-'));
  try {
    const emptyPrompt = path.join(dir, 'empty-prompt.md');
    fs.writeFileSync(emptyPrompt, '\n\n');
    assert.throws(
      () => readTaskPrompt({ id: 'empty-task', promptPath: emptyPrompt }),
      /empty or too short/,
    );
    const templatePrompt = path.join(dir, 'template-prompt.md');
    fs.writeFileSync(templatePrompt, 'Fix the bug described in {{TASK_DESCRIPTION}} and run the tests.\n');
    assert.throws(
      () => readTaskPrompt({ id: 'template-task', promptPath: templatePrompt }),
      /unresolved template or encoding artifacts/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
