'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { dejargon } = require('../lib/autoland');

test('dejargon turns flags, snake_case and camelCase into plain words', () => {
  assert.strictEqual(dejargon('run it with --dry-run'), 'run it with dry run');
  assert.strictEqual(dejargon('the mission_ready queue is stuck'), 'the mission ready queue is stuck');
  assert.strictEqual(dejargon('fix mergeConflict handling'), 'fix merge Conflict handling');
  assert.strictEqual(dejargon('MAX_RETRY_COUNT was too low'), 'MAX RETRY COUNT was too low');
  assert.strictEqual(dejargon('parseHTTPResponse2 failed'), 'parse HTTPResponse2 failed');
});

test('dejargon leaves already plain text alone', () => {
  assert.strictEqual(dejargon('Landing is faster now because checks run once.'), 'Landing is faster now because checks run once.');
  assert.strictEqual(dejargon('a -- b and a - b'), 'a -- b and a - b');
});

test('dejargon strips CLI ticket ids unless preserveTickets is exactly true', () => {
  assert.strictEqual(dejargon('CLI-1234 add a retry'), 'add a retry');
  assert.strictEqual(dejargon('add a retry (CLI-77) today'), 'add a retry () today');
  assert.strictEqual(dejargon('CLI-1234 add a retry', { preserveTickets: true }), 'CLI-1234 add a retry');
  assert.strictEqual(dejargon('CLI-1234 add a retry', { preserveTickets: 'true' }), 'add a retry');
  assert.strictEqual(dejargon('CLI-1234 add a retry', { preserveTickets: false }), 'add a retry');
  assert.strictEqual(dejargon('CLI-1234 add a retry', {}), 'add a retry');
});

test('dejargon only strips ids shaped like CLI-digits', () => {
  assert.strictEqual(dejargon('BCK-1234 stays'), 'BCK-1234 stays');
  assert.strictEqual(dejargon('CLI-abc stays'), 'CLI-abc stays');
});

test('dejargon collapses whitespace and trims the ends', () => {
  assert.strictEqual(dejargon('   too   many \t spaces\n here  '), 'too many spaces here');
  assert.strictEqual(dejargon('first line\nsecond_line'), 'first line second line');
});

test('dejargon returns an empty string for empty and missing input', () => {
  assert.strictEqual(dejargon(''), '');
  assert.strictEqual(dejargon('   '), '');
  assert.strictEqual(dejargon(), '');
  assert.strictEqual(dejargon(null), '');
  assert.strictEqual(dejargon(undefined), '');
  assert.strictEqual(dejargon('CLI-5'), '');
});

test('dejargon turns non-string input into text instead of throwing', () => {
  assert.strictEqual(dejargon(42), '42');
  assert.strictEqual(dejargon(['a_b', 'cD']), 'a b,c D');
  assert.strictEqual(dejargon(0), '');
});

test('dejargon is stable when run twice', () => {
  const once = dejargon('CLI-9 ship --force-push for mission_ready checkMerge');
  assert.strictEqual(once, 'ship force push for mission ready check Merge');
  assert.strictEqual(dejargon(once), once);
});
