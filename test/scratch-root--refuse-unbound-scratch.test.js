'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { refuseUnboundScratch, UNBOUND_SCRATCH_MESSAGE } = require('../lib/scratch-root');

test('refuseUnboundScratch writes the message and returns 2', () => {
  const lines = [];
  const code = refuseUnboundScratch((line) => lines.push(line));
  assert.strictEqual(code, 2);
  assert.deepStrictEqual(lines, [UNBOUND_SCRATCH_MESSAGE]);
});

test('refuseUnboundScratch defaults to console.error', () => {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  try {
    const code = refuseUnboundScratch();
    assert.strictEqual(code, 2);
  } finally {
    console.error = original;
  }
  assert.deepStrictEqual(lines, ['this folder is not a room']);
});

test('refuseUnboundScratch propagates a writer error', () => {
  const boom = new Error('writer failed');
  assert.throws(
    () => refuseUnboundScratch(() => { throw boom; }),
    (err) => err === boom,
  );
});
