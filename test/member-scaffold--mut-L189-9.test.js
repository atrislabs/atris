const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureMemberBundle, memberBundlePresent } = require('../lib/member-scaffold');

test('a member bundle missing its context folder is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-incomplete-member-'));
  try {
    ensureMemberBundle(root, {
      name: 'orb',
      now: new Date('2026-08-20T12:00:00Z'),
    });
    fs.rmdirSync(path.join(root, 'context'));
    assert.strictEqual(memberBundlePresent(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
