'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendJsonLine } = require('../lib/wish-store');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wish-store-append-'));
}

test('appendJsonLine creates missing parent dirs, writes one JSON line, and returns the file path', () => {
  const root = makeTmp();
  try {
    const file = path.join(root, 'nested', 'state', 'wishes.jsonl');
    const record = { kind: 'steer', wish_id: 'wish-2026-10-23-a', note: 'keep it small' };

    const returned = appendJsonLine(file, record);

    assert.equal(returned, file);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(record)}\n`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim()), record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appendJsonLine appends in order and keeps earlier lines intact', () => {
  const root = makeTmp();
  try {
    const file = path.join(root, 'wishes.jsonl');
    const first = { id: 'wish-1', text: 'first' };
    const second = {};

    appendJsonLine(file, first);
    appendJsonLine(file, second);

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.deepEqual(lines, [JSON.stringify(first), '{}', '']);
    assert.deepEqual(JSON.parse(lines[0]), first);
    assert.deepEqual(JSON.parse(lines[1]), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appendJsonLine escapes embedded newlines so a record stays on one physical line', () => {
  const root = makeTmp();
  try {
    const file = path.join(root, 'wishes.jsonl');
    const record = { text: 'line one\nline two', emoji: 'ok' };

    appendJsonLine(file, record);

    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.split('\n').length, 2);
    assert.equal(raw, `${JSON.stringify(record)}\n`);
    assert.deepEqual(JSON.parse(raw.trimEnd()), record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appendJsonLine throws on a circular record and writes nothing to the file', () => {
  const root = makeTmp();
  try {
    const file = path.join(root, 'wishes.jsonl');
    const record = { id: 'wish-loop' };
    record.self = record;

    assert.throws(() => appendJsonLine(file, record), TypeError);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
