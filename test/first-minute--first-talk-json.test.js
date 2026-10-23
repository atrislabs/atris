'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { firstTalkJson } = require('../lib/first-minute');

// This function and its command-formatting helpers use only their arguments.
// No home, filesystem, environment, git, or clock fixtures are needed.
test('firstTalkJson describes a newly claimed starter and its next action', () => {
  const starter = { display_id: 'T42', title: 'Build a garden planner' };

  assert.deepStrictEqual(firstTalkJson({ starter, person: 'alex' }), {
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'started',
    next_action: 'atris task ready T42 --verify "git diff --check"',
    task: { display_id: 'T42', title: 'Build a garden planner' },
  });
  assert.deepStrictEqual(starter, {
    display_id: 'T42', title: 'Build a garden planner',
  });
});

test('firstTalkJson respects open and review starter statuses', () => {
  for (const [status, person, command] of [
    ['open', 'alex', 'atris task claim T42 --as alex'],
    ['open', '', 'atris task claim T42 --as operator'],
    ['review', 'alex', 'atris task accept T42'],
  ]) {
    assert.deepStrictEqual(firstTalkJson({
      starter: { display_id: 'T42', title: 'Garden planner', status },
      person,
    }), {
      schema: 'atris.one_lap.v1',
      ok: true,
      status: 'started',
      next_action: command,
      task: { display_id: 'T42', title: 'Garden planner' },
    });
  }
});

test('firstTalkJson without an identifier normalizes the title for a new task', () => {
  assert.deepStrictEqual(firstTalkJson({
    starter: { title: '  Build\n a   garden planner?!  ', status: 'review' },
    folder: 'garden',
  }), {
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'started',
    next_action: 'atris task new "Build a garden planner"',
    task: null,
  });
});

test('firstTalkJson handles empty input and falls back to the folder', () => {
  const empty = {
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'started',
    next_action: 'atris task new "this folder"',
    task: null,
  };
  assert.deepStrictEqual(firstTalkJson(), empty);
  assert.deepStrictEqual(firstTalkJson({}), empty);
  assert.deepStrictEqual(firstTalkJson({ starter: null, folder: '' }), empty);
  assert.deepStrictEqual(firstTalkJson({
    starter: { display_id: '', title: ' \n ' }, folder: 'garden',
  }), { ...empty, next_action: 'atris task new "garden"' });
});
