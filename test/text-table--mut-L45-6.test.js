'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTable } = require('../lib/text-table');

test('multiline cells omit missing optional entries', () => {
  const output = renderTable(
    [{ header: 'Notes' }],
    [[['ready', null, undefined, 'reviewed']]],
    { width: 80 },
  );

  assert.doesNotMatch(output, /\b(?:null|undefined)\b/);
});
