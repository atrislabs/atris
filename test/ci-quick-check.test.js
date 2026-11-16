'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pick, main } = require('../scripts/ci-quick-check');

function git(root, ...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

const marker = (name) => `console.log('ran ${name}');\n`;

// A repo with a base commit, then a pull request that adds, edits, deletes,
// and renames tests, adds one with a space in its name, and edits other files.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-quick-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'test/fast-tests.txt', 'test/quick.test.js\n');
  for (const name of ['quick', 'edited', 'deleted', 'moved', 'untouched']) {
    write(root, `test/${name}.test.js`, marker(name));
  }
  write(root, 'lib/thing.js', 'module.exports = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  write(root, 'test/edited.test.js', marker('edited') + '// changed\n');
  write(root, 'test/added.test.js', marker('added'));
  write(root, 'test/with space.test.js', marker('with space'));
  write(root, 'test/notes.md', 'not a test\n');
  write(root, 'lib/thing.js', 'module.exports = 2;\n');
  fs.rmSync(path.join(root, 'test/deleted.test.js'));
  git(root, 'mv', 'test/moved.test.js', 'test/renamed.test.js');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'pull request');
  return { root, base };
}

test('picks the quick list plus added, edited, and renamed tests, never deleted ones', (t) => {
  const { root, base } = fixture(t);
  const picked = pick(root, base);
  assert.deepEqual(picked.quick, ['test/quick.test.js']);
  assert.deepEqual([...picked.changed].sort(), [
    'test/added.test.js', 'test/edited.test.js', 'test/renamed.test.js', 'test/with space.test.js',
  ]);
  assert.equal(picked.files.length, 5);
});

test('a pull request with no test changes runs only the quick list, without duplicates', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(pick(root, 'HEAD').changed, []);
  write(root, 'test/quick.test.js', marker('quick') + '// changed\n');
  git(root, 'commit', '-qam', 'edit a quick test');
  assert.deepEqual(pick(root, 'HEAD^1').files, ['test/quick.test.js']);
});

function runCheck(root, ...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['-e',
    'process.exitCode = require(process.argv[1]).main(JSON.parse(process.argv[2]), process.argv[3])',
    path.join(__dirname, '../scripts/ci-quick-check.js'), JSON.stringify(args), root],
  { encoding: 'utf8', timeout: 30000, env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return run.stdout.split('\n').flatMap((line) => {
    const match = /^(?:# )?ran (.*)$/.exec(line);
    return match ? [match[1]] : [];
  });
}

test('runs exactly the picked files and fails closed on a bad base or a stale quick list', (t) => {
  const { root, base } = fixture(t);
  assert.deepEqual(runCheck(root, base).sort(), ['added', 'edited', 'moved', 'quick', 'with space']);

  assert.equal(main(['no-such-revision'], root), 1);
  assert.equal(main([], root), 1);
  for (const group of ['0/2', '3/2', '1/0', 'half']) assert.equal(main([base, group], root), 1);
  assert.equal(main([base, '1/2', 'extra'], root), 1);
  write(root, 'test/fast-tests.txt', 'test/quick.test.js\ntest/deleted.test.js\n');
  assert.equal(main([base], root), 1);
});

test('groups share the picked files: each runs once, and a spare group runs none', (t) => {
  const { root, base } = fixture(t);
  const ran = [1, 2, 3].flatMap((i) => runCheck(root, base, `${i}/3`));
  assert.deepEqual(ran.sort(), ['added', 'edited', 'moved', 'quick', 'with space']);
  assert.deepEqual(runCheck(root, base, '8/8'), []);
});
