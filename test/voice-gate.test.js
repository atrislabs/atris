'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gateForHuman, scanText } = require('../lib/voice-gate');
const { taskReviewLandingLines } = require('../commands/task');
const { missionHumanStatusText } = require('../commands/mission');

const RAW_ULID = '01JABCDEFGHJKMNPQRSTVWXYZ12';

test('scanText names every human voice rule with the offending snippet', () => {
  const text = `review_queue calls reviewQueue for CLI-123 in foo.js:12; npm test -> ${RAW_ULID}\u2014done`;
  const findings = scanText(text);
  assert.deepEqual(new Set(findings.map(finding => finding.rule)), new Set([
    'em-dash',
    'agent-jargon',
    'raw-ulid',
    'file-path',
    'shell-command',
  ]));
  assert.ok(findings.every(finding => finding.why && finding.snippet));
});

test('gateForHuman replaces em dashes with plain punctuation', () => {
  const result = gateForHuman('the review is clear\u2014the decision is safe');
  assert.equal(result.text, 'the review is clear, the decision is safe');
  assert.equal(result.ok, true);
});

test('gateForHuman turns snake case and flags into plain words', () => {
  const result = gateForHuman('review_queue supports --dry-run for safer checks');
  assert.equal(result.text, 'review queue supports dry run for safer checks');
  assert.deepEqual(result.issues, []);
});

test('gateForHuman drops a raw ULID only when a readable title replaces it', () => {
  const withoutTitle = gateForHuman(`receipt ${RAW_ULID} passed`);
  assert.equal(withoutTitle.text, `receipt ${RAW_ULID} passed`);
  assert.ok(withoutTitle.issues.some(issue => issue.rule === 'raw-ulid'));

  const withTitle = gateForHuman(`receipt ${RAW_ULID} passed`, { title: 'readable receipt' });
  assert.equal(withTitle.text, 'receipt passed');
  assert.equal(withTitle.issues.some(issue => issue.rule === 'raw-ulid'), false);
});

test('gateForHuman keeps information without a clean substitute and reports it', () => {
  const input = 'keep CLI-123 proof at foo.js:12 and run npm test';
  const result = gateForHuman(input);
  assert.equal(result.text, input);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.rule === 'agent-jargon' && issue.snippet === 'CLI-123'));
  assert.ok(result.issues.some(issue => issue.rule === 'file-path' && issue.snippet === 'foo.js:12'));
  assert.ok(result.issues.some(issue => issue.rule === 'shell-command' && issue.snippet === 'npm test'));
});

test('task reviews sends landing prose through the human voice gate', () => {
  const lines = taskReviewLandingLines({
    title: 'readable approval result',
    landing: {
      happened: 'review_queue removed --internal-flag noise\u2014operators decide faster',
      reason: 'the approval_path is easier to read',
    },
  });
  assert.deepEqual(lines, [
    '     What happened: review queue removed internal flag noise, operators decide faster',
    '     Why it matters: the approval path is easier to read',
  ]);
});

test('missionHumanStatusText sends status prose through the human voice gate', () => {
  assert.equal(missionHumanStatusText({ status: 'waiting_for_human' }), 'waiting for human');
});
