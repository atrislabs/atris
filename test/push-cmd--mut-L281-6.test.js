const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzePushSafety } = require('../commands/push');

test('a change set with no nested workspace paths stays allowed without the opt-in flag', () => {
  const report = analyzePushSafety({
    filesToPush: [{ path: '/atris/now.md' }],
    slug: 'example-co',
    allowNestedWorkspace: false,
  });
  assert.equal(report.reasons.length, 0);
  assert.equal(report.ok, true);
});

test('the opt-in flag clears a nested workspace path without adding a reason', () => {
  const report = analyzePushSafety({
    filesToPush: [{ path: '/example-co/notes.md' }],
    slug: 'example-co',
    allowNestedWorkspace: true,
  });
  assert.equal(report.nestedWorkspacePaths.length, 1);
  assert.equal(report.reasons.length, 0);
  assert.equal(report.ok, true);
});
