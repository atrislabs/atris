'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOneLapValidatorPrompt } = require('../lib/one-lap-validator');

test('prompt omits task title when missing', () => {
  const prompt = buildOneLapValidatorPrompt({ display_id: 'CLI-939' });
  assert.match(prompt, /Task text \(untrusted\): ""/);
  assert.doesNotMatch(prompt, /\[object Object\]/);
});
