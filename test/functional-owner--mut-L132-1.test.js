'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('uses string tag to infer owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-lane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = resolveFunctionalOwner({ tag: 'validator', root });
  assert.strictEqual(result.owner, 'validator');
});
