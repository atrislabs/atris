'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBrief } = require('../commands/brief');

test('a fully displayed landed list has no held remainder', () => {
  const output = renderBrief({
    schema: 'atris.brief.v1',
    days: 1,
    landed: [{
      id: 'CLI-1',
      title: 'Finished work',
      proof: 'proof on file',
      age: '1h',
    }],
    waiting: [],
    moves: [],
    week: 'week in review: 1 landed, 0 completions, 0 xp',
  });

  assert.match(output, /finished work/i);
  assert.doesNotMatch(output, /held\s*:/i);
});
