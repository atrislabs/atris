'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { oneLine } = require('../lib/developer-api');

test('oneLine trims text and collapses whitespace', () => {
  assert.strictEqual(oneLine('  request\n\twas   rejected\r\n'), 'request was rejected');
  assert.strictEqual(oneLine('ready'), 'ready');
  assert.strictEqual(oneLine(0), '0');
  assert.strictEqual(oneLine(false), 'false');
});

test('oneLine extracts nested details with detail before error before message', () => {
  assert.strictEqual(oneLine({ detail: ' first\nreason ', error: 'second', message: 'third' }), 'first reason');
  assert.strictEqual(oneLine({ error: { message: ' nested\terror ' }, message: 'outer' }), 'nested error');
  assert.strictEqual(oneLine({ detail: '', error: '', message: ' message\nonly ' }), 'message only');
});

test('oneLine serializes objects without an error detail', () => {
  assert.strictEqual(oneLine({ status: 400, retry: false }), '{"status":400,"retry":false}');
  assert.strictEqual(oneLine({}), '{}');
  assert.strictEqual(oneLine([]), '[]');
});

test('oneLine supplies a fallback for empty input and serialization errors', () => {
  for (const value of [undefined, null, '', ' \n\t\r ']) {
    assert.strictEqual(oneLine(value), 'request failed');
  }

  const circular = {};
  circular.self = circular;
  assert.strictEqual(oneLine(circular), 'request failed');
  assert.strictEqual(oneLine({ toJSON() { throw new Error('cannot serialize'); } }), 'request failed');
});
