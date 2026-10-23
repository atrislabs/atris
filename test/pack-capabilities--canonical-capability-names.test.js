'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { canonicalCapabilityNames, resolvePackCapabilityPolicy } = require('../lib/pack-capabilities');

test('canonicalCapabilityNames lists the four capabilities in definition order', () => {
  assert.deepStrictEqual(canonicalCapabilityNames(), [
    'pack.read',
    'pack.write',
    'web.read',
    'host.shell',
  ]);
});

test('every canonical name is accepted by resolvePackCapabilityPolicy', () => {
  for (const name of canonicalCapabilityNames()) {
    const policy = resolvePackCapabilityPolicy([name]);
    assert.strictEqual(policy.status, 'enforced', name);
    assert.deepStrictEqual(policy.requested, [name]);
  }
});

test('a name outside the canonical list is rejected with the same list in the reason', () => {
  const policy = resolvePackCapabilityPolicy(['pack.admin']);
  assert.strictEqual(policy.status, 'invalid');
  assert.strictEqual(
    policy.reason,
    'unknown capability "pack.admin"; supported capabilities: pack.read, pack.write, web.read, host.shell',
  );
});

test('each call returns a fresh array, so mutating one result does not change later calls', () => {
  const first = canonicalCapabilityNames();
  assert.notStrictEqual(first, canonicalCapabilityNames());
  first.push('pack.admin');
  first.length = 0;
  assert.deepStrictEqual(canonicalCapabilityNames(), [
    'pack.read',
    'pack.write',
    'web.read',
    'host.shell',
  ]);
});
