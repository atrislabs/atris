'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable } = require('../lib/text-table');

test('a long clipped first column is shortened when later columns cannot shrink', () => {
  const output = renderTable(
    [{ header: 'TASK', clip: true }, { header: 'STATUS' }],
    [['review the customer feedback queue', 'ready']],
    { width: 20 },
  );

  assert.ok(output.split('\n')[1].split(/\s{2,}/)[0].endsWith('…'));
});
