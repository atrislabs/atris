'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeActor,
  taskBuilder,
  independentReviewActors,
  hasIndependentReview,
  isReservedActor,
  rosterActors,
  actorValidationMode,
  validateActor,
} = require('../lib/review-integrity');

test('normalizeActor collapses casing, spacing, and separators', () => {
  assert.equal(normalizeActor(' Codex '), 'codex');
  assert.equal(normalizeActor('CODEX_Review'), 'codex-review');
  assert.equal(normalizeActor('  '), '');
  assert.equal(normalizeActor(null), '');
});

test('taskBuilder prefers stamped built_by, then claimed_by, then first proof actor', () => {
  assert.equal(taskBuilder({ metadata: { built_by: 'Builder' }, claimed_by: 'other' }), 'builder');
  assert.equal(taskBuilder({ metadata: {}, claimed_by: 'Codex' }), 'codex');
  assert.equal(taskBuilder({
    metadata: {},
    events: [{ event_type: 'proof_ready', actor: 'validator' }],
  }), 'validator');
  assert.equal(taskBuilder({ metadata: {} }), null);
});

test('independent reviewers exclude the builder, including spoofed casings', () => {
  const task = {
    metadata: { built_by: 'codex' },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: ' Codex ' },
    ],
  };
  assert.equal(independentReviewActors(task).size, 0);
  assert.equal(hasIndependentReview(task), false);
});

test('one real independent reviewer is enough', () => {
  const task = {
    metadata: { built_by: 'codex' },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  };
  assert.deepEqual([...independentReviewActors(task)], ['validator']);
  assert.equal(hasIndependentReview(task), true);
});

test('unknown builder falls back to requiring two distinct actors', () => {
  const single = { metadata: {}, events: [{ event_type: 'reviewed', actor: 'codex' }] };
  assert.equal(hasIndependentReview(single), false);
  const pair = {
    metadata: {},
    events: [
      { event_type: 'reviewed', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  };
  // no proof_ready event, so no builder can be resolved: two distinct actors required
  assert.equal(taskBuilder(pair), null);
  assert.equal(hasIndependentReview(pair), true);
});

test('reserved system actors are rejected in every validation mode', () => {
  assert.equal(isReservedActor('autoland-verifier'), true);
  assert.equal(isReservedActor(' Autoland_Verifier '), true);
  assert.equal(isReservedActor('validator'), false);
  const result = validateActor('autoland-verifier', { root: process.cwd() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reserved_actor');
});

test('roster validation is off by default and warns or enforces when asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-'));
  try {
    const memberDir = path.join(dir, 'atris', 'team', 'linguist');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# linguist');

    assert.equal(rosterActors(dir).has('linguist'), true);
    assert.equal(rosterActors(dir).has('codex'), true);

    const prev = process.env.ATRIS_ACTOR_VALIDATION;
    try {
      delete process.env.ATRIS_ACTOR_VALIDATION;
      assert.equal(actorValidationMode(dir), 'off');
      assert.equal(validateActor('nobody-here', { root: dir }).ok, true);

      process.env.ATRIS_ACTOR_VALIDATION = 'warn';
      const warn = validateActor('nobody-here', { root: dir });
      assert.equal(warn.ok, true);
      assert.equal(warn.reason, 'actor_not_on_roster');

      process.env.ATRIS_ACTOR_VALIDATION = 'enforce';
      const enforced = validateActor('nobody-here', { root: dir });
      assert.equal(enforced.ok, false);
      assert.equal(enforced.reason, 'actor_not_on_roster');
      assert.equal(validateActor('linguist', { root: dir }).ok, true);
      assert.equal(validateActor('codex', { root: dir }).ok, true);

      process.env.ATRIS_ACTOR_VALIDATION = 'off';
      assert.equal(validateActor('nobody-here', { root: dir }).ok, true);
    } finally {
      if (prev === undefined) delete process.env.ATRIS_ACTOR_VALIDATION;
      else process.env.ATRIS_ACTOR_VALIDATION = prev;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
