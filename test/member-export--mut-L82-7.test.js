'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { exportMembers } = require('../lib/member-export');

test('skips template directory when exporting team members', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const templateDir = path.join(root, 'atris', 'team', '_template');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(
    path.join(templateDir, 'MEMBER.md'),
    '---\nname: template\nrole: Template\n---\n\n# Template\n'
  );

  const result = exportMembers(root);
  assert.strictEqual(result.members.length, 0);
});
