'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ephemeralApplyMessage,
  hintEphemeralApply,
  ensureApply,
} = require('../lib/apply-gate');

test('ephemeralApplyMessage names the surface', () => {
  assert.equal(
    ephemeralApplyMessage('notes'),
    'next: write one apply (change + receipt) for this notes',
  );
  assert.equal(
    ephemeralApplyMessage('teach'),
    'next: write one apply (change + receipt) for this teach',
  );
  assert.equal(
    ephemeralApplyMessage('x-search'),
    'next: write one apply (change + receipt) for this x-search',
  );
});

test('hintEphemeralApply prints once and writes no files', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-hint-'));
  const output = [];
  const status = hintEphemeralApply((line) => output.push(line), 'notes');
  assert.equal(status, 0);
  assert.deepEqual(output, [ephemeralApplyMessage('notes')]);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('ensureApply still files a sidecar when asked', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apply-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki', 'briefs'), { recursive: true });
  const output = [];
  const rel = 'atris/wiki/briefs/youtube-hint01.apply.md';
  const status = ensureApply({
    cwd,
    source: 'https://youtu.be/hint01',
    rel,
    now: '2026-08-28',
    output: (line) => output.push(line),
    incompleteMessage: 'next: apply atris/experiments/notes-hint01',
    required: false,
    change: 'apply atris/experiments/notes-hint01',
    receipt: 'keep only if measure.py moves 0→1',
  });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(path.join(cwd, rel)), true);
  assert.match(output.join('\n'), /next: apply atris\/experiments\/notes-hint01/);
  assert.equal(output.includes(ephemeralApplyMessage('notes')), false);
});
