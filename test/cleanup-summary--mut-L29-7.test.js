'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendOvernightNote } = require('../lib/cleanup-summary');

// Fixed local time, so the journal path never depends on today's date or the zone.
const now = new Date(2026, 9, 6, 9);

function project(t, { withAtris = true } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-mut-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project-demo');
  fs.mkdirSync(root, { recursive: true });
  if (withAtris) fs.mkdirSync(path.join(root, 'atris'));
  return root;
}

test('an empty note is refused and writes no journal, even when the atris folder exists', (t) => {
  const root = project(t);
  assert.equal(appendOvernightNote(root, '   ', now), false);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'logs')), false);
});

test('a note is refused when there is no atris folder, and nothing is created', (t) => {
  const root = project(t, { withAtris: false });
  assert.equal(appendOvernightNote(root, 'Autoland: Landed 1 finished item.', now), false);
  assert.equal(fs.existsSync(path.join(root, 'atris')), false);
});
