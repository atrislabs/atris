'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { codeStatus } = require('../lib/member-autoland');

test('keeps real changes and drops atris bookkeeping files', () => {
  const state = {
    status: [
      ' M lib/member-autoland.js',
      '?? src/new-file.js',
      '?? .atris/state/tasks.projection.json',
      '?? atris/runs/run-1/receipt.md',
      '?? atris/status/now.json',
      '?? atris/logs/journal.jsonl',
      '?? atris/team/max/logs/2026-01-01.md',
    ].join('\n'),
  };
  assert.equal(codeStatus(state), ' M lib/member-autoland.js\n?? src/new-file.js');
});

test('a tracked edit under a bookkeeping path still counts as a code change', () => {
  // Only '?? ' untracked lines are bookkeeping; a modified tracked file in
  // atris/logs is real state the caller must see.
  const state = { status: ' M atris/logs/journal.jsonl\n?? .atris/state/x.json' };
  assert.equal(codeStatus(state), ' M atris/logs/journal.jsonl');
});

test('a nested untracked team path is not bookkeeping', () => {
  // atris/team/<one segment>/logs/ is filtered; anything deeper is kept.
  const state = { status: '?? atris/team/max/logs/day.md\n?? atris/team/a/b/logs/day.md' };
  assert.equal(codeStatus(state), '?? atris/team/a/b/logs/day.md');
});

test('returns empty string when only bookkeeping or nothing is left', () => {
  assert.equal(codeStatus({ status: '?? .atris/state/x\n?? atris/logs/y' }), '');
  assert.equal(codeStatus({ status: '' }), '');
});

test('returns null when the state or its status is missing', () => {
  assert.equal(codeStatus(null), null);
  assert.equal(codeStatus(undefined), null);
  assert.equal(codeStatus({}), null);
  assert.equal(codeStatus({ status: null }), null);
});
