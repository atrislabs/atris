'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-held-for-person-test-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const { heldForPerson } = require('../lib/member-task-pick');

test('heldForPerson normal inputs: distinguishes unheld tasks, decision holds, and protected lanes', () => {
  const normalTask = { title: 'Fix CSS styling issue', tag: 'frontend' };
  assert.strictEqual(heldForPerson(normalTask), '');

  const needsHumanTask = { title: 'Select database engine', tag: 'needs-human' };
  assert.strictEqual(heldForPerson(needsHumanTask), 'needs_human');

  const decisionTask = { title: 'Pricing model change', tag: 'decision' };
  assert.strictEqual(heldForPerson(decisionTask), 'needs_human');

  const billingTask = { title: 'Update invoice template', tag: 'billing' };
  assert.strictEqual(heldForPerson(billingTask), 'protected_lane');

  const securityTask = { title: 'Rotate access keys', tag: 'security' };
  assert.strictEqual(heldForPerson(securityTask), 'protected_lane');

  const declaredProtectedTask = {
    title: 'Migrate user tables',
    metadata: { description: 'human review required' },
  };
  assert.strictEqual(heldForPerson(declaredProtectedTask), 'protected_lane');

  const sniffedLaneTask = { title: 'Deploy to prod safely' };
  assert.strictEqual(heldForPerson(sniffedLaneTask), 'protected_lane');
});

test('heldForPerson edge cases: handles tags in metadata, titles, case insensitivity, and untagged tasks', () => {
  const untaggedOrdinaryTask = { title: 'Update internal documentation' };
  assert.strictEqual(heldForPerson(untaggedOrdinaryTask), '');

  const titleHashtagTask = { title: 'Evaluate architecture options #needs-human' };
  assert.strictEqual(heldForPerson(titleHashtagTask), 'needs_human');

  const metaTagsArrayTask = {
    title: 'Vendor selection',
    metadata: { tags: ['decision'] },
  };
  assert.strictEqual(heldForPerson(metaTagsArrayTask), 'needs_human');

  const metaProtectedTagTask = {
    title: 'Stripe webhook listener',
    metadata: { tag: 'payments' },
  };
  assert.strictEqual(heldForPerson(metaProtectedTagTask), 'protected_lane');

  const uppercaseTagTask = { title: 'Apply database migration', tag: 'DEPLOY' };
  assert.strictEqual(heldForPerson(uppercaseTagTask), 'protected_lane');
});

test('heldForPerson empty and error cases: returns empty string for empty objects and throws on invalid inputs', () => {
  assert.strictEqual(heldForPerson({}), '');
  assert.strictEqual(heldForPerson({ title: '' }), '');
  assert.strictEqual(heldForPerson({ title: '   ', metadata: {} }), '');

  assert.throws(() => heldForPerson(null), { name: 'TypeError' });
  assert.throws(() => heldForPerson(undefined), { name: 'TypeError' });
});
