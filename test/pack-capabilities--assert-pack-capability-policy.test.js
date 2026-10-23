const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPackCapabilityPolicy } = require('../lib/pack-capabilities');

test('returns a legacy policy when permissions are absent', () => {
  for (const value of [undefined, null]) {
    assert.deepEqual(assertPackCapabilityPolicy(value), {
      status: 'legacy',
      requested: [],
      grantedCapabilities: [],
      tools: [],
    });
  }
});

test('returns an enforced policy with tools in canonical order', () => {
  const policy = assertPackCapabilityPolicy(['host.shell', 'pack.read']);
  assert.equal(policy.status, 'enforced');
  assert.deepEqual(policy.requested, ['host.shell', 'pack.read']);
  assert.deepEqual(policy.grantedCapabilities, ['host.shell', 'pack.read']);
  // Tool list follows TOOL_ORDER, not the order permissions were declared.
  assert.deepEqual(policy.tools, ['Read', 'Glob', 'Grep', 'Skill', 'Bash']);
});

test('treats an empty permissions array as enforced with no tools', () => {
  const policy = assertPackCapabilityPolicy([]);
  assert.equal(policy.status, 'enforced');
  assert.deepEqual(policy.requested, []);
  assert.deepEqual(policy.grantedCapabilities, []);
  assert.deepEqual(policy.tools, []);
});

test('grants the union of tools across capabilities without duplicates', () => {
  const policy = assertPackCapabilityPolicy(['pack.write', 'web.read']);
  assert.equal(policy.status, 'enforced');
  assert.deepEqual(policy.tools, [
    'Read', 'Glob', 'Grep', 'Skill', 'Edit', 'Write', 'WebFetch', 'WebSearch',
  ]);
});

test('throws a pack.json error for non-array permissions', () => {
  for (const value of ['pack.read', 42, { capability: 'pack.read' }, true]) {
    assert.throws(
      () => assertPackCapabilityPolicy(value),
      /^Error: pack\.json permissions must be an array of canonical capabilities/,
    );
  }
});

test('throws a pack.json error for malformed, unknown, or duplicate entries', () => {
  assert.throws(
    () => assertPackCapabilityPolicy([' pack.read']),
    /pack\.json permissions entries must be non-empty strings without surrounding whitespace/,
  );
  assert.throws(
    () => assertPackCapabilityPolicy(['']),
    /pack\.json permissions entries must be non-empty strings/,
  );
  assert.throws(
    () => assertPackCapabilityPolicy(['pack.read', 'pack.fly']),
    /pack\.json unknown capability "pack\.fly"/,
  );
  assert.throws(
    () => assertPackCapabilityPolicy(['pack.read', 'pack.read']),
    /pack\.json duplicate capability "pack\.read"/,
  );
});
