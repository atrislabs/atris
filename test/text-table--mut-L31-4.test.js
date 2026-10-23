'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable } = require('../lib/text-table');

test('a word filling a wrapped column does not insert an empty row', () => {
  const output = renderTable(
    [{ header: 'JOB' }, { header: 'NOTE', wrap: true }],
    [['build', 'abcdefghijklm'], ['check', 'ready']],
    { width: 20 },
  );
  assert.equal(output.split('\n').findIndex(line => line.trimStart().startsWith('check')), 2);
});
