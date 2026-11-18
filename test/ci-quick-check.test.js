'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pick, main, describeCover } = require('../scripts/ci-quick-check');

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

test('the quick check runs with eight concurrent test files', (t) => {
  const { root } = fixture(t);
  write(root, 'test/quick.test.js', [
    "const assert = require('node:assert/strict');",
    "assert.ok(process.execArgv.includes('--test-concurrency=8'));",
    marker('quick'),
  ].join('\n'));
  assert.deepEqual(runCheck(root, 'HEAD'), ['quick']);
});

test('groups share the picked files: each runs once, and a spare group runs none', (t) => {
  const { root, base } = fixture(t);
  const ran = [1, 2, 3].flatMap((i) => runCheck(root, base, `${i}/3`));
  assert.deepEqual(ran.sort(), ['added', 'edited', 'moved', 'quick', 'with space']);
  assert.deepEqual(runCheck(root, base, '8/8'), []);
});

// An expression that requires `spec`. Built, not written out, so this file does
// not itself look like it requires the real files its fixtures are named after.
const needs = (spec) => `require(${JSON.stringify(spec)})`;

// A small repo shaped like this one: libs, a command that requires a lib, test
// helpers, and tests that reach the libs directly, through another file, or
// through a hub. `change` is the pull request, applied on top of the base.
function coverRepo(t, change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-quick-cover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'test/fast-tests.txt', 'test/quick.test.js\n');
  write(root, 'test/quick.test.js', marker('quick'));
  write(root, 'README.md', '# readme\n');
  write(root, 'lib/feed-core.js', 'module.exports = { name: "core" };\n');
  write(root, 'lib/feed-room.js', `module.exports = { core: () => ${needs('./feed-core')} };\n`);
  write(root, 'commands/decision-feed.js', `module.exports = ${needs('../lib/feed-room')};\n`);
  write(root, 'test/feed-discussion.test.js', `${marker('feed-discussion')}${needs('../lib/feed-room')};\n`);
  write(root, 'test/decision-feed.test.js', `${marker('decision-feed')}${needs('../commands/decision-feed')};\n`);
  write(root, 'test/unrelated.test.js', marker('unrelated'));
  write(root, 'lib/hub.js', 'module.exports = {};\n');
  write(root, 'lib/uses-hub.js', `module.exports = ${needs('./hub')};\n`);
  for (const name of ['a', 'b', 'c']) write(root, `test/hub-${name}.test.js`, `${marker(`hub-${name}`)}${needs('../lib/hub')};\n`);
  write(root, 'test/hub-deep.test.js', `${marker('hub-deep')}${needs('../lib/uses-hub')};\n`);
  write(root, 'test/helpers/project.js', `module.exports = ${needs('../../lib/feed-core')};\n`);
  write(root, 'test/feed-helper-user.test.js', `${marker('feed-helper-user')}${needs('./helpers/project')};\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  change(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'pull request');
  return { root, base };
}

const edit = (file) => (root) => write(root, file, fs.readFileSync(path.join(root, file), 'utf8') + '// changed\n');

test('a changed lib selects the tests that require it, directly or through another file', (t) => {
  const { root, base } = coverRepo(t, edit('lib/feed-room.js'));
  const picked = pick(root, base);
  assert.deepEqual(picked.changed, []);
  assert.deepEqual(picked.covering, [
    { source: 'lib/feed-room.js', total: 2, tests: ['test/feed-discussion.test.js', 'test/decision-feed.test.js'] },
  ]);
  assert.deepEqual([...picked.files].sort(), [
    'test/decision-feed.test.js', 'test/feed-discussion.test.js', 'test/quick.test.js',
  ]);
});

test('a changed README, doc, or file nothing requires selects nothing extra', (t) => {
  const { root, base } = coverRepo(t, (dir) => {
    edit('README.md')(dir);
    write(dir, 'docs/guide.md', 'new\n');
    write(dir, 'lib/orphan.js', 'module.exports = 1;\n');
  });
  const picked = pick(root, base);
  assert.deepEqual(picked.covering, []);
  assert.deepEqual(picked.files, ['test/quick.test.js']);
});

test('a test file another test requires is passed through, never counted on its own', (t) => {
  const { root, base } = coverRepo(t, edit('lib/feed-core.js'));
  const [entry] = pick(root, base).covering;
  assert.equal(entry.source, 'lib/feed-core.js');
  // feed-helper-user reaches it through test/helpers/project.js, which is not a test to run.
  // Nearest first: two requires away, then three.
  assert.deepEqual(entry.tests, [
    'test/feed-discussion.test.js', 'test/feed-helper-user.test.js', 'test/decision-feed.test.js',
  ]);
  assert.equal(entry.tests.includes('test/helpers/project.js'), false);
});

test('over the cap, the nearest tests stay and the merge queue covers the rest', (t) => {
  const { root, base } = coverRepo(t, edit('lib/hub.js'));
  // Three tests require the hub directly, one more reaches it through another file.
  const roomy = pick(root, base).covering[0];
  assert.deepEqual([roomy.total, roomy.tests.length], [4, 4]);
  const partial = pick(root, base, { cap: 3 }).covering[0];
  assert.deepEqual(partial.tests, ['test/hub-a.test.js', 'test/hub-b.test.js', 'test/hub-c.test.js']);
  assert.equal(partial.total, 4);
});

test('when even the nearest tests are over the cap, nothing is added for that file', (t) => {
  const { root, base } = coverRepo(t, edit('lib/hub.js'));
  const picked = pick(root, base, { cap: 2 });
  assert.deepEqual(picked.covering, [{ source: 'lib/hub.js', total: 4, tests: [] }]);
  assert.deepEqual(picked.files, ['test/quick.test.js']);
});

test('recorded run time limits what a file adds, so slow tests cannot stretch the check', (t) => {
  const { root, base } = coverRepo(t, edit('lib/hub.js'));
  const slow = { 'test/hub-a.test.js': 30000, 'test/hub-b.test.js': 30000, 'test/hub-c.test.js': 30000 };
  const over = pick(root, base, { weights: slow, milliseconds: 60000 }).covering[0];
  assert.deepEqual(over.tests, []);
  // The nearest ring fits; the slow test one require further out does not.
  const far = pick(root, base, { weights: { 'test/hub-deep.test.js': 59000 }, milliseconds: 60000 }).covering[0];
  assert.deepEqual([far.tests, far.total], [['test/hub-a.test.js', 'test/hub-b.test.js', 'test/hub-c.test.js'], 4]);
});

test('the time limit is shared by every changed file, and a test two files reach is charged once', (t) => {
  const { root, base } = coverRepo(t, (dir) => {
    edit('lib/hub.js')(dir);
    edit('lib/feed-room.js')(dir);
    edit('lib/feed-core.js')(dir);
  });
  // Each test is 1 s except the hub's three, 59 s together. feed-room and
  // feed-core reach decision-feed and feed-discussion between them, so those
  // cost 1 s each once, and feed-helper-user 1 s: 3 s, then the hub's 59 s.
  const weights = { 'test/hub-a.test.js': 20000, 'test/hub-b.test.js': 20000, 'test/hub-c.test.js': 19000 };
  const fits = pick(root, base, { weights, milliseconds: 62000 });
  assert.deepEqual(fits.covering.find((entry) => entry.source === 'lib/hub.js').tests,
    ['test/hub-a.test.js', 'test/hub-b.test.js', 'test/hub-c.test.js']);
  const short = pick(root, base, { weights, milliseconds: 61999 });
  assert.deepEqual(short.covering.find((entry) => entry.source === 'lib/hub.js').tests, []);
  // The cheap files are served first, whatever their names.
  assert.deepEqual(short.covering.find((entry) => entry.source === 'lib/feed-room.js').tests,
    ['test/feed-discussion.test.js', 'test/decision-feed.test.js']);
  assert.equal(short.files.includes('test/hub-a.test.js'), false);
});

test('a deleted or moved lib selects the tests that still require it', (t) => {
  const { root, base } = coverRepo(t, (dir) => {
    fs.rmSync(path.join(dir, 'lib/feed-room.js'));
    write(dir, 'lib/feed-room-new.js', 'module.exports = {};\n');
  });
  const picked = pick(root, base);
  assert.deepEqual(picked.covering.map((entry) => entry.source), ['lib/feed-room.js']);
  assert.deepEqual(picked.covering[0].tests, ['test/feed-discussion.test.js', 'test/decision-feed.test.js']);
});

test('a changed test and the tests it covers are each picked once', (t) => {
  const { root, base } = coverRepo(t, (dir) => {
    edit('lib/feed-room.js')(dir);
    edit('test/feed-discussion.test.js')(dir);
    edit('test/quick.test.js')(dir);
  });
  const picked = pick(root, base);
  assert.deepEqual(picked.changed.sort(), ['test/feed-discussion.test.js', 'test/quick.test.js']);
  assert.deepEqual([...picked.files].sort(), [
    'test/decision-feed.test.js', 'test/feed-discussion.test.js', 'test/quick.test.js',
  ]);
});

function runMain(root, ...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['-e',
    'process.exitCode = require(process.argv[1]).main(JSON.parse(process.argv[2]), process.argv[3])',
    path.join(__dirname, '../scripts/ci-quick-check.js'), JSON.stringify(args), root],
  { encoding: 'utf8', timeout: 30000, env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const ran = run.stdout.split('\n').flatMap((line) => {
    const match = /^(?:# )?ran (.*)$/.exec(line);
    return match ? [match[1]] : [];
  });
  return { ran: ran.sort(), out: run.stdout };
}

test('the check runs the covering tests, says why, and splits them across groups', (t) => {
  const { root, base } = coverRepo(t, edit('lib/feed-room.js'));
  const whole = runMain(root, base);
  assert.deepEqual(whole.ran, ['decision-feed', 'feed-discussion', 'quick']);
  assert.match(whole.out, /tests that reach the changed source files: 2 added\./);
  assert.match(whole.out, /lib\/feed-room\.js: all 2 test files that reach it\./);
  const ran = [1, 2, 3].flatMap((i) => runMain(root, base, `${i}/3`).ran);
  assert.deepEqual(ran.sort(), ['decision-feed', 'feed-discussion', 'quick']);
});

test('the summary says when the merge queue covers a file or the rest of it', (t) => {
  const { root, base } = coverRepo(t, edit('lib/hub.js'));
  const skipped = describeCover(pick(root, base, { cap: 2 }), { cap: 2, milliseconds: 90000 });
  assert.deepEqual(skipped, [
    'tests that reach the changed source files: 0 added.',
    '  lib/hub.js: 4 test files reach it, over the limit for a pull request (2 files, 90 s of tests); the merge queue covers it.',
  ]);
  const partial = describeCover(pick(root, base, { cap: 3 }), { cap: 3 });
  assert.equal(partial[1], '  lib/hub.js: the 3 nearest of 4 test files that reach it; the merge queue covers the rest.');
  assert.deepEqual(partial.slice(2), ['  test/hub-a.test.js', '  test/hub-b.test.js', '  test/hub-c.test.js']);
});

test('a pull request that touches no source prints no covering section', (t) => {
  const { root, base } = coverRepo(t, edit('README.md'));
  const plain = runMain(root, base);
  assert.deepEqual(plain.ran, ['quick']);
  assert.doesNotMatch(plain.out, /reach the changed source/);
});
