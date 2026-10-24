'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('an engine request is reported as remapped when the title names a member', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-remap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const member = path.join(root, 'atris', 'team', 'architect');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: architect\nrole: architect\n---\n');

  const result = resolveFunctionalOwner({
    root,
    requestedOwner: 'codex',
    title: 'architect: fix the routing bug',
  });

  assert.match(result.remap_reason || '', /codex/);
});
