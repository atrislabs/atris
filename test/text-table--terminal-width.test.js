'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { terminalWidth } = require('../lib/text-table');

function withColumns(columns, check) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: columns,
  });
  try {
    check();
  } finally {
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else delete process.stdout.columns;
  }
}

test('terminalWidth accepts explicit widths and the minimum boundary', () => {
  withColumns(120, () => {
    assert.strictEqual(terminalWidth(80), 80);
    assert.strictEqual(terminalWidth('72'), 72);
    assert.strictEqual(terminalWidth(20), 20);
    assert.strictEqual(terminalWidth(20.5), 20.5);
  });
});

test('terminalWidth falls back for invalid or too-small explicit widths', () => {
  withColumns(120, () => {
    for (const width of [19, -1, 'invalid', ' ', Infinity, -Infinity]) {
      assert.strictEqual(terminalWidth(width), 100);
    }
  });
});

test('terminalWidth uses controlled terminal columns for empty inputs', () => {
  withColumns(88, () => {
    assert.strictEqual(terminalWidth(), 88);
    for (const width of [undefined, null, '', 0, false, NaN]) {
      assert.strictEqual(terminalWidth(width), 88);
    }
  });
  for (const columns of [undefined, 0, 19, NaN, Infinity]) {
    withColumns(columns, () => {
      assert.strictEqual(terminalWidth(), 100);
    });
  }
});
