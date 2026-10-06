'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendOvernightNote, latestCleanupLine, tickSummaryLine } = require('../lib/cleanup-summary');

function project(name = 'project-demo') {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-summary-')), name);
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

test('the tick line is plain, counts what happened, and is silent when nothing did', () => {
  assert.equal(tickSummaryLine({}), null);
  assert.equal(tickSummaryLine({ needYou: 6 }), null);
  assert.equal(
    tickSummaryLine({ landed: 12, closed: 1, needYou: 6 }),
    'Autoland: Landed 12 finished items; closed 1 idle item that could never land on their own, each with a plain reason; 6 need you (money, deploys, security, or customers).',
  );
});

test('notes land in the project overnight section once, and boot reads the newest one back', () => {
  const root = project();
  const now = new Date(2026, 9, 6, 9);
  assert.equal(appendOvernightNote(root, 'Review sweep: Closed 3 duplicates.', now), true);
  assert.equal(appendOvernightNote(root, 'Review sweep: Closed 3 duplicates.', now), false);
  assert.equal(appendOvernightNote(root, 'Autoland: Landed 2 finished items.', now), true);
  const file = path.join(root, 'atris', 'logs', '2026', '2026-10-06.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## demo overnight\n- Review sweep: Closed 3 duplicates\.\n- Autoland: Landed 2 finished items\.\n/);
  assert.equal(latestCleanupLine(root, { now }), 'Autoland: Landed 2 finished items.');
  // Yesterday's line still shows first thing in the morning.
  assert.equal(latestCleanupLine(root, { now: new Date(2026, 9, 7, 7) }), 'Autoland: Landed 2 finished items.');
  assert.equal(latestCleanupLine(project('empty')), '');
});
