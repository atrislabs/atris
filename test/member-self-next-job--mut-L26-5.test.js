'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missionNextJob } = require('../lib/member-self-next-job');

test('a mission starting with its north star retains its objective', () => {
  const job = missionNextJob([
    '## North Star',
    '',
    'Ship a verified build.',
    '',
    '## Check',
    '',
    '`node --test test/smoke.test.js`',
    '',
  ].join('\n'));

  assert.strictEqual(job?.objective, 'Ship a verified build.');
});
