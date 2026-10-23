'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyPackCapabilityGrants } = require('../lib/pack-capabilities');

// These calls only transform in-memory policies: no home, environment,
// filesystem, network, or clock-dependent paths are used.
test('merges grants without mutating inputs and orders unique tools canonically', () => {
  const policy = Object.freeze({
    status: 'enforced',
    requested: Object.freeze(['web.read']),
    grantedCapabilities: Object.freeze(['web.read', 'pack.read']),
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Skill', 'WebFetch', 'WebSearch']),
  });
  const grants = Object.freeze(['host.shell', 'pack.write', 'web.read']);

  const result = applyPackCapabilityGrants(policy, grants);

  assert.deepStrictEqual(result, {
    status: 'enforced',
    requested: ['web.read'],
    grantedCapabilities: ['web.read', 'pack.read', 'host.shell', 'pack.write'],
    tools: ['Read', 'Glob', 'Grep', 'Skill', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Bash'],
    operatorEscalated: true,
  });
  assert.notStrictEqual(result, policy);
  assert.notStrictEqual(result.requested, policy.requested);
  assert.deepStrictEqual(policy.grantedCapabilities, ['web.read', 'pack.read']);
  assert.deepStrictEqual(grants, ['host.shell', 'pack.write', 'web.read']);
});

test('explicit grants enforce a legacy policy without carrying undeclared permissions', () => {
  const policy = { status: 'legacy', requested: [], grantedCapabilities: [], tools: [] };

  assert.deepStrictEqual(applyPackCapabilityGrants(policy, ['pack.read']), {
    status: 'enforced',
    requested: [],
    grantedCapabilities: ['pack.read'],
    tools: ['Read', 'Glob', 'Grep', 'Skill'],
    operatorEscalated: true,
  });
  assert.strictEqual(policy.status, 'legacy');
});

test('empty or omitted grants return the original policy unchanged', () => {
  for (const policy of [
    { status: 'legacy', requested: [], grantedCapabilities: [], tools: [] },
    { status: 'enforced', requested: [], grantedCapabilities: [], tools: [] },
  ]) {
    assert.strictEqual(applyPackCapabilityGrants(policy), policy);
    assert.strictEqual(applyPackCapabilityGrants(policy, []), policy);
    assert.strictEqual(Object.hasOwn(policy, 'operatorEscalated'), false);
  }
});

test('rejects unknown, duplicate, whitespace-padded, and non-string grants', () => {
  const policy = { status: 'enforced', requested: [], grantedCapabilities: [], tools: [] };
  const cases = [
    [['unknown'], /^--grant unknown capability "unknown";/],
    [['pack.read', 'pack.read'], /^--grant duplicate capability "pack.read"$/],
    [[' pack.read'], /^--grant permissions entries must be non-empty strings without surrounding whitespace$/],
    [[42], /^--grant permissions entries must be non-empty strings without surrounding whitespace$/],
  ];

  for (const [grants, message] of cases) {
    assert.throws(() => applyPackCapabilityGrants(policy, grants), { name: 'Error', message });
  }
  assert.deepStrictEqual(policy, {
    status: 'enforced', requested: [], grantedCapabilities: [], tools: [],
  });
});
