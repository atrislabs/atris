'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a failed worker with partial output is reported as failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-partial-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const resource = require('../lib/engine-resource');
  const start = resource.startEngineRun;
  const lines = [];
  try {
    fs.writeFileSync(path.join(root, 'claude'), '#!/bin/sh\nprintf "partial answer\\n"\nprintf "worker failed\\n" >&2\nexit 1\n', { mode: 0o755 });
    process.env.HOME = root;
    process.env.PATH = root;
    process.env.ATRIS_NONINTERACTIVE = '1';
    process.chdir(root);
    resource.startEngineRun = () => () => ({});
    console.log = console.error = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const { scoutCommand } = require('../commands/scout');
    await scoutCommand(['--yes', '--engine', 'claude', 'where is the entry point?']);
    assert.match(lines.join('\n'), /failed/i);
  } finally {
    resource.startEngineRun = start;
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
