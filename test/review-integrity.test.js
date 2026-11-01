'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeActor,
  taskAuthors,
  isTaskAuthor,
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

test('taskAuthors is everyone who ever claimed a job to build it or handed work in on it, and never a machine name', () => {
  const task = {
    metadata: { built_by: ' Fleet_Claude ' },
    claimed_by: 'FLEET-CODEX',
    events: [
      { event_type: 'created', actor: 'harman' },
      { event_type: 'claimed', actor: 'fleet-gemini', payload: { claimed_by: 'Fleet-Gemini' } },
      // A job born claimed records the claim with no payload, so the actor is the claimant.
      { event_type: 'claimed', actor: 'cursor' },
      { event_type: 'proof_ready', actor: 'fleet-gemini', payload: { handed_in_by: 'fleet-gemini' } },
      // A review pass is a proof_ready event with no hand-in mark.
      { event_type: 'proof_ready', actor: 'harman', payload: {} },
      { event_type: 'proof_ready', actor: 'validator' },
      { event_type: 'reviewed', actor: 'reviewer-one', payload: { handed_in_by: 'reviewer-one' } },
      // The system's own names are never authors, whatever an event says.
      { event_type: 'proof_ready', actor: 'autoland-verifier', payload: { handed_in_by: 'autoland-verifier' } },
      { event_type: 'claimed', actor: 'auto-accept-certified' },
      // Nothing that is not an event breaks it.
      null,
      'odd',
      { event_type: 'claimed', payload: null },
      { event_type: 'claimed', actor: '  ', payload: { claimed_by: '' } },
    ],
  };
  assert.deepEqual([...taskAuthors(task)].sort(), ['cursor', 'fleet-claude', 'fleet-codex', 'fleet-gemini']);
  assert.deepEqual([...taskAuthors({ metadata: {}, claimed_by: null })], []);
  assert.deepEqual([...taskAuthors({ events: 'not a list' })], []);
  for (const nothing of [null, undefined, 'task', 7]) assert.equal(taskAuthors(nothing).size, 0, String(nothing));
});

test('taskAuthors also counts the builders a hand-in names as having built the work with it, and only a hand-in event', () => {
  const task = {
    metadata: {},
    claimed_by: 'maya',
    events: [
      { event_type: 'proof_ready', actor: 'maya', payload: { handed_in_by: 'maya', built_with: ['fleet-codex', ' Fleet_Cursor ', '', null, 7, { name: 'fleet-claude' }] } },
      // Not a list, so not a name: a string is not split.
      { event_type: 'proof_ready', actor: 'maya', payload: { built_with: 'fleet-gemini,fleet-devin' } },
      // Only a hand-in event says who built it.
      { event_type: 'reviewed', actor: 'harman', payload: { built_with: ['fleet-windsurf'] } },
      // The system's own names are never authors, whatever an event says.
      { event_type: 'proof_ready', actor: 'maya', payload: { built_with: ['autoland-verifier', 'auto-accept-certified'] } },
    ],
  };
  assert.deepEqual([...taskAuthors(task)].sort(), ['fleet-codex', 'fleet-cursor', 'maya']);
  assert.equal(isTaskAuthor(task, 'FLEET-CURSOR'), true);
  assert.equal(isTaskAuthor(task, 'fleet-windsurf'), false);

  // So an engine named by the hand-in is no independent check of the work, and a third name is.
  const handIn = { event_type: 'proof_ready', actor: 'maya', payload: { handed_in_by: 'maya', built_with: ['fleet-codex', 'fleet-cursor'] } };
  const built = { metadata: {}, claimed_by: 'maya' };
  const reviewedBy = (...actors) => actors.map((actor) => ({ event_type: 'reviewed', actor }));
  assert.equal(hasIndependentReview({ ...built, events: [handIn, ...reviewedBy('fleet-codex', 'fleet-cursor')] }), false);
  assert.equal(hasIndependentReview({ ...built, events: [handIn, ...reviewedBy('fleet-codex', 'fleet-gemini')] }), true);
  assert.deepEqual([...independentReviewActors({ ...built, events: [handIn, ...reviewedBy('fleet-codex', 'fleet-cursor', 'fleet-gemini')] })], ['fleet-gemini']);
});

test('nobody who ever built a job is an independent reviewer of it, whoever built it last', () => {
  const task = {
    metadata: { built_by: 'claude' },
    claimed_by: 'claude',
    events: [
      { event_type: 'claimed', actor: 'codex', payload: { claimed_by: 'codex' } },
      { event_type: 'proof_ready', actor: 'codex', payload: { handed_in_by: 'codex' } },
      { event_type: 'claimed', actor: 'claude', payload: { claimed_by: 'claude' } },
      { event_type: 'proof_ready', actor: 'claude', payload: { handed_in_by: 'claude' } },
      { event_type: 'reviewed', actor: ' Codex ' },
    ],
  };
  // The first builder looked at the second's work: not an independent check.
  assert.equal(independentReviewActors(task).size, 0);
  assert.equal(hasIndependentReview(task), false);
  const withValidator = { ...task, events: [...task.events, { event_type: 'reviewed', actor: 'validator' }] };
  assert.deepEqual([...independentReviewActors(withValidator)], ['validator']);
  assert.equal(hasIndependentReview(withValidator), true);
  // A job with nobody on record as an author still needs two distinct reviewers.
  assert.equal(hasIndependentReview({ metadata: {}, events: [{ event_type: 'reviewed', actor: 'codex' }] }), false);
});

test('isTaskAuthor says whether an actor ever built the job, in any spelling of the name', () => {
  const task = {
    metadata: { built_by: 'claude' },
    claimed_by: 'claude',
    events: [{ event_type: 'proof_ready', actor: 'codex', payload: { handed_in_by: 'codex' } }],
  };
  assert.equal(isTaskAuthor(task, ' Codex '), true);
  assert.equal(isTaskAuthor(task, 'CLAUDE'), true);
  assert.equal(isTaskAuthor(task, 'validator'), false);
  assert.equal(isTaskAuthor(task, ''), false);
  assert.equal(isTaskAuthor(task, null), false);
  assert.equal(isTaskAuthor(null, 'codex'), false);
  // With no stamp, no claimant and no mark, the first proof on file is still the builder's.
  assert.equal(isTaskAuthor({ metadata: {}, events: [{ event_type: 'proof_ready', actor: 'validator' }] }, 'validator'), true);
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
