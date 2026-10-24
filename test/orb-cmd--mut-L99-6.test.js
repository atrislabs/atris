'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('digest suggestion links to the team stream command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-digest-command-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedExit = process.exit;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { runOrb } = require('../commands/orb');
    await runOrb(['--json']);
    const digest = JSON.parse(output.join('\n')).moves.find((move) => move.label === "what's moving");
    assert.strictEqual(digest.command, 'atris stream --once');
  } finally {
    console.log = savedLog;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
