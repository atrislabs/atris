'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isRevisionSignalFile } = require('../lib/revision-metric');

test('source files and durable documentation count as revision signals', () => {
  for (const file of ['lib/revision-metric.js', 'commands/status.js', 'README.md', 'atris/features/example/idea.md']) {
    assert.strictEqual(isRevisionSignalFile(file), true, file);
  }
});

test('generated state and operational files do not count as revision signals', () => {
  for (const file of [
    'atris/logs/run.json',
    'atris/runs/example/proof.json',
    'atris/team/builder/logs/session.md',
    'atris/team/builder/now.md',
    'atris/now.md',
    'atris/thinking.md',
    'atris/TODO.md',
    'atris/MAP.md',
    'atris/brain/STATUS.md',
    'atris/status/current.json',
    'test/fast-tests.txt',
    '.atris/state/revision-metric.jsonl',
  ]) {
    assert.strictEqual(isRevisionSignalFile(file), false, file);
  }
});

test('trims whitespace and preserves boundaries of ignored path patterns', () => {
  assert.strictEqual(isRevisionSignalFile(' \tlib/example.js\n'), true);
  assert.strictEqual(isRevisionSignalFile(' \tatris/MAP.md\n'), false);
  for (const file of [
    'atris/logs-extra/run.json',
    'docs/atris/logs/run.json',
    'atris/MAP.md.backup',
    'test/fast-tests.txt.backup',
    'atris/team/builder/README.md',
  ]) {
    assert.strictEqual(isRevisionSignalFile(file), true, file);
  }
});

test('empty and missing inputs are not revision signals', () => {
  assert.strictEqual(isRevisionSignalFile(), false);
  for (const file of ['', ' \t\r\n', null, undefined, false, 0]) {
    assert.strictEqual(isRevisionSignalFile(file), false);
  }
});
