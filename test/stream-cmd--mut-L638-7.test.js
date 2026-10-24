'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const land = require('../commands/land');

test('landing events retain the overdue branch count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-overdue-event-'));
  const previousHome = process.env.HOME;
  const previousBoard = land.sharedBoard;
  process.env.HOME = root;
  try {
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'unused-config'),
      GIT_CONFIG_SYSTEM: path.join(root, 'unused-config'),
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_AUTHOR_DATE: '2026-06-01T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-06-01T12:00:00Z',
    };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
    git('init', '-q', '-b', 'master');
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git('add', 'base.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', 'base');
    git('checkout', '-q', '-b', 'unfinished');
    fs.writeFileSync(path.join(root, 'change.txt'), 'unfinished change\n');
    git('add', 'change.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', 'unfinished change');
    git('checkout', '-q', 'master');

    const nowMs = Date.parse('2026-07-06T12:00:00Z');
    const board = land.collectBoard(root, { now: nowMs });
    // Supply the computed board directly so its age uses the explicit clock.
    land.sharedBoard = () => board;
    const { collectStreamEvents } = require('../commands/stream');
    const events = collectStreamEvents({
      root,
      nowMs,
      deps: {
        listWorktrees: () => [],
        runGit: () => ({ status: 1, stdout: '', stderr: '' }),
      },
    });
    const event = events.find((row) => row.event === 'landing_state');
    assert.match(event?.summary || '', /\b1 overdue\b/);
  } finally {
    land.sharedBoard = previousBoard;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
