'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brain-read-text-'));
process.env.HOME = root;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { readText } = require('../commands/brain');

test('readText returns the exact text of a normal file', () => {
  const file = path.join(root, 'note.txt');
  const body = 'first line\nsecond line\ncafé\n';
  fs.writeFileSync(file, body, 'utf8');
  assert.strictEqual(readText(file), body);
});

test('readText returns an empty string for an empty file', () => {
  const file = path.join(root, 'empty.txt');
  fs.writeFileSync(file, '', 'utf8');
  assert.strictEqual(readText(file), '');
});

test('readText returns an empty string when the path cannot be read', () => {
  assert.strictEqual(readText(path.join(root, 'missing.txt')), '');
  const dir = path.join(root, 'folder');
  fs.mkdirSync(dir);
  assert.strictEqual(readText(dir), '');
});
