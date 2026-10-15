'use strict';

// Members work in copies cut from committed history. A brand new project's
// setup files have to be committed by `atris init` itself, or the first
// member copy starts without its own team, map, or task list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function project(t, { gitInit = true, identity = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-commit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const env = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
    HOME: base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'),
  };
  if (identity) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    });
  }
  const git = (args, { ok = true } = {}) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (ok) assert.equal(r.status, 0, r.stderr || r.stdout);
    return r;
  };
  const atris = (args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, env,
  });
  if (gitInit) git(['init', '-q', '-b', 'master']);
  return { base, root, git, atris };
}

const tracked = (git) => git(['ls-tree', '-r', '--name-only', 'HEAD']).stdout.split('\n').filter(Boolean);

test('init in a brand new repo commits its setup and a member copy has it', (t) => {
  const { base, root, git, atris } = project(t);

  const init = atris(['init', '--yes']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.match(init.stdout, /setup saved to git/);

  const files = tracked(git);
  for (const want of ['atris/team/executor/MEMBER.md', 'atris/MAP.md', 'atris/TODO.md', 'atris/atris.md', 'CLAUDE.md', 'AGENTS.md', '.gitignore']) {
    assert.ok(files.includes(want), `${want} should be committed by init`);
  }
  assert.ok(!files.some((f) => /\.local(\.|$)/.test(path.basename(f))), 'machine-local config stays out of history');

  const copy = path.join(base, 'member-copy');
  const start = atris(['worktree', 'start', '--member', 'executor', '--task', 'first run', '--path', copy]);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  assert.ok(fs.existsSync(path.join(copy, 'atris', 'team', 'executor', 'MEMBER.md')), 'member copy should carry the team');
  assert.ok(fs.existsSync(path.join(copy, 'atris', 'MAP.md')), 'member copy should carry the map');
  assert.ok(fs.existsSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md')));
});

test('init leaves the person\'s own uncommitted and staged work alone', (t) => {
  const { root, git, atris } = project(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'first\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'readme']);
  fs.writeFileSync(path.join(root, 'README.md'), 'my edit\n');
  fs.writeFileSync(path.join(root, 'draft.txt'), 'not ready\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged by me\n');
  git(['add', 'staged.txt']);

  const init = atris(['init', '--yes']);
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const files = tracked(git);
  assert.ok(files.includes('atris/team/executor/MEMBER.md'));
  assert.ok(!files.includes('draft.txt'), 'untracked user file is not committed');
  assert.ok(!files.includes('staged.txt'), 'staged user file is not committed');
  assert.equal(git(['show', 'HEAD:README.md']).stdout, 'first\n', 'user edit is not committed');
  const status = git(['status', '--porcelain']).stdout;
  assert.match(status, /^ M README\.md$/m);
  assert.match(status, /^\?\? draft\.txt$/m);
  assert.match(status, /^A  staged\.txt$/m);
});

test('init --no-commit leaves setup uncommitted', (t) => {
  const { git, atris } = project(t);
  const init = atris(['init', '--yes', '--no-commit']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.notEqual(git(['rev-parse', '--verify', '-q', 'HEAD'], { ok: false }).status, 0, 'no commit should exist');
});

test('init commits even when git has no name or email set', (t) => {
  const { git, atris } = project(t, { identity: false });
  const init = atris(['init', '--yes']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(tracked(git).includes('atris/team/executor/MEMBER.md'));
});

test('init outside a git repo still works and says nothing about git', (t) => {
  const { root, atris } = project(t, { gitInit: false });
  const init = atris(['init', '--yes']);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md')));
  assert.doesNotMatch(init.stdout, /git/i);
});
