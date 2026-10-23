'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { exportMembers } = require('../lib/member-export');

const MEMBER = '---\nname: validator\nrole: Reviewer\ndescription: Validate\nmodel: opus\n---\n\n# Validator\n\n- Judge.\n';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-L174-9-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memberDir = path.join(root, 'atris', 'team', 'validator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), MEMBER);
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  return root;
}

test('a foreign directory inside a generated-agents folder is left alone', (t) => {
  const root = project(t);
  const foreign = path.join(root, '.claude', 'agents', 'drafts.md');
  fs.mkdirSync(foreign);

  const result = exportMembers(root);

  assert.equal(result.removed.length, 0);
  assert.ok(fs.statSync(foreign).isDirectory());
});

test('an unreadable hand-written agent file is left alone', (t) => {
  const root = project(t);
  const locked = path.join(root, '.claude', 'agents', 'locked.md');
  fs.writeFileSync(locked, 'mine\n');
  fs.chmodSync(locked, 0);
  t.after(() => { if (fs.existsSync(locked)) fs.chmodSync(locked, 0o644); });

  const result = exportMembers(root);

  assert.equal(result.removed.length, 0);
  assert.ok(fs.existsSync(locked));
});
