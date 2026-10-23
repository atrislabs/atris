'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOneLapValidatorPrompt } = require('../lib/one-lap-validator');

test('validator prompt identifies the task by its display ID', () => {
  const prompt = buildOneLapValidatorPrompt({
    display_id: 'CLI-417',
    id: 'task-internal-417',
    title: 'check authentication',
  });
  const taskReference = prompt.split('\n').find(line => line.startsWith('Task ref:'));
  assert.ok(taskReference.includes('CLI-417'));
});
