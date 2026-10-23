'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { renderTable } = require('../lib/text-table');

test('renders scalar null and undefined cells as empty strings', () => {
  assert.equal(
    renderTable([{ header: 'value' }], [[null], [undefined]], { width: 80 }),
    'value\n\n',
  );
});
