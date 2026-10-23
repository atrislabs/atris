'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewPrompt } = require('../lib/campaign-cadence');

test('reviewPrompt includes answer text in judge line when judge has run', () => {
  const view = {
    title: 'Test Campaign',
    judge: 'node:test',
    last_judge: { passed: true, reading: 42 },
    answer: { text: 'all tests passing' },
  };
  const summary = {
    kept: 1,
    failed: 0,
    vetoed: 0,
    spent: 0,
    fresh: [],
  };

  const prompt = reviewPrompt(view, summary, '- lesson 1');
  assert.match(prompt, /Judge now: passed \(reading 42\): all tests passing/);
});
