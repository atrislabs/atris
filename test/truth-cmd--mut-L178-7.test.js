'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { truthCommand } = require('../commands/truth');

test('global report treats a registry without jobs as having no loops', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-registry-'));
  const cwd = process.cwd();
  const keys = ['HOME', 'ATRIS_TASKS_DB', 'ATRIS_TEST_STATE_DIR'];
  const previous = keys.map((key) => process.env[key]);
  const log = console.log;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    process.env.ATRIS_TEST_STATE_DIR = dir;
    process.chdir(dir);
    const heartbeat = path.join(dir, '.atris', 'heartbeat');
    fs.mkdirSync(heartbeat, { recursive: true });
    fs.writeFileSync(path.join(heartbeat, 'registry.json'), '{}');
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    // Keep the report assertion active even if reading an incomplete registry throws.
    let failure;
    try { truthCommand(['--global', '--json']); } catch (error) { failure = error; }
    const report = output.length ? JSON.parse(output.join('\n')) : null;
    assert.equal(report?.loop_rows?.length, 0, failure?.message);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
