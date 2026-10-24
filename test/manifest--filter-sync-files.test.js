'use strict';

// filterSyncFiles drops paths that sync must never touch: anything under a
// skipped directory such as node_modules, .atris, or .git. It is pure: no
// filesystem, no environment, no clock. These tests only pass plain objects in.

const { test } = require('node:test');
const assert = require('node:assert');
const { filterSyncFiles } = require('../lib/manifest');

const entry = (hash, size = 1) => ({ hash, size });

test('drops files under ignored directories and keeps ordinary paths', () => {
  const input = {
    '/notes.md': entry('a'),
    '/docs/guide.md': entry('b'),
    '/node_modules/left-pad/index.js': entry('c'),
    '/.atris/state.json': entry('d'),
    '/.git/HEAD': entry('e'),
    '/src/tmp/scratch.txt': entry('f'),
    '/Library/Preferences/app.plist': entry('g'),
  };

  const out = filterSyncFiles(input);

  assert.deepStrictEqual(out, {
    '/notes.md': entry('a'),
    '/docs/guide.md': entry('b'),
  });
});

test('keeps .github and top-level dotfiles, but drops files in nested dot directories', () => {
  const input = {
    '/.github/workflows/ci.yml': entry('ci'),
    '/.env.example': entry('env'),
    '/src/.hidden/secret.js': entry('hidden'),
    '/.claude/settings.json': entry('claude'),
  };

  const out = filterSyncFiles(input);

  assert.deepStrictEqual(Object.keys(out).sort(), [
    '/.env.example',
    '/.github/workflows/ci.yml',
  ]);
});

test('treats Windows-style backslash paths the same as slash paths', () => {
  const input = {
    'docs\\readme.md': entry('ok'),
    '\\node_modules\\pkg\\index.js': entry('skip-1'),
    '\\.atris\\state.json': entry('skip-2'),
  };

  const out = filterSyncFiles(input);

  assert.deepStrictEqual(out, { 'docs\\readme.md': entry('ok') });
});

test('returns an empty object for missing, null, or empty input', () => {
  assert.deepStrictEqual(filterSyncFiles(), {});
  assert.deepStrictEqual(filterSyncFiles(undefined), {});
  assert.deepStrictEqual(filterSyncFiles(null), {});
  assert.deepStrictEqual(filterSyncFiles({}), {});
});

test('does not mutate the input and passes each kept entry through unchanged', () => {
  const kept = entry('keep', 42);
  const input = {
    '/keep.md': kept,
    '/node_modules/drop.js': entry('drop'),
  };
  const before = JSON.stringify(input);

  const out = filterSyncFiles(input);

  assert.equal(JSON.stringify(input), before, 'input object was changed');
  assert.ok(Object.keys(input).includes('/node_modules/drop.js'));
  assert.strictEqual(out['/keep.md'], kept, 'kept entry should be the same object');
  assert.notStrictEqual(out, input, 'should return a new object');
});
