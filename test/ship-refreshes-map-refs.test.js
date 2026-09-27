'use strict';

// Ship refreshes moved map line refs on its own. The step runs the same fix as
// `atris doc-health --fix-refs`, commits only the rewritten map files, and never
// blocks the ship on a human-only remainder or an error. These tests drive the
// step as a function against a temp git repo; no real ship, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { refreshMovedMapRefs } = require('../commands/worktree');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ship-map-refs-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function capture(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), stdout: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

const TOOL_BEFORE = `'use strict';

function alphaTool() {
  return 1;
}

module.exports = { alphaTool };
`;

const TOOL_AFTER = `'use strict';

// one
// two
// three
// four
// five
function alphaTool() {
  return 1;
}

module.exports = { alphaTool };
`;

const MAP_TEXT = `# map

- tool entry \`lib/tool.js:3\` (\`alphaTool\`) returns one.
`;

function initRepo(dir) {
  runGit(['init'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test'], dir);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'tool.js'), TOOL_BEFORE);
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), MAP_TEXT);
  runGit(['add', '-A'], dir);
  runGit(['commit', '-m', 'seed'], dir);
}

function moveFunction(dir) {
  fs.writeFileSync(path.join(dir, 'lib', 'tool.js'), TOOL_AFTER);
  runGit(['add', '-A'], dir);
  runGit(['commit', '-m', 'move alphaTool down'], dir);
}

test('a moved map ref gets a follow-up commit with the refreshed line', () => {
  const dir = makeTempDir();
  try {
    initRepo(dir);
    moveFunction(dir);

    const { result, stdout } = capture(() => refreshMovedMapRefs(dir));
    assert.equal(result.refreshed, 1);
    assert.match(stdout, /map: refreshed 1 moved references/);

    assert.equal(runGit(['rev-list', 'HEAD', '--count'], dir), '3');
    assert.equal(runGit(['log', '-1', '--format=%s'], dir), 'Refresh map references that moved');
    assert.match(runGit(['log', '-1', '--format=%B'], dir), /Co-authored-by: Atris/);
    assert.equal(runGit(['show', '--name-only', '--format=', 'HEAD'], dir), 'atris/MAP.md');
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), /`lib\/tool\.js:8`/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a repo with current refs gets no extra commit', () => {
  const dir = makeTempDir();
  try {
    initRepo(dir);

    const { result, stdout } = capture(() => refreshMovedMapRefs(dir));
    assert.equal(result.refreshed, 0);
    assert.match(stdout, /map: references current/);
    assert.equal(runGit(['rev-list', 'HEAD', '--count'], dir), '1');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), MAP_TEXT);
  } finally {
    cleanupTempDir(dir);
  }
});

test('an error in the refresh prints a warning and does not throw', () => {
  const dir = makeTempDir();
  try {
    initRepo(dir);
    const mapFile = path.join(dir, 'atris', 'MAP.md');
    fs.chmodSync(mapFile, 0o000);

    const { result, stdout } = capture(() => refreshMovedMapRefs(dir));
    assert.equal(result.refreshed, 0);
    assert.ok(result.error);
    assert.match(stdout, /^map: refresh skipped \(.+\); the ship continues$/m);
    assert.equal(runGit(['rev-list', 'HEAD', '--count'], dir), '1');

    fs.chmodSync(mapFile, 0o644);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--no-map-refresh skips the step entirely', () => {
  const dir = makeTempDir();
  try {
    initRepo(dir);
    moveFunction(dir);

    const { result, stdout } = capture(() => refreshMovedMapRefs(dir, ['--no-map-refresh']));
    assert.equal(result.skipped, true);
    assert.equal(stdout, '');
    assert.equal(runGit(['rev-list', 'HEAD', '--count'], dir), '2');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), MAP_TEXT);
  } finally {
    cleanupTempDir(dir);
  }
});
