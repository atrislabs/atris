'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEntries } = require('../ledger');

test('formats entries as tab separated lines', () => {
  assert.equal(formatEntries([{ sku: 'A1', qty: 3, priceCents: 250 }]), 'A1\t3\t250');
});
