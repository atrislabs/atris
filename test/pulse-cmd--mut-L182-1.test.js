'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('a heartbeat reports the file its worker newly dirtied in a git repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-changed-work-'));
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalSpawn = childProcess.spawnSync;
  const originalWrite = process.stdout.write;
  const originalExit = process.exit;
  try {
    process.env.HOME = root;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'unused-git-config');
    process.chdir(root);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T12:00:00Z',
    };
    const git = (...args) => {
      const result = originalSpawn('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || String(result.error || ''));
    };
    git('init');
    fs.writeFileSync(path.join(root, 'work.txt'), 'original work\n');
    git('add', 'work.txt');
    git('commit', '--no-verify', '-m', 'initial work');

    // Simulate a completed local worker, while leaving all git commands real.
    childProcess.spawnSync = (command, args, options) => {
      if (command === process.execPath && args[1] === 'mission') {
        fs.writeFileSync(path.join(options.cwd, 'work.txt'), 'finished work\n');
        return { status: 0, stdout: JSON.stringify({ reason: 'completed' }), stderr: '' };
      }
      assert.equal(command, 'git', 'only local git operations may run');
      return originalSpawn(command, args, options);
    };
    process.stdout.write = () => true;
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { pulseCommand } = require('../commands/pulse');
    const result = pulseCommand([
      'tick', '--no-claude', '--no-campaigns', '--no-autopilot', '--no-verify', '--json',
    ]);
    assert.ok(result.changed_files.includes('work.txt'), 'completed worker edits must be reported');
  } finally {
    childProcess.spawnSync = originalSpawn;
    process.stdout.write = originalWrite;
    process.exit = originalExit;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});
