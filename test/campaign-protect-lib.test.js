const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  campaignHome,
  changedProtected,
  headCommit,
  planProtect,
  protectFile,
  readProtect,
  saveProtect,
} = require('../lib/campaign-protect');

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function makeRepo(t) {
  const dir = makeTempDir(t, 'atris-protect-repo-');
  git(dir, ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'judge.md'), 'questions\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);\n');
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-qm', 'init']);
  return dir;
}

test('campaignHome and protectFile build paths beside the store', () => {
  const home = campaignHome({ path: path.join(path.sep, 'data', 'state', 'atris.db') });
  assert.equal(home, path.join(path.sep, 'data', 'state'));
  assert.equal(protectFile(home, 'cmp-abc'), path.join(home, 'campaigns', 'cmp-abc', 'protect.json'));
});

test('planProtect reports errors outside git and resolves paths inside a checkout', (t) => {
  const plain = makeTempDir(t, 'atris-protect-plain-');
  assert.deepEqual(planProtect(plain, ['a.txt']), { error: '--protect needs a git checkout' });

  const repo = makeTempDir(t, 'atris-protect-empty-');
  git(repo, ['init', '-q']);
  assert.deepEqual(planProtect(repo, ['a.txt']), { error: '--protect needs a checkout with at least one commit' });

  const root = makeRepo(t);
  const plan = planProtect(root, ['judge.md', 'src/app.js', 'judge.md']);
  assert.equal(plan.base_commit, headCommit(root));
  assert.deepEqual(plan.paths, ['judge.md', 'src/app.js']);

  const outside = planProtect(root, ['../elsewhere.txt']);
  assert.equal(outside.error, '--protect ../elsewhere.txt is not inside this checkout');
});

test('saveProtect writes protect.json and readProtect reads it back', (t) => {
  const home = makeTempDir(t, 'atris-protect-home-');
  assert.equal(readProtect(home, 'cmp-none'), null);

  const file = saveProtect(home, 'cmp-abc', { paths: ['judge.md'], base_commit: 'abc123' });
  assert.equal(file, protectFile(home, 'cmp-abc'));
  assert.deepEqual(readProtect(home, 'cmp-abc'), { paths: ['judge.md'], base_commit: 'abc123' });

  fs.mkdirSync(path.dirname(protectFile(home, 'cmp-bad')), { recursive: true });
  fs.writeFileSync(protectFile(home, 'cmp-bad'), 'not json');
  assert.equal(readProtect(home, 'cmp-bad'), null);
});

test('changedProtected names only protected paths that differ from base', (t) => {
  const root = makeRepo(t);
  const plan = planProtect(root, ['judge.md', 'new-rule.md']);
  const saved = { paths: plan.paths, base_commit: plan.base_commit };

  assert.deepEqual(changedProtected(root, saved), { changed: [] });

  fs.writeFileSync(path.join(root, 'judge.md'), 'tampered\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log(2);\n');
  fs.writeFileSync(path.join(root, 'new-rule.md'), 'added\n');
  assert.deepEqual(changedProtected(root, saved), { changed: ['judge.md', 'new-rule.md'] });

  const bad = changedProtected(root, { paths: ['judge.md'], base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.match(bad.error, /^cannot compare with deadbeefdead: /);
});
