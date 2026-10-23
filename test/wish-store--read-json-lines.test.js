'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonLines } = require('../lib/wish-store');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-store-read-json-lines-'));
}

function writeFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('readJsonLines parses each non-empty line in file order', () => {
  const dir = makeDir();
  try {
    const file = writeFile(
      dir,
      'wishes.jsonl',
      '{"kind":"create","id":"a"}\n\n   \n{"kind":"steer","wish_id":"a"}\r\n  {"kind":"close","id":"a"}  \n'
    );

    assert.deepStrictEqual(readJsonLines(file), [
      { kind: 'create', id: 'a' },
      { kind: 'steer', wish_id: 'a' },
      { kind: 'close', id: 'a' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonLines skips lines that are not valid JSON and keeps the rest', () => {
  const dir = makeDir();
  try {
    const file = writeFile(
      dir,
      'wishes.jsonl',
      '{"n":1}\nnot json at all\n{"n":2\n{"n":3}\n'
    );

    assert.deepStrictEqual(readJsonLines(file), [{ n: 1 }, { n: 3 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonLines returns an empty array when the file is missing or holds only blank lines', () => {
  const dir = makeDir();
  try {
    assert.deepStrictEqual(readJsonLines(path.join(dir, 'missing.jsonl')), []);

    const blank = writeFile(dir, 'blank.jsonl', '\n   \r\n\n');
    assert.deepStrictEqual(readJsonLines(blank), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
