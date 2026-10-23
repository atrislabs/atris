'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOneLapValidatorPrompt } = require('../lib/one-lap-validator');

test('review prompt carries the requested task text', () => {
  const prompt = buildOneLapValidatorPrompt({ title: 'repair payment receipts' });
  const taskText = prompt.split('\n').find(line => line.startsWith('Task text'));
  assert.match(taskText, /\breceipts\b/);
});
