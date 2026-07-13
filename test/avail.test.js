'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTimeToDecimal,
  parseDaysArg,
  buildAvailableHours,
  resolveTimezone,
  formatDecimalHour,
  formatBookingLink,
} = require('../commands/avail');

describe('avail formatBookingLink', () => {
  it('renders the /book link when a handle exists', () => {
    assert.equal(
      formatBookingLink('keshavrao', 'https://atris.ai/'),
      '  link: https://atris.ai/book/keshavrao'
    );
  });
  it('names the fix instead of dropping the link when no handle', () => {
    const line = formatBookingLink('', 'https://atris.ai');
    assert.match(line, /none yet/);
    assert.match(line, /atris signup/);
  });
});

describe('avail parseTimeToDecimal', () => {
  it('parses 12h and 24h times', () => {
    assert.equal(parseTimeToDecimal('2:30pm'), 14.5);
    assert.equal(parseTimeToDecimal('9pm'), 21);
    assert.equal(parseTimeToDecimal('5:30am'), 5.5);
    assert.equal(parseTimeToDecimal('14:30'), 14.5);
  });
});

describe('avail parseDaysArg', () => {
  it('parses common day specs', () => {
    assert.deepEqual(parseDaysArg('all'), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(parseDaysArg('weekdays'), [0, 1, 2, 3, 4]);
    assert.deepEqual(parseDaysArg('mon,wed,fri'), [0, 2, 4]);
  });
});

describe('avail buildAvailableHours', () => {
  it('sets window on selected days only', () => {
    const h = buildAvailableHours([0, 1], 14.5, 21);
    assert.deepEqual(h['0'], [[14.5, 21]]);
    assert.deepEqual(h['6'], []);
  });
});

describe('avail resolveTimezone', () => {
  it('maps where aliases', () => {
    assert.equal(resolveTimezone({ where: 'Ibiza' }), 'Europe/Madrid');
    assert.equal(resolveTimezone({ tz: 'America/Chicago' }), 'America/Chicago');
  });
});

describe('avail formatDecimalHour', () => {
  it('formats fractional hours', () => {
    assert.equal(formatDecimalHour(14.5), '2:30pm');
    assert.equal(formatDecimalHour(21), '9pm');
  });
});
