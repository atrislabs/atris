const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('revert preserves the operating system error when reset cannot start', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reset-launch-'));
  const previousCwd = process.cwd();
  const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, ATRIS_EXPERIMENTS_PYTHON: process.env.ATRIS_EXPERIMENTS_PYTHON };
  t.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = root;
  process.env.PATH = path.join(root, 'empty-bin');
  fs.mkdirSync(process.env.PATH);
  process.env.ATRIS_EXPERIMENTS_PYTHON = process.execPath;
  process.chdir(root);
  const pack = path.join(root, 'atris', 'experiments', 'restore-baseline');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'reset.py'), 'print("baseline restored")\n');

  const spawnSync = childProcess.spawnSync;
  const launchError = new Error('spawn reset interpreter EACCES');
  launchError.code = 'EACCES';
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (args && args.some((arg) => path.basename(String(arg)) === 'reset.py')) {
      return { error: launchError, status: null, stdout: '', stderr: '' };
    }
    return spawnSync(command, args, options);
  });

  const { experimentsCommand } = require('../commands/experiments');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  const exit = new Error('command exited');
  t.mock.method(process, 'exit', () => { throw exit; });

  assert.throws(() => experimentsCommand('revert', 'restore-baseline'), (error) => error === exit);
  assert.match(errors.join('\n'), /spawn reset interpreter EACCES/);
});
