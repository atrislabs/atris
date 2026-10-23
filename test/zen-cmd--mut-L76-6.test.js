'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { zenCommand } = require('../commands/zen');

test('calm repo reports yes when check is run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;

  try {
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'], { cwd: dir });

    const tree = execFileSync('git', ['write-tree'], { cwd: dir }).toString().trim();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'init'], { cwd: dir, env }).toString().trim();
    execFileSync('git', ['update-ref', 'refs/heads/master', commit], { cwd: dir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/master', commit], { cwd: dir });

    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      zenCommand(['--check', '--no-fetch'], dir);
    } finally {
      console.log = origLog;
    }

    assert.strictEqual(lines[0], 'zen: yes');
  } finally {
    process.env.HOME = savedHome || os.tmpdir();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
