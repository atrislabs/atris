'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAgentWorktree } = require('../commands/worktree');

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-start-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'branch.autoSetupMerge', 'always']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { dir, root, git, target: path.join(dir, 'worker') };
}

for (const phase of ['add', 'metadata']) {
test(`a real config lock during ${phase} retries and completes with metadata`, (t) => {
  const { dir, root, git, target } = room(t);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'attempts');
  const lock = path.join(root, '.git', 'config.lock');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (${phase === 'add' ? "args[0] === 'worktree' && args[1] === 'add'" : "args[0] === 'config' && args[1].endsWith('.atris-base')"}) {
  // The other writer holds the lock for the first try and lets go before the
  // retry. A timer here raced slow CI machines and expired before the first try.
  if (!fs.existsSync(${JSON.stringify(marker)})) fs.writeFileSync(${JSON.stringify(lock)}, 'another writer');
  else fs.rmSync(${JSON.stringify(lock)}, { force: true });
  fs.appendFileSync(${JSON.stringify(marker)}, 'add\\n');
}
const run = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(run.status ?? 1);
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const created = createAgentWorktree({ root, agent: 'tester', task: 'lock retry', path: target, base: 'HEAD' });
  const attempts = fs.readFileSync(marker, 'utf8').trim().split('\n').length;
  assert.ok(attempts > 1 && attempts <= 3, `bounded attempts: ${attempts}`);
  assert.equal(fs.existsSync(path.join(created.path, 'source.txt')), true);
  assert.equal(git(['config', '--get', `branch.${created.branch}.atris-owner`]), 'tester');
});
}

test('an exhausted start removes its new branch so the next start is not an overlap', (t) => {
  const { root, target, git } = room(t);
  const now = new Date();
  const lock = path.join(root, '.git', 'config.lock');
  fs.writeFileSync(lock, 'another writer');
  assert.throws(() => createAgentWorktree({ root, agent: 'tester', task: 'failed start', path: target, base: 'HEAD', now }), /could not lock config file/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer', 'never remove another writer’s lock');
  fs.unlinkSync(lock);
  assert.equal(git(['branch', '--format=%(refname:short)']).split('\n').length, 1);
  const next = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'start', '--agent', 'tester', '--task', 'failed start', '--path', target, '--base', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, /overlapping flight/);
  assert.equal(fs.existsSync(target), true);
});

test('an existing branch survives a failed creation', (t) => {
  const { root, target, git } = room(t);
  git(['branch', 'existing', 'HEAD']);
  const before = git(['rev-parse', 'existing']);
  assert.throws(() => createAgentWorktree({ root, agent: 'tester', task: 'existing', branch: 'existing', path: target, base: 'HEAD' }), /already exists/);
  assert.equal(git(['rev-parse', 'existing']), before);
});

// Flights used to be named for the display id a person reads (dispatch-feed-12) and are now named for
// the row id. The older name is not an identity: display names repeat across workspaces and change
// when the task list changes, so a branch under one can belong to another job. A start that is told
// the older name is never held up by an unfinished flight under it and never starts from it. It says
// where the unfinished work may be, in one line, and starts fresh.
function leaveOlderFlight(t) {
  const setup = room(t);
  const stampOf = (when) => when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const older = `codex/tester-dispatch-feed-12-${stampOf(new Date(Date.now() - 5 * 60 * 1000))}`;
  const home = setup.git(['branch', '--show-current']);
  setup.git(['checkout', '-q', '-b', older]);
  fs.writeFileSync(path.join(setup.root, 'half.txt'), 'half done\n');
  setup.git(['add', 'half.txt']);
  setup.git(['commit', '-qm', 'half done']);
  setup.git(['checkout', '-q', home]);
  return { ...setup, older };
}

function startUnderNewName(setup, extra) {
  return spawnSync(process.execPath, [
    path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'start', '--agent', 'tester',
    '--task', 'dispatch-01k8x3m2q4abcdefghjkmnpqrs', '--base', 'HEAD', ...extra,
  ], { cwd: setup.root, encoding: 'utf8', env: { ...process.env, HOME: setup.dir, ATRIS_SKIP_UPDATE_CHECK: '1' } });
}

const sidecarOf = (started) => {
  const target = /^path: (.+)$/m.exec(started.stdout)[1];
  return { target, sidecar: JSON.parse(fs.readFileSync(path.join(target, '.atris', 'agent-worktree.json'), 'utf8')) };
};

const olderLine = (branch) => `older unfinished work may be on ${branch}; starting fresh`;
const aboutOlderWork = (started) => started.stderr.split('\n').filter((line) => /older unfinished work/.test(line));

test('a start told the job\'s older name is not held up by an unfinished flight under that name, does not start from it, and says where it is', (t) => {
  const setup = leaveOlderFlight(t);
  const started = startUnderNewName(setup, ['--former-task', 'dispatch-feed-12']);

  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stderr, /overlapping flight/);
  assert.doesNotMatch(started.stderr, /pass --force to start anyway/);
  assert.equal(aboutOlderWork(started).length, 1, 'one line');
  assert.ok(started.stderr.includes(olderLine(setup.older)), started.stderr);
  const { target, sidecar } = sidecarOf(started);
  assert.equal(sidecar.resumed_from, null);
  assert.equal(fs.existsSync(path.join(target, 'half.txt')), false);
  assert.match(sidecar.branch, /^codex\/tester-dispatch-01k8x3m2q4abcdefghjkmnpqrs-\d{8}-\d{6}$/);
  assert.equal(setup.git(['show', `${setup.older}:half.txt`]), 'half done', 'the older branch keeps its commits');
});

test('a start told nothing of the older name knows nothing of it: no line, no flight in the way, no work picked up', (t) => {
  const setup = leaveOlderFlight(t);
  const started = startUnderNewName(setup, []);

  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stderr, /overlapping flight/);
  assert.deepEqual(aboutOlderWork(started), []);
  const { target, sidecar } = sidecarOf(started);
  assert.equal(sidecar.resumed_from, null);
  assert.equal(fs.existsSync(path.join(target, 'half.txt')), false);
});

test('the older name is read as written: with an equals sign, with --force, and an empty one means none', (t) => {
  // Each start gets its own repository: a start leaves a flight under the new name behind, and the
  // next start of the same name would meet that flight, which is not what is being asked here.
  const withEquals = leaveOlderFlight(t);
  const equals = startUnderNewName(withEquals, ['--former-task=dispatch-feed-12']);
  assert.equal(equals.status, 0, equals.stderr);
  assert.ok(equals.stderr.includes(olderLine(withEquals.older)), equals.stderr);

  // --force has nothing to force past: the older name never blocks, and it is still named.
  const withForce = leaveOlderFlight(t);
  const forced = startUnderNewName(withForce, ['--former-task', 'dispatch-feed-12', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.doesNotMatch(forced.stderr, /overlapping flight/);
  assert.ok(forced.stderr.includes(olderLine(withForce.older)), forced.stderr);
  assert.equal(sidecarOf(forced).sidecar.resumed_from, null);

  const withBlank = leaveOlderFlight(t);
  const blank = startUnderNewName(withBlank, ['--former-task=']);
  assert.equal(blank.status, 0, blank.stderr);
  assert.deepEqual(aboutOlderWork(blank), []);
});
