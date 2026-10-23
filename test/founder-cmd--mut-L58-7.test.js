'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { founderCommand } = require('../commands/founder');

test('global flag is accepted before help', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  console.error = () => {};
  try {
    founderCommand(['--global', '--help']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(output.some(line => /usage:/i.test(line)));
});
