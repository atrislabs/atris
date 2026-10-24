'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('an incoming directory link preserves the local plan in its saved copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-preservation-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '--initial-branch=master');
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'app.js'), 'original\n');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    git('remote', 'add', 'origin', root);
    git('branch', '--set-upstream-to=origin/master');
    fs.mkdirSync(path.join(root, 'atris', 'plans'));
    fs.writeFileSync(path.join(root, 'atris', 'plans', 'overview.md'), 'incoming plan\n');
    fs.symlinkSync('plans', path.join(root, 'atris', 'plan.md'));
    git('add', '.');
    git('commit', '-q', '-m', 'advance app');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    git('reset', '--hard', 'HEAD~1');
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'plan.md'), 'local contribution\n');
    applyZen({ cwd: root, fetch: false, now: new Date('2020-01-02T00:00:00Z'), freshMinutes: 0 });
    const savedRoot = path.join(root, '.git', 'atris-zen');
    const [stamp] = fs.readdirSync(savedRoot);
    const saved = path.join(savedRoot, stamp, 'untracked', 'atris', 'plan.md');
    assert.strictEqual(fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : undefined, 'local contribution\n');
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
