const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-record-removal-')));

const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) delete process.env[key];
}
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg');
process.env.GIT_CONFIG_NOSYSTEM = '1';
// Keep git from finding a repository above the sandbox.
process.env.GIT_CEILING_DIRECTORIES = sandbox;

const { recordWorktreeRemoval } = require('../commands/worktree');

test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function plainDir(name) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removalsFile(root) {
  return path.join(root, '.atris', 'state', 'worktree_removals.jsonl');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
}

test('writes one json line with who, why, path and branch', () => {
  const root = plainDir('plain-one');
  const result = recordWorktreeRemoval(root, {
    path: '/work/lane-a',
    branch: 'lane-a',
    by: 'atris land --reap',
    reason: 'merged and clean',
  });

  assert.equal(result, undefined);
  const raw = fs.readFileSync(removalsFile(root), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const lines = readLines(removalsFile(root));
  assert.equal(lines.length, 1);
  const entry = lines[0];
  assert.equal(entry.path, '/work/lane-a');
  assert.equal(entry.branch, 'lane-a');
  assert.equal(entry.by, 'atris land --reap');
  assert.equal(entry.reason, 'merged and clean');
  assert.equal(entry.pid, process.pid);
  // Shape only: the stamp is a round-trippable ISO string, whatever the clock says.
  assert.equal(typeof entry.at, 'string');
  assert.equal(new Date(entry.at).toISOString(), entry.at);
});

test('a missing or empty branch is recorded as null', () => {
  const root = plainDir('plain-branch');
  recordWorktreeRemoval(root, { path: '/work/detached', by: 'cleanup', reason: 'stale' });
  recordWorktreeRemoval(root, { path: '/work/blank', branch: '', by: 'cleanup', reason: 'stale' });

  const [first, second] = readLines(removalsFile(root));
  assert.equal(first.path, '/work/detached');
  assert.equal(first.branch, null);
  assert.equal(second.path, '/work/blank');
  assert.equal(second.branch, null);
});

test('later removals append after earlier ones instead of replacing them', () => {
  const root = plainDir('plain-append');
  recordWorktreeRemoval(root, { path: '/work/one', branch: 'one', by: 'a', reason: 'first' });
  recordWorktreeRemoval(root, { path: '/work/two', branch: 'two', by: 'b', reason: 'second' });
  recordWorktreeRemoval(root, { path: '/work/three', branch: 'three', by: 'c', reason: 'third' });

  const lines = readLines(removalsFile(root));
  assert.deepEqual(lines.map((line) => line.path), ['/work/one', '/work/two', '/work/three']);
  assert.deepEqual(lines.map((line) => line.reason), ['first', 'second', 'third']);
});

test('keeps an existing log and its earlier lines when it adds a new one', () => {
  const root = plainDir('plain-existing');
  const file = removalsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ path: '/old', reason: 'earlier run' })}\n`);

  recordWorktreeRemoval(root, { path: '/new', by: 'x', reason: 'later run' });

  const lines = readLines(file);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { path: '/old', reason: 'earlier run' });
  assert.equal(lines[1].path, '/new');
});

test('text with quotes and newlines stays on a single parseable line', () => {
  const root = plainDir('plain-escape');
  const reason = 'said "done"\nthen left\ttabs';
  recordWorktreeRemoval(root, { path: '/work/a b', branch: 'feat/x', by: 'me', reason });

  const raw = fs.readFileSync(removalsFile(root), 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 1);
  const [entry] = readLines(removalsFile(root));
  assert.equal(entry.reason, reason);
  assert.equal(entry.path, '/work/a b');
  assert.equal(entry.branch, 'feat/x');
});

test('never throws when the log cannot be written', () => {
  const root = plainDir('plain-blocked');
  // A file where the .atris folder should be makes the folder impossible to create.
  fs.writeFileSync(path.join(root, '.atris'), 'not a folder\n');

  let result;
  assert.doesNotThrow(() => {
    result = recordWorktreeRemoval(root, { path: '/work/x', branch: 'x', by: 'me', reason: 'why' });
  });
  assert.equal(result, undefined);
  assert.equal(fs.readFileSync(path.join(root, '.atris'), 'utf8'), 'not a folder\n');
});

test('inside a git repo the line lands in the main checkout, not the linked one', (t) => {
  const main = plainDir('repo-main');
  const linked = path.join(sandbox, 'repo-linked');
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

  if (git(['init'], main).status !== 0) return t.skip('git unavailable');
  if (git([...identity, 'commit', '--allow-empty', '-m', 'init'], main).status !== 0) return t.skip('cannot commit');
  if (git(['worktree', 'add', '-b', 'lane', linked], main).status !== 0) return t.skip('cannot add worktree');
  const probe = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], linked);
  if (probe.status !== 0) return t.skip('git too old for --path-format');

  recordWorktreeRemoval(linked, { path: linked, branch: 'lane', by: 'atris worktree cleanup', reason: 'merged' });

  const entries = readLines(removalsFile(main));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, linked);
  assert.equal(entries[0].branch, 'lane');
  assert.equal(entries[0].by, 'atris worktree cleanup');
  assert.equal(entries[0].reason, 'merged');
  assert.equal(fs.existsSync(path.join(linked, '.atris', 'state', 'worktree_removals.jsonl')), false);
});

test('omitted by and reason are left out of the line instead of being invented', () => {
  const root = plainDir('plain-sparse');
  recordWorktreeRemoval(root, { path: '/work/sparse' });

  const [entry] = readLines(removalsFile(root));
  assert.equal(entry.path, '/work/sparse');
  assert.equal(entry.branch, null);
  assert.equal(entry.pid, process.pid);
  assert.equal('by' in entry, false);
  assert.equal('reason' in entry, false);
});
