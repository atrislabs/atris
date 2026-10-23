'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { reviewEventActors } = require('../lib/review-integrity');

function actorNames(task) {
  return [...reviewEventActors(task)];
}

test('reviewEventActors collects proof and review actors once, in event order', () => {
  const task = {
    events: [
      { event_type: 'claimed', actor: 'ignored-claimer' },
      { event_type: 'proof_ready', actor: ' Codex ' },
      { event_type: 'note', actor: 'scribe' },
      { event_type: 'reviewed', actor: 'CODEX_Review' },
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', payload: { actor: 'Validator' } },
      null,
      { event_type: 'reviewed', actor: 'keeper', payload: { actor: 'someone-else' } },
    ],
  };

  const actors = reviewEventActors(task);
  assert.ok(actors instanceof Set);
  assert.deepStrictEqual([...actors], ['codex', 'codex-review', 'validator', 'keeper']);
});

test('a missing actor comes from the payload, and a blank one does not', () => {
  // event.actor is used whenever it is truthy, even if it normalizes to nothing.
  const fromPayload = {
    events: [
      { event_type: 'proof_ready', actor: '', payload: { actor: 'Claude Code' } },
      { event_type: 'reviewed', payload: { actor: '  Atris-2 Fast!! ' } },
      { event_type: 'reviewed', actor: 42 },
      { event_type: 'proof_ready', payload: { actor: '42' } },
    ],
  };
  assert.deepStrictEqual(actorNames(fromPayload), ['claude-code', 'atris-2-fast', '42']);

  const blankBlocksPayload = {
    events: [
      { event_type: 'reviewed', actor: '---', payload: { actor: 'validator' } },
      { event_type: 'proof_ready', actor: '   ', payload: { actor: 'codex' } },
    ],
  };
  assert.deepStrictEqual(actorNames(blankBlocksPayload), []);
});

test('reviewEventActors returns an empty set when no event qualifies', () => {
  assert.deepStrictEqual(actorNames(null), []);
  assert.deepStrictEqual(actorNames(undefined), []);
  assert.deepStrictEqual(actorNames({}), []);
  assert.deepStrictEqual(actorNames({ events: null }), []);
  assert.deepStrictEqual(actorNames({ events: [] }), []);
  assert.deepStrictEqual(actorNames({ events: 0 }), []);
  assert.deepStrictEqual(actorNames({
    events: [
      null,
      undefined,
      { event_type: 'claimed', actor: 'codex' },
      { event_type: 'reviewed', actor: '   ' },
      { event_type: 'proof_ready' },
      { event_type: 'reviewed', payload: { actor: '' } },
    ],
  }), []);
});

test('reviewEventActors throws when events cannot be walked', () => {
  assert.throws(() => reviewEventActors({ events: { actor: 'codex' } }), TypeError);
});
