'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harvestCommand } = require('../commands/harvest');

test('harvest excludes the log immediately beyond its 200-file scan limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-scan-limit-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const logs = [];
  try {
    const logDir = path.join(root, 'atris', 'logs', 'runs');
    fs.mkdirSync(logDir, { recursive: true });
    for (let i = 0; i < 201; i++) {
      fs.writeFileSync(path.join(logDir, `${String(i).padStart(3, '0')}.log`), 'All good.');
    }
    // Put the only actionable text just outside the actual directory scan order.
    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    fs.writeFileSync(path.join(logDir, entries[200].name), 'Error: boundary log.');
    process.chdir(root);
    console.log = (...args) => logs.push(args.join(' '));

    const result = harvestCommand(['--json']);
    const expected = {
      ok: true,
      action: 'harvest',
      write: false,
      count: 0,
      actions: [],
      writes: [],
    };
    assert.deepStrictEqual(result, expected);
    assert.deepStrictEqual(logs, [JSON.stringify(expected, null, 2)]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
