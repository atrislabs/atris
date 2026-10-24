'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a nonzero command exit preserves stderr in the run record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-exit-error-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  try {
    process.env.HOME = root;
    process.env.PATH = root;
    process.env.ATRIS_NONINTERACTIVE = '1';
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'cursor-agent'),
      '#!/bin/sh\nprintf "fixture-command-failed\\n" >&2\nexit 7\n',
      { mode: 0o755 });
    console.log = () => {};
    console.error = () => {};
    const { scoutCommand } = require('../commands/scout');
    await scoutCommand(['--yes', '--engine', 'cursor', 'where is the entry point?']);
    const entries = fs.readFileSync(path.join(root, '.atris', 'state', 'engine-resource.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const end = entries.find(entry => entry.phase === 'end');
    assert.match(end.error || '', /fixture-command-failed/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
