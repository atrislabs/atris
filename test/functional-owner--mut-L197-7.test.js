'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('unclassified work falls back to the available custom team member', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-fallback-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  const member = path.join(root, 'atris', 'team', 'caretaker');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: caretaker\nrole: caretaker\n---\n');
  const result = resolveFunctionalOwner({ title: 'sort the supplies', root });
  assert.equal(result.owner, 'caretaker');
});
