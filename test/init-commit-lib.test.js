'use strict';

// Unit tests for lib/init-commit.js, the helpers behind `atris init` that commit
// only the setup files init wrote. Each test runs real git inside a throwaway repo
// under os.tmpdir(). HOME and the global git config point at a temp folder, so the
// developer's own git settings cannot change the result.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  snapshotBeforeInit,
  commitInitFiles,
  dirtyPaths,
  isLocalOnly,
} = require('../lib/init-commit');

const ATRIS_AUTHOR = 'Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
const IDENTITY_VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const ISOLATED_VARS = ['HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', ...IDENTITY_VARS];

// The module spawns git with the inherited environment, so the isolation has to
// live in process.env. It is restored after each test.
function isolateGit(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-commit-lib-'));
  const saved = Object.fromEntries(ISOLATED_VARS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of ISOLATED_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  // useConfigOnly stops git from building an identity out of the login name and hostname,
  // so a repo with no identity set fails the way it does on a fresh machine.
  fs.writeFileSync(path.join(base, 'gitconfig'), '[user]\n\tuseConfigOnly = true\n');
  process.env.HOME = base;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(base, 'gitconfig');
  for (const key of IDENTITY_VARS) delete process.env[key];
  return base;
}

function makeRepo(t) {
  const base = isolateGit(t);
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  git(['init', '-q', '-b', 'master']);
  const write = (rel, body = 'x\n') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  // Commits whatever is staged, so the repo has history afterwards.
  const commit = (message) => {
    git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message]);
  };
  return { base, root, git, write, commit };
}

test('isLocalOnly flags machine-local config files and nothing else', () => {
  assert.strictEqual(isLocalOnly('.devin/config.local.json'), true);
  assert.strictEqual(isLocalOnly('app.local'), true);
  assert.strictEqual(isLocalOnly('atris/MAP.md'), false);
  assert.strictEqual(isLocalOnly('notes/locals.md'), false);
});

test('dirtyPaths lists changed and untracked files, and a rename by its new name only', (t) => {
  const repo = makeRepo(t);
  assert.strictEqual(dirtyPaths(repo.root).size, 0);

  repo.write('old.md');
  repo.git(['add', 'old.md']);
  repo.commit('seed');
  repo.git(['mv', 'old.md', 'new.md']);
  repo.write('draft/a.md');

  assert.deepStrictEqual([...dirtyPaths(repo.root)].sort(), ['draft/a.md', 'new.md']);
});

test('snapshotBeforeInit and commitInitFiles do nothing outside a git repo', (t) => {
  const base = isolateGit(t);
  assert.strictEqual(snapshotBeforeInit(base), null);
  assert.deepStrictEqual(commitInitFiles(null), { committed: false, reason: 'not_git' });
});

test('a fresh repo commits only the files init wrote and leaves the person\'s work alone', (t) => {
  const repo = makeRepo(t);
  repo.write('notes.md', 'my unsaved notes\n');
  repo.write('staged.md', 'my staged draft\n');
  repo.git(['add', 'staged.md']);

  const snapshot = snapshotBeforeInit(repo.root);
  assert.strictEqual(snapshot.fresh, true);
  assert.ok(snapshot.before.has('notes.md'));
  assert.ok(snapshot.before.has('staged.md'));

  repo.write('CLAUDE.md', '# claude\n');
  repo.write('atris/MAP.md', '# map\n');
  repo.write('.devin/config.local.json', '{}\n');

  const result = commitInitFiles(snapshot);
  assert.deepStrictEqual(result, { committed: true, paths: ['CLAUDE.md', 'atris/MAP.md'] });

  // Only the init files reached history. The local-only config and the person's files did not.
  assert.deepStrictEqual(repo.git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean), ['CLAUDE.md', 'atris/MAP.md']);
  assert.strictEqual(repo.git(['rev-list', '--count', 'HEAD']).trim(), '1');
  assert.deepStrictEqual(
    repo.git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).sort(),
    ['?? .devin/config.local.json', '?? notes.md', 'A  staged.md'],
  );
});

test('with no git identity configured, the commit falls back to the Atris author', (t) => {
  const repo = makeRepo(t);
  const snapshot = snapshotBeforeInit(repo.root);
  repo.write('CLAUDE.md', '# claude\n');

  assert.strictEqual(commitInitFiles(snapshot).committed, true);
  assert.strictEqual(repo.git(['log', '-1', '--format=%an <%ae>']).trim(), ATRIS_AUTHOR);
});

test('a repo with history is left alone', (t) => {
  const repo = makeRepo(t);
  repo.commit('existing work');
  const snapshot = snapshotBeforeInit(repo.root);
  assert.strictEqual(snapshot.fresh, false);

  repo.write('CLAUDE.md', '# claude\n');
  assert.deepStrictEqual(commitInitFiles(snapshot), { committed: false, reason: 'has_history' });
  assert.strictEqual(repo.git(['rev-list', '--count', 'HEAD']).trim(), '1');
});

test('a fresh repo with no new files reports nothing_new', (t) => {
  const repo = makeRepo(t);
  repo.write('notes.md', 'mine\n');
  const snapshot = snapshotBeforeInit(repo.root);

  assert.deepStrictEqual(commitInitFiles(snapshot), { committed: false, reason: 'nothing_new', paths: [] });
});

test('a commit blocked by a hook is reported and the index is put back as found', (t) => {
  const repo = makeRepo(t);
  const snapshot = snapshotBeforeInit(repo.root);
  repo.write('CLAUDE.md', '# claude\n');

  const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "blocked by test hook" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);

  const result = commitInitFiles(snapshot);
  assert.strictEqual(result.committed, false);
  assert.strictEqual(result.reason, 'commit_failed');
  assert.deepStrictEqual(result.paths, ['CLAUDE.md']);
  assert.match(result.detail, /blocked by test hook/);

  assert.strictEqual(repo.git(['diff', '--cached', '--name-only']).trim(), '');
  assert.ok(fs.existsSync(path.join(repo.root, 'CLAUDE.md')));
});
