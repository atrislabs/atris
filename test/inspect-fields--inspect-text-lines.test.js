'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { inspectTextLines } = require('../lib/inspect-fields');

test('one field returns its value without a field label', () => {
  assert.deepStrictEqual(inspectTextLines(['status'], { status: 'active' }), ['active']);
  assert.deepStrictEqual(inspectTextLines(['title'], { title: '' }), ['']);
});

test('multiple fields retain requested order and format scalar values', () => {
  assert.deepStrictEqual(
    inspectTextLines(['title', 'enabled', 'count', 'missing', 'empty'], {
      count: 0,
      enabled: false,
      title: 'inspect this task',
      empty: null,
    }),
    ['title: inspect this task', 'enabled: false', 'count: 0', 'missing: null', 'empty: null']
  );
});

test('special fields render acknowledgement, pings, runner, and review', () => {
  assert.deepStrictEqual(
    inspectTextLines(['ack', 'pings', 'runner', 'review'], {
      ack: { acknowledged: true, status: 'ready', acknowledged_at: '2026-01-02T03:04:05Z' },
      pings: { pending: 1, total: 3 },
      runner: { runner: 'manual', model: 'example-model' },
      review: { approved: false },
    }),
    [
      'ack: ready @ 2026-01-02T03:04:05Z',
      'pings: 1 pending / 3 total',
      'runner: manual (example-model)',
      'review: {"approved":false}',
    ]
  );
  assert.deepStrictEqual(inspectTextLines(['ack'], { ack: { acknowledged: true } }), ['acknowledged']);
  assert.deepStrictEqual(inspectTextLines(['pings'], { pings: { pending: 2, total: 2 } }), ['2']);
  assert.deepStrictEqual(inspectTextLines(['runner'], { runner: {} }), ['manual']);
});

test('empty fields and missing values have explicit empty or fallback output', () => {
  assert.deepStrictEqual(inspectTextLines([], {}), []);
  assert.deepStrictEqual(inspectTextLines(['status'], {}), ['null']);
  assert.deepStrictEqual(inspectTextLines(['ack', 'pings'], {}), ['ack: unacknowledged', 'pings: 0']);
});
