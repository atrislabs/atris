'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('check reports a locked side copy as held', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-held-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2020-01-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T12:00:00Z',
    };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '-m', 'seed');
    git('worktree', 'add', '--quiet', '--detach', path.join(root, 'held'));
    git('worktree', 'lock', path.join(root, 'held'));
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    zenCommand(['--check', '--no-fetch'], root);
    assert.match(lines.join('\n'), /1.*locked/i);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
