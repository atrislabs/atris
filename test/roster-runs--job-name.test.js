'use strict';

// jobName reads any spelling of a job as one name: case, dashes, and
// underscores do not matter, and the old role names map onto the current job
// names. It touches no files and no environment, so nothing here writes to disk.

const test = require('node:test');
const assert = require('node:assert');
const { jobName } = require('../lib/roster-runs');

test('reads dashed, underscored, spaced, and mixed-case spellings as one job name', () => {
  for (const spelling of ['small-build', 'small_build', 'Small Build', 'SMALL-BUILD', 'small build']) {
    assert.strictEqual(jobName(spelling), 'small build', spelling);
  }
  assert.strictEqual(jobName('deep-review'), 'deep review');
});

test('maps the old role names onto the current job names, ignoring case and padding', () => {
  assert.strictEqual(jobName('executor'), 'build');
  assert.strictEqual(jobName('Executor'), 'build');
  assert.strictEqual(jobName('  EXECUTOR  '), 'build');
  assert.strictEqual(jobName('builder'), 'build');
  assert.strictEqual(jobName('navigator'), 'search');
  assert.strictEqual(jobName('validator'), 'review');
  assert.strictEqual(jobName(' Reviewer '), 'review');
  // An alias only applies to the whole name, not to a word inside it.
  assert.strictEqual(jobName('executor-lite'), 'executor lite');
});

test('empty, blank, or missing input gives an empty name', () => {
  assert.strictEqual(jobName(''), '');
  assert.strictEqual(jobName('   '), '');
  assert.strictEqual(jobName(null), '');
  assert.strictEqual(jobName(undefined), '');
});

test('collapses runs of whitespace and reads a number as its text', () => {
  assert.strictEqual(jobName('  Deep   Review  '), 'deep review');
  assert.strictEqual(jobName(42), '42');
});
