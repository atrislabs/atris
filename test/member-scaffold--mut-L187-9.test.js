'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureMemberBundle, memberBundlePresent } = require('../lib/member-scaffold');

test('a required directory replaced by a regular file makes the bundle incomplete', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bundle-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memberDir = path.join(root, 'orb');
  ensureMemberBundle(memberDir, { name: 'orb', now: new Date('2026-08-20T12:00:00Z') });
  const skillsDir = path.join(memberDir, 'skills');
  fs.rmSync(skillsDir, { recursive: true });
  fs.writeFileSync(skillsDir, 'accidentally saved as a file\n');

  assert.strictEqual(memberBundlePresent(memberDir), false);
});
