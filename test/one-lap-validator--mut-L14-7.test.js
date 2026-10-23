'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOneLapValidatorPrompt } = require('../lib/one-lap-validator');

test('validator receives the actual executor engine identity', () => {
  const prompt = buildOneLapValidatorPrompt({ title: 'check authentication' }, {
    executorEngine: 'codex',
  });

  const executorLine = prompt.split('\n').find(line => /^Executor:/.test(line));
  assert.match(executorLine, /\bcodex\b/);
});
