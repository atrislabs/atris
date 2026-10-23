'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { run } = require('../commands/aeo');

test('draft with -w asks for login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-aeo-cmd-mut-L145-7-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;

  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('ATRIS_')
      || key === 'TERM_SESSION_ID'
      || key === 'ITERM_SESSION_ID'
      || key === 'TMUX_PANE'
      || key === 'WT_SESSION'
      || key === 'WEZTERM_PANE'
    ) {
      delete process.env[key];
    }
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  console.log = (...parts) => { logs.push(parts.map((part) => String(part)).join(' ')); };
  console.error = (...parts) => { errors.push(parts.map((part) => String(part)).join(' ')); };
  process.exit = (code) => {
    const err = new Error(`exit:${code}`);
    err.exitCode = code;
    throw err;
  };
  process.chdir(root);

  try {
    let exitCode = null;
    try {
      await run(['draft', 'how buyers compare tools', '-w', 'acme']);
    } catch (err) {
      if (!err || typeof err.exitCode !== 'number') throw err;
      exitCode = err.exitCode;
    }
    assert.strictEqual(exitCode, 1);
    assert.deepStrictEqual(logs, []);
    assert.deepStrictEqual(errors, ['Not logged in. Run: atris login']);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
