'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('an untagged task proposes an owner named from its title', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untagged-owner-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const result = resolveFunctionalOwner({ root, title: 'translate poetry' });

  assert.strictEqual(result.proposed_member, 'translate-poetry-owner');
});
