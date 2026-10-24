'use strict';

// Direct tests for lib/zen-apply.js: call applyZen against throwaway git repos
// (a local bare origin plus a clone), never the CLI, and read back what it did.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const zenApply = require('../lib/zen-apply');
const zenCheck = require('../lib/zen');

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-apply-lib-')));
const home = path.join(work, 'home');
fs.mkdirSync(home);
const realHome = process.env.HOME;
process.env.HOME = home;

after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(work, { recursive: true, force: true });
});

let counter = 0;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function commit(cwd, file, content, message) {
  write(cwd, file, content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

function identify(cwd) {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'test');
}

// A bare origin, a seed that pushed two commits to it, and a clone of it.
function createRepo() {
  const base = path.join(work, `repo-${counter += 1}`);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  identify(seed);
  commit(seed, 'CLAUDE.md', 'team note\n', 'note');
  commit(seed, 'app.js', 'one\n', 'app');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  git(base, 'clone', '-q', origin, checkout);
  identify(checkout);
  return { base, origin, seed, checkout };
}

// An hour from now, with a short fresh window: nothing already on disk counts
// as recently touched, so zen is free to act on it.
function later() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

// The tag applyZen puts in branch names, rebuilt from the time it was given.
function tagFor(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function receipts(checkout) {
  const file = path.join(checkout, '.git', 'atris-zen.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('exports applyZen and the same zen defaults as lib/zen', () => {
  assert.strictEqual(typeof zenApply.applyZen, 'function');
  assert.strictEqual(zenApply.FRESH_MINUTES, zenCheck.FRESH_MINUTES);
  assert.strictEqual(zenApply.ABANDONED_DAYS, zenCheck.ABANDONED_DAYS);
  assert.ok(Number(zenApply.FRESH_MINUTES) > 0);
  assert.ok(Number(zenApply.ABANDONED_DAYS) > 0);
});

test('applyZen outside a git repository says so and touches nothing', () => {
  const plain = path.join(work, 'plain-folder');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'note.txt'), 'hello\n');

  const result = zenApply.applyZen({ cwd: plain, fetch: false });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'not a git repository');
  assert.deepStrictEqual(fs.readdirSync(plain), ['note.txt']);
});

test('applyZen on a repo already in zen reports already and changes no files', () => {
  const { checkout } = createRepo();
  const now = new Date();

  const result = zenApply.applyZen({ cwd: checkout, now, freshMinutes: 5 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.strictEqual(result.already, true);
  assert.strictEqual(result.root, checkout);
  assert.strictEqual(result.upstream, 'origin/master');
  assert.deepStrictEqual(result.done, []);
  assert.deepStrictEqual(result.left, []);
  assert.deepStrictEqual(result.saved, []);
  assert.deepStrictEqual(result.remaining, []);
  assert.strictEqual(result.workspace.ran, false);
  assert.strictEqual(git(checkout, 'status', '--porcelain'), '');
  assert.strictEqual(git(checkout, 'branch', '--list', 'zen-backup/*'), '');

  const [receipt] = receipts(checkout);
  assert.strictEqual(receipt.at, now.toISOString());
  assert.deepStrictEqual(receipt.before, []);
  assert.deepStrictEqual(receipt.done, []);
});

test('applyZen saves stray code edits to a zen-backup branch and restores the tree', () => {
  const { checkout } = createRepo();
  write(checkout, 'app.js', 'edited\n');
  write(checkout, 'extra/new.js', 'brand new\n');
  const now = later();
  const tag = tagFor(now);

  const result = zenApply.applyZen({ cwd: checkout, now, freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.strictEqual(result.already, false);
  assert.deepStrictEqual(result.done, [`saved 2 stray edits to zen-backup/${tag}`]);
  assert.deepStrictEqual(result.saved, [`refs/heads/zen-backup/${tag}`]);
  assert.deepStrictEqual(result.left, []);
  assert.deepStrictEqual(result.remaining, []);

  // The tree is back to HEAD, and the backup branch holds both edits.
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'one\n');
  assert.strictEqual(fs.existsSync(path.join(checkout, 'extra')), false);
  assert.strictEqual(git(checkout, 'show', `zen-backup/${tag}:app.js`), 'edited');
  assert.strictEqual(git(checkout, 'show', `zen-backup/${tag}:extra/new.js`), 'brand new');

  const [receipt] = receipts(checkout);
  assert.deepStrictEqual(receipt.before, [{ kind: 'stray_code', count: 2 }]);
  assert.deepStrictEqual(receipt.after, []);
  assert.deepStrictEqual(receipt.saved, [`refs/heads/zen-backup/${tag}`]);
});

test('applyZen leaves team notes in the tree while it saves code edits beside them', () => {
  const { checkout } = createRepo();
  write(checkout, 'CLAUDE.md', 'team note\nmore live notes\n');
  write(checkout, 'app.js', 'stray\n');

  const result = zenApply.applyZen({ cwd: checkout, now: later(), freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.strictEqual(result.team_files, 1);
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'CLAUDE.md'), 'utf8'), 'team note\nmore live notes\n');
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'one\n');
  assert.match(result.done[0], /^saved 1 stray edit to zen-backup\//);
  // git() trims the output, so the leading space of " M" is gone.
  assert.strictEqual(git(checkout, 'status', '--porcelain'), 'M CLAUDE.md');
});

test('applyZen leaves an edit made inside the fresh window alone and says so', () => {
  const { checkout } = createRepo();
  write(checkout, 'app.js', 'being edited right now\n');

  const result = zenApply.applyZen({ cwd: checkout, now: new Date(), freshMinutes: 60 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, false);
  assert.deepStrictEqual(result.done, []);
  assert.deepStrictEqual(result.left, ['1 edit was made in the last 60 minutes, so it stays']);
  assert.deepStrictEqual(result.remaining, ['1 stray code edit outside team state']);
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'being edited right now\n');
  assert.strictEqual(git(checkout, 'branch', '--list', 'zen-backup/*'), '');
});

test('applyZen archives old stashes as refs and clears the stash list', () => {
  const { checkout } = createRepo();
  write(checkout, 'app.js', 'stashed work\n');
  git(checkout, 'stash', 'push', '-q');
  const stashed = git(checkout, 'rev-parse', 'refs/stash');
  const now = later();
  const tag = tagFor(now);

  const result = zenApply.applyZen({ cwd: checkout, now, freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.deepStrictEqual(result.done, ['saved 1 old stash away']);
  assert.deepStrictEqual(result.saved, [`refs/archive/zen-${tag}`]);
  assert.strictEqual(git(checkout, 'stash', 'list'), '');
  assert.strictEqual(git(checkout, 'rev-parse', `refs/archive/zen-${tag}/stash-000`), stashed);
});

test('applyZen catches a clean checkout up to origin', () => {
  const { checkout, seed } = createRepo();
  commit(seed, 'app.js', 'two\n', 'app two');
  commit(seed, 'app.js', 'three\n', 'app three');
  git(seed, 'push', '-q', 'origin', 'master');

  const result = zenApply.applyZen({ cwd: checkout, now: later(), freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.deepStrictEqual(result.done, ['caught up 2 commits from origin/master']);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
  assert.strictEqual(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'three\n');
});

test('applyZen moves unpushed commits to a backup branch and lines up with origin', () => {
  const { checkout } = createRepo();
  const origin = git(checkout, 'rev-parse', 'origin/master');
  commit(checkout, 'local.js', 'unpushed\n', 'local only');
  const unpushed = git(checkout, 'rev-parse', 'HEAD');
  const now = later();
  const tag = tagFor(now);

  const result = zenApply.applyZen({ cwd: checkout, now, freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.deepStrictEqual(result.done, [`moved 1 unpushed commit to zen-backup/${tag}-unpushed`]);
  assert.deepStrictEqual(result.saved, [`refs/heads/zen-backup/${tag}-unpushed`]);
  assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), origin);
  assert.strictEqual(git(checkout, 'rev-parse', `zen-backup/${tag}-unpushed`), unpushed);
  assert.strictEqual(fs.existsSync(path.join(checkout, 'local.js')), false);
});

test('applyZen goes back to main from an empty side branch and clears it as finished', () => {
  const { checkout } = createRepo();
  git(checkout, 'checkout', '-q', '-b', 'idea');

  const result = zenApply.applyZen({ cwd: checkout, now: later(), freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.zen, true);
  assert.deepStrictEqual(result.done, ['moved back to master (idea had nothing new)', 'cleared 1 finished branch']);
  assert.strictEqual(git(checkout, 'symbolic-ref', '--short', 'HEAD'), 'master');
  assert.strictEqual(git(checkout, 'branch', '--list', 'idea'), '');
});

test('applyZen keeps a side branch that has its own commits', () => {
  const { checkout } = createRepo();
  git(checkout, 'checkout', '-q', '-b', 'real-work');
  commit(checkout, 'feature.js', 'feature\n', 'feature');
  const tip = git(checkout, 'rev-parse', 'HEAD');

  const result = zenApply.applyZen({ cwd: checkout, now: later(), freshMinutes: 1 });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.done, ['moved back to master (real-work is kept)']);
  assert.strictEqual(git(checkout, 'symbolic-ref', '--short', 'HEAD'), 'master');
  assert.strictEqual(git(checkout, 'rev-parse', 'real-work'), tip);
});

test('applyZen puts away a clean idle side copy but keeps it when it was just used', () => {
  const { base, checkout } = createRepo();
  const side = path.join(base, 'side-copy');
  git(checkout, 'worktree', 'add', '-q', '-b', 'side-branch', side);

  const busy = zenApply.applyZen({ cwd: checkout, now: new Date(), freshMinutes: 60 });

  assert.strictEqual(busy.ok, true);
  assert.deepStrictEqual(busy.done, []);
  assert.deepStrictEqual(busy.left, ['1 side copy was used in the last 60 minutes, so it stays']);
  assert.ok(fs.existsSync(side));

  const idle = zenApply.applyZen({ cwd: checkout, now: later(), freshMinutes: 1 });

  assert.strictEqual(idle.ok, true);
  assert.strictEqual(idle.zen, true);
  assert.deepStrictEqual(idle.done, ['put away 1 idle side copy', 'cleared 1 finished branch']);
  assert.strictEqual(fs.existsSync(side), false);
  assert.strictEqual(git(checkout, 'branch', '--list', 'side-branch'), '');
});
