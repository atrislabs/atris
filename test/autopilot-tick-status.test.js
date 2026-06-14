'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTickStatus } = require('../commands/autopilot');

function withWorkspace(persona) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tick-status-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  if (persona != null) fs.writeFileSync(path.join(dir, 'atris', 'PERSONA.md'), persona);
  try {
    return getTickStatus(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getTickStatus uses the first prose line of PERSONA.md as identity, skipping markdown chrome', () => {
  const s = withWorkspace('# Title\n\n> a quote\n\nI am the navigator.\n');
  assert.equal(s.identity, 'I am the navigator.');
});

test('getTickStatus takes a leading prose line directly', () => {
  assert.equal(withWorkspace('Fast and focused operator.\n').identity, 'Fast and focused operator.');
});

test('getTickStatus falls back to a default identity when PERSONA.md is absent', () => {
  const s = withWorkspace(null);
  assert.match(s.identity, /no identity set/);
});

test('getTickStatus falls back to default when PERSONA.md has only headings/bullets/tables', () => {
  const s = withWorkspace('# Title\n- bullet\n| table |\n--- \n');
  assert.match(s.identity, /no identity set/);
});

test('getTickStatus reports the no-endgame default and a coherent shape without a TODO.md', () => {
  const s = withWorkspace('Operator.\n');
  assert.match(s.slug, /no endgame active/);
  assert.equal(typeof s.time, 'string');
  assert.equal(typeof s.total, 'number');
  assert.equal(typeof s.done, 'number');
  assert.equal(typeof s.remaining, 'number');
});
