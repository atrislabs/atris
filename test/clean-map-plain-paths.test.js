'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { healBrokenMapRefs } = require('../commands/clean');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempAtris(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-path-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const atrisDir = path.join(dir, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  return { dir, atrisDir };
}

function write(dir, rel, content = '') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runCleanCli(dir) {
  const env = { ...process.env, HOME: dir, ATRIS_SKIP_UPDATE_CHECK: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATRIS_') && key !== 'ATRIS_SKIP_UPDATE_CHECK') delete env[key];
  }
  const out = spawnSync(process.execPath, [BIN, 'clean', '--dry-run'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test('a plain backticked path to a missing file is reported, with the map line', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'commands/real.js', 'module.exports = 1;\n');
  const map = '# MAP\n\nReal: `commands/real.js`\nGone: `commands/gone.js`\n';
  write(dir, 'atris/MAP.md', map);

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.healed, 0);
  assert.equal(result.checked, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.unhealable, [
    { file: 'commands/gone.js', line: null, mapLine: 4, map: 'atris/MAP.md', reason: 'missing file', plain: true },
  ]);
  assert.equal(fs.readFileSync(path.join(atrisDir, 'MAP.md'), 'utf8'), map, 'plain paths are never rewritten');

  const stdout = runCleanCli(dir);
  assert.match(stdout, /commands\/gone\.js: missing file \(atris\/MAP\.md:4\)/);
  assert.match(stdout, /checked 2 refs/);
  assert.doesNotMatch(stdout, /all MAP\.md refs valid/i);
});

test('a map with nothing checkable says it checked zero refs, never all valid', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'atris/MAP.md', '# MAP\n\nJust prose with `a-word` in backticks.\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);
  assert.equal(result.checked, 0);
  assert.deepEqual(result.unhealable, []);

  const stdout = runCleanCli(dir);
  assert.match(stdout, /checked 0 refs, nothing to validate/);
  assert.doesNotMatch(stdout, /all MAP\.md refs valid/i);
});

test('a map where every ref checks out says all valid with the count', (t) => {
  const { dir } = makeTempAtris(t);
  write(dir, 'lib/entry.js', 'function entry() {}\n');
  write(dir, 'atris/MAP.md', '`lib/entry.js:1` (entry function) and `lib/entry.js`\n');

  const stdout = runCleanCli(dir);
  assert.match(stdout, /all MAP\.md refs valid \(checked 2 refs\)/);
  assert.doesNotMatch(stdout, /All MAP\.md/);
});

test('a path whose first folder is not in this project is skipped, not flagged', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'commands/real.js', '');
  write(dir, 'atris/MAP.md', 'Other project: `ecosystem/openclaw/README.md`\nUp a level: `../sibling/notes.md`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.deepEqual(result.unhealable, []);
  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 2);
});

test('a line-numbered ref counts once and is not read again as a plain path', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'lib/entry.js', 'function entry() {}\n');
  write(dir, 'atris/MAP.md', '`lib/entry.js:1`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.checked, 1);
  assert.deepEqual(result.unhealable, []);
});

test('a path written from the map folder counts once even when it repeats', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'atris/refs/MAP-NOTES.md', '# notes\n');
  write(dir, 'atris/MAP.md', '`refs/MAP-NOTES.md` and again `refs/MAP-NOTES.md`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.checked, 1);
  assert.deepEqual(result.unhealable, []);
});

test('a missing path the repo ignores is a runtime file and is skipped', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  write(dir, '.gitignore', 'runtime/\n');
  write(dir, 'runtime/keep.txt', 'x');
  write(dir, 'atris/MAP.md', 'State: `runtime/state.json`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.deepEqual(result.unhealable, []);
  assert.equal(result.skipped, 1);
});

test('plain paths inside a notes file are reported with that notes file as the map', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'commands/real.js', '');
  write(dir, 'atris/MAP.md', '# MAP\n');
  write(dir, 'atris/refs/MAP-NOTES.md', '# notes\n\nDead: `commands/dead.md`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.unhealable.length, 1);
  assert.equal(result.unhealable[0].file, 'commands/dead.md');
  assert.equal(result.unhealable[0].map, 'atris/refs/MAP-NOTES.md');
  assert.equal(result.unhealable[0].mapLine, 3);
});

test('a missing path written from the map folder is flagged when that folder holds its first folder', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'atris/refs/MAP-NOTES.md', '# notes\n');
  write(dir, 'atris/MAP.md', 'Notes: `refs/map/missing.md`\nOther project: `ecosystem/openclaw/README.md`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.unhealable.length, 1);
  assert.equal(result.unhealable[0].file, 'refs/map/missing.md');
  assert.equal(result.unhealable[0].mapLine, 1);
  assert.equal(result.skipped, 1, 'the other project path is still skipped');
});

test('a path that resolves outside the project is skipped, however it is spelled', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'lib/real.js', '');
  write(dir, 'atris/MAP.md', 'Outside: `./../../lib/missing.js` and `../../lib/missing.js`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.deepEqual(result.unhealable, []);
  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 2);
});

test('a climbing path that lands inside the project from the map folder is still checked', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'lib/real.js', '');
  write(dir, 'atris/MAP.md', 'Sibling: `./../lib/missing.js` and `../lib/real.js`\n');

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.equal(result.checked, 2);
  assert.deepEqual(result.unhealable.map((entry) => entry.file), ['./../lib/missing.js']);
});

test('paths inside fenced code blocks are examples, not map references', (t) => {
  const { dir, atrisDir } = makeTempAtris(t);
  write(dir, 'commands/real.js', '');
  const map = [
    '# MAP',
    '',
    '```js',
    "const x = require('`commands/example-one.js`');",
    '```',
    '',
    '~~~',
    '`commands/example-two.js`',
    '~~~',
    '',
    'Real: `commands/missing.js`',
    '',
  ].join('\n');
  write(dir, 'atris/MAP.md', map);

  const result = healBrokenMapRefs(dir, atrisDir, true);

  assert.deepEqual(result.unhealable.map((entry) => [entry.file, entry.mapLine]), [['commands/missing.js', 11]]);
  assert.equal(result.checked, 1);
});
