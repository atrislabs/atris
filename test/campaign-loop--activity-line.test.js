'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-loop-activity-line-'));
process.env.HOME = root;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { ACTIVITY_LINE } = require('../lib/campaign-loop');

// A live step is "<member> <h:mm>  <work>". The two spaces before the work
// are part of the shape. Every sample below is a fixed string.
function matched(line) {
  const found = ACTIVITY_LINE.exec(line);
  return found ? found[0] : null;
}

test('a normal live step matches the member, the time, and the first character of the work', () => {
  const line = 'researcher 06:47  editing stable.mjs';
  assert.strictEqual(ACTIVITY_LINE.test(line), true);
  assert.strictEqual(matched(line), 'researcher 06:47  e');
  assert.strictEqual(ACTIVITY_LINE.test(line), true);
  assert.strictEqual(matched('  mission 12:30  reading lib/campaign-loop.js'), '  mission 12:30  r');
});

test('boundary lines match only when the member, the hour, and the gap still fit', () => {
  assert.strictEqual(matched('a 9:05  x'), 'a 9:05  x');
  assert.strictEqual(matched('mission-lead 23:59  running: node --test'), 'mission-lead 23:59  r');
  assert.strictEqual(matched('Researcher 00:00  Editing'), 'Researcher 00:00  E');
  assert.strictEqual(matched('9 0:00  z'), '9 0:00  z');
  assert.strictEqual(matched('researcher  06:47   editing'), 'researcher  06:47   e');
  assert.strictEqual(matched('mission 12:00\t\tdoing'), 'mission 12:00\t\td');
  assert.strictEqual(matched('researcher 06:47 editing'), null);
  assert.strictEqual(ACTIVITY_LINE.test('researcher 06:47\tediting'), false);
  assert.strictEqual(matched('researcher 06:47:30  editing'), null);
  assert.strictEqual(matched('my_member 06:47  editing'), 'my_member 06:47  e');
  assert.strictEqual(matched('a.b 06:47  editing'), 'a.b 06:47  e');
  assert.strictEqual(matched('-lead 06:47  editing'), null);
});

test('an empty line, a blank line, or a value that is not text does not count as a live step', () => {
  assert.strictEqual(ACTIVITY_LINE.test(''), false);
  assert.strictEqual(matched(''), null);
  assert.strictEqual(matched('   \t'), null);
  assert.strictEqual(matched('researcher 06:47  '), null);
  assert.strictEqual(ACTIVITY_LINE.test(null), false);
  assert.strictEqual(ACTIVITY_LINE.test(undefined), false);
  assert.throws(() => ACTIVITY_LINE.test(Symbol('step')), TypeError);
});
