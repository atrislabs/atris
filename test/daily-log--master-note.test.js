const test = require('node:test');
const assert = require('node:assert');
const { MASTER_NOTE } = require('../lib/daily-log');

// MASTER_NOTE is a RegExp, not a function. It decides which task notes are
// escalated from the member log up to the master journal.

test('MASTER_NOTE matches each escalation keyword followed by a colon or dash', () => {
  const escalated = [
    'decision: use sqlite for the task store',
    'decided - keep the member log gitignored',
    'milestone: parser passes all fixtures',
    'handoff: review is with codex now',
    'shipped: the release tag is pushed',
    'launched: the new login flow is live',
    'landed: lane 4 merged into master',
    'blocked: waiting on a key rotation',
  ];
  for (const note of escalated) {
    assert.equal(MASTER_NOTE.test(note), true, `expected escalation: ${note}`);
  }
});

test('MASTER_NOTE matches keywords regardless of case and spacing before the separator', () => {
  assert.equal(MASTER_NOTE.test('SHIPPED: the build is out'), true);
  assert.equal(MASTER_NOTE.test('Decision : pick the simpler path'), true);
  assert.equal(MASTER_NOTE.test('Blocked-on review'), true);
});

test('MASTER_NOTE leaves ordinary progress notes in the member log', () => {
  const stayInMemberLog = [
    'checked the test output and kept going',
    'decisions: a plural is not the keyword',
    'decision without a separator',
    'we shipped: this is mid-sentence, not a lead',
    'landed on a bug in the parser',
    'handoffs: none today',
  ];
  for (const note of stayInMemberLog) {
    assert.equal(MASTER_NOTE.test(note), false, `expected no escalation: ${note}`);
  }
});

test('MASTER_NOTE rejects empty input, since callers pass String(note || "")', () => {
  assert.equal(MASTER_NOTE.test(''), false);
  assert.equal(MASTER_NOTE.test('   '), false);
});

test('MASTER_NOTE only looks at the start of a note, not later lines', () => {
  assert.equal(MASTER_NOTE.test('progress so far\nshipped: the fix'), false);
});

test('MASTER_NOTE gives the same answer on repeated calls, so it must not carry the g flag', () => {
  assert.equal(MASTER_NOTE.global, false);
  assert.equal(MASTER_NOTE.test('shipped: first call'), true);
  assert.equal(MASTER_NOTE.test('shipped: second call'), true);
});
