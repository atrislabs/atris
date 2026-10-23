'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-effort-words-'));
process.env.HOME = root;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { EFFORT_WORDS } = require('../lib/runner-command');

test('the effort list is the five roster words, in order', () => {
  assert.deepStrictEqual([...EFFORT_WORDS], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(EFFORT_WORDS.includes('medium'), true);
  assert.strictEqual(EFFORT_WORDS.join(', '), 'low, medium, high, xhigh, max');
});

test('an empty word, a lookalike, and the wrong case are not efforts', () => {
  assert.strictEqual(EFFORT_WORDS.includes(''), false);
  assert.strictEqual(EFFORT_WORDS.includes(' '), false);
  assert.strictEqual(EFFORT_WORDS.includes('max '), false);
  assert.strictEqual(EFFORT_WORDS.includes('MAX'), false);
  assert.strictEqual(EFFORT_WORDS.includes('off'), false);
  assert.strictEqual(EFFORT_WORDS.includes('none'), false);
  assert.strictEqual(EFFORT_WORDS.includes('minimal'), false);
});

test('the list is frozen, so adding a word throws and the list stays put', () => {
  assert.strictEqual(Object.isFrozen(EFFORT_WORDS), true);
  assert.strictEqual(EFFORT_WORDS.length, 5);
  assert.throws(() => {
    EFFORT_WORDS.push('ultra');
  }, TypeError);
  assert.deepStrictEqual([...EFFORT_WORDS], ['low', 'medium', 'high', 'xhigh', 'max']);
});
