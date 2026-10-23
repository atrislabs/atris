'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { consoleCommand } = require('../commands/console');

// consoleCommand is the only export that reaches the console render path.
// This boots it end to end: a stub runner bin makes backend detection pass,
// a temp workspace supplies the context, and process.exit throws so the
// launch hands control back instead of ending the test process.
function boot(t, { skillNames }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-mut-l229-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const name of skillNames) {
    const dir = path.join(root, 'atris', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\ndescription: ${name} probe\n---\n`);
  }

  const runner = path.join(root, 'stub-runner');
  fs.writeFileSync(runner, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const logs = [];
  const stopped = new Error('console command exited');
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const savedCwd = process.cwd();
  const savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  try {
    process.argv = ['node', 'atris', 'console'];
    process.env.ATRIS_RUNNER_BIN = runner;
    process.exit = () => { throw stopped; };
    console.log = (...values) => logs.push(values.join(' '));
    console.error = () => {};
    process.chdir(root);
    assert.throws(() => consoleCommand(), (error) => error === stopped);
  } finally {
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
    process.chdir(savedCwd);
    delete process.env.ATRIS_RUNNER_BIN;
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  }
  return logs;
}

test('console boot prints the skills bar when the workspace has skills', (t) => {
  const logs = boot(t, { skillNames: ['mutprobe'] });

  assert.ok(
    logs.some((line) => line.includes('\x1b[2m  Skills: \x1b[35m/mutprobe')),
    'expected the skills bar to list /mutprobe',
  );
});

test('console boot prints no skills bar when the workspace has no skills', (t) => {
  const logs = boot(t, { skillNames: [] });

  assert.ok(
    logs.every((line) => !line.includes('\x1b[2m  Skills: ')),
    'expected no skills bar line for an empty skills list',
  );
});
