'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('a requested owner without a member folder is classified as functional', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requested-owner-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const result = resolveFunctionalOwner({
    root,
    title: 'translate poetry',
    requestedOwner: 'translation-owner',
  });

  assert.ok(result.reason.split('_').includes('functional'));
});
