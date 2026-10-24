'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('failed heartbeat records the runner model when the legacy model is unset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-model-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedExit = process.exit;
  const savedWrite = process.stdout.write;
  const savedLog = console.log;
  const savedError = console.error;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_RUNNER_MODEL = 'glm-5.2';
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    // A missing Node preload reproduces a broken worker runtime without an engine.
    process.env.NODE_OPTIONS = `--require ${path.join(root, 'missing-preload.cjs')}`;
    const { pulseCommand } = require('../commands/pulse');
    pulseCommand(['tick', '--no-claude', '--no-autopilot', '--no-campaigns'], root);
    const { scorecardsPath } = require('../lib/pulse');
    const rows = fs.readFileSync(scorecardsPath(root), 'utf8').trim().split('\n');
    const row = JSON.parse(rows[rows.length - 1]);
    assert.strictEqual(row.model_used, 'glm-5.2');
  } finally {
    process.chdir(savedCwd);
    process.exit = savedExit;
    process.stdout.write = savedWrite;
    console.log = savedLog;
    console.error = savedError;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
