'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EFFORT_LEVELS } = require('../lib/effort-router');
const { buildEngineArgs, getEngineAdapter } = require('../lib/bench/engines');
const { BenchInfraError, normalizeBenchEffort, runBench, runBenchPair } = require('../lib/bench/runner');

test('engine arguments and adapters respect supported effort', () => {
  const opts = { promptText: 'prompt', workspaceDir: '/work', model: 'model', effort: 'low' };
  assert.deepEqual(buildEngineArgs('claude', opts), ['-p', 'prompt', '--dangerously-skip-permissions', '--model', 'model', '--effort', 'low']);
  assert.deepEqual(buildEngineArgs('codex', opts), ['exec', '--dangerously-bypass-approvals-and-sandbox', '--model', 'model', '-c', 'model_reasoning_effort=low', '-C', '/work', 'prompt']);
  for (const name of ['claude', 'codex']) {
    const adapter = getEngineAdapter(name, { model: ' model ', effort: 'low' });
    assert.equal(adapter.model, 'model');
    assert.equal(adapter.effort, 'low');
  }
  assert.deepEqual(buildEngineArgs('cursor', opts), ['--trust', '-p', 'prompt']);
  assert.deepEqual(buildEngineArgs('devin', opts), ['-p', '--permission-mode', 'dangerous', '--model', 'model', '--', 'prompt']);
  for (const name of ['cursor', 'devin']) assert.equal(getEngineAdapter(name, opts).effort, null);
});

test('normalizes valid effort and rejects invalid input', () => {
  for (const level of EFFORT_LEVELS) assert.equal(normalizeBenchEffort(` ${level.toUpperCase()} `), level);
  for (const value of [undefined, null, '']) assert.equal(normalizeBenchEffort(value), null);
  assert.throws(() => normalizeBenchEffort('turbo'), BenchInfraError);
});

test('runs record effort and paired runs send each effort to the engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-effort-'));
  const oldPath = process.env.PATH;
  try {
    const task = path.join(root, 'tasks', 'one');
    const bin = path.join(root, 'bin');
    const tree = path.join(root, 'tree');
    const log = path.join(root, 'args');
    fs.mkdirSync(path.join(task, 'fixture'), { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(tree, 'atris.md'), 'tree\n');
    fs.writeFileSync(path.join(task, 'prompt.md'), 'Please inspect this benchmark fixture carefully.\n');
    fs.writeFileSync(path.join(task, 'solution.sh'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(task, 'check.js'), "module.exports = { id: 'one', title: 'One', category: 'test', check() {} };\n");
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    const options = { repoRoot: root, stateRoot: root, tasksDir: path.join(root, 'tasks'), engine: 'codex', persist: false };
    const withEffort = await runBench({ ...options, effort: 'LOW' });
    assert.equal(withEffort.record.effort, 'low');
    assert.equal(withEffort.exitCode, 0);
    const without = await runBench(options);
    assert.equal(Object.hasOwn(without.record, 'effort'), false);
    await assert.rejects(runBench({ ...options, effort: 'turbo' }), BenchInfraError);
    fs.writeFileSync(log, '');
    const pair = await runBenchPair({ ...options, currentRoot: tree, candidateRoot: tree, effort: 'high', candidateEffort: 'low' });
    assert.equal(pair.record.effort, 'high');
    assert.equal(pair.record.candidate_effort, 'low');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /model_reasoning_effort=high/);
    assert.match(lines[1], /model_reasoning_effort=low/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
