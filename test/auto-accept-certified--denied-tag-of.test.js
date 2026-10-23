'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { deniedTagOf } = require('../lib/auto-accept-certified');

test('deniedTagOf returns each protected tag and normalizes case and whitespace', () => {
  for (const tag of ['billing', 'money', 'payments', 'deploy', 'feedback', 'security', 'customer', 'external']) {
    assert.strictEqual(deniedTagOf({ tag }), tag);
    assert.strictEqual(deniedTagOf({ tag: `  ${tag.toUpperCase()}\t` }), tag);
  }
});

test('deniedTagOf matches separated words and a trailing plural s', () => {
  assert.strictEqual(deniedTagOf({ tag: 'infra-deploys' }), 'deploy');
  assert.strictEqual(deniedTagOf({ tag: 'support_customers' }), 'customer');
  assert.strictEqual(deniedTagOf({ tag: 'ui/payments:review' }), 'payments');
  // Multiple matches follow the protected-tag order, rather than text order.
  assert.strictEqual(deniedTagOf({ tag: 'external-deploy-billing' }), 'billing');
});

test('deniedTagOf rejects partial words and does not strip multiple plural suffixes', () => {
  for (const tag of ['deployment', 'prebilling', 'security2', 'deployss', 'payment', 'docs']) {
    assert.strictEqual(deniedTagOf({ tag }), null, tag);
  }
});

test('deniedTagOf returns null for absent or empty tags', () => {
  for (const task of [undefined, null, {}, { tag: undefined }, { tag: null }, { tag: '' }, { tag: ' \t\n' }]) {
    assert.strictEqual(deniedTagOf(task), null);
  }
  assert.strictEqual(deniedTagOf({ title: 'billing', metadata: { tag: 'deploy' } }), null);
});
