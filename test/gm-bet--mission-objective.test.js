'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { missionObjective } = require('../lib/gm-bet');

const yesRule = 'rule: a step marked "your yes" is locked until the owner says yes: publishing, pushing tags, releases, posting, sending, and merging to master are held by the guard on your PATH. when you reach that step, run the command once; it is held, and the owner gets a yes card. do the other steps, wait for the ping from gm-phone that says yes, then run it again. never work around the guard.';

function bet(overrides = {}) {
  return {
    title: 'Write the setup guide...  ',
    why_now: 'New users need a first step.',
    expect: 'ten completed setups',
    metric_source: 'setup reports',
    check_date: '2030-06-15',
    steps: [],
    ...overrides,
  };
}

test('formats the objective, numbered steps, approval, details, and check', () => {
  const result = missionObjective(bet({
    steps: [
      { who: 'team', member: 'writer', text: 'Draft the guide', detail: 'Include one example' },
      { who: 'team', text: 'Check the example' },
      { who: 'you', member: 'publisher', text: 'Publish the guide' },
    ],
    verify: 'node --test test/guide.test.js',
  }));

  assert.strictEqual(result, [
    'Write the setup guide.',
    'why now: New users need a first step.',
    'we expect ten completed setups, read from setup reports on 2030-06-15.',
    'steps: 1. [writer] Draft the guide (Include one example) 2. [team] Check the example 3. [your yes] Publish the guide',
    'done means this check passes: node --test test/guide.test.js',
    yesRule,
  ].join(' '));
});

test('chains handoffs only when a team step changes the assigned member', () => {
  const input = bet({ steps: [
    { who: 'team', member: 'writer', text: 'Draft' },
    { who: 'you', member: 'owner', text: 'Approve' },
    { who: 'team', text: 'Check spelling' },
    { who: 'team', member: 'editor', text: 'Edit' },
    { who: 'team', member: 'editor', text: 'Proofread' },
    { who: 'team', member: 'writer', text: 'Revise' },
  ] });
  const expected = 'handoffs: you are writer; do your steps, then pass each step that belongs to another member with atris member handoff writer editor "[idea-7] Edit", then atris member handoff editor writer "[idea-7] Revise".';

  assert.ok(missionObjective(input, { owner: 'writer', betId: 'idea-7' }).includes(expected));
  assert.ok(missionObjective(input, { owner: 'writer' }).includes(
    'atris member handoff writer editor "Edit", then atris member handoff editor writer "Revise".',
  ));
  assert.ok(!missionObjective(input).includes('handoffs:'));
});

test('empty steps omit optional handoffs and verification but retain the approval rule', () => {
  assert.strictEqual(missionObjective(bet(), { owner: 'writer' }), [
    'Write the setup guide.',
    'why now: New users need a first step.',
    'we expect ten completed setups, read from setup reports on 2030-06-15.',
    'steps: ',
    yesRule,
  ].join(' '));
});

test('missing steps are rejected rather than producing an incomplete objective', () => {
  assert.throws(() => missionObjective(bet({ steps: undefined })), TypeError);
});
