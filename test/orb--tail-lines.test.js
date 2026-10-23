'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// tailLines is pure, but keep the process off this machine anyway.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-tail-lines-'));
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { tailLines } = require('../commands/orb');

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function numbered(total) {
  return Array.from({ length: total }, (_, i) => `line ${i + 1}`).join('\n');
}

test('tailLines keeps only the last N lines', () => {
  assert.equal(tailLines('a\nb\nc\nd', 2), 'c\nd');
  assert.equal(tailLines('a\nb\nc\nd', 1), 'd');
});

test('tailLines returns everything when there are fewer lines than the count', () => {
  assert.equal(tailLines('a\nb', 10), 'a\nb');
  assert.equal(tailLines('only', 5), 'only');
});

test('tailLines defaults to the last 60 lines', () => {
  const out = tailLines(numbered(100)).split('\n');
  assert.equal(out.length, 60);
  assert.equal(out[0], 'line 41');
  assert.equal(out[59], 'line 100');
});

test('tailLines drops one trailing newline so it does not count as a line', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
  assert.equal(tailLines('a\nb\n', 5), 'a\nb');
});

test('tailLines only drops a single trailing empty line, not every blank one', () => {
  assert.equal(tailLines('a\n\n', 5), 'a\n');
  assert.equal(tailLines('a\n\nb', 3), 'a\n\nb');
});

test('tailLines treats CRLF as a line break and returns plain newlines', () => {
  assert.equal(tailLines('a\r\nb\r\nc\r\n', 2), 'b\nc');
});

test('tailLines returns an empty string for empty or missing input', () => {
  assert.equal(tailLines(''), '');
  assert.equal(tailLines(null), '');
  assert.equal(tailLines(undefined), '');
  assert.equal(tailLines('\n'), '');
});

test('tailLines turns non-string input into text first', () => {
  assert.equal(tailLines(12345), '12345');
  assert.equal(tailLines(true), 'true');
});

test('tailLines with a count of zero returns every line (slice(-0) behaviour)', () => {
  assert.equal(tailLines('a\nb\nc', 0), 'a\nb\nc');
});
