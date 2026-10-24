'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readIdeas, updateIdea } = require('../lib/idea-inbox');

test('updating a missing idea does not create an inbox entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-idea-'));
  assert.strictEqual(updateIdea(root, 'missing', { status: 'building' }), null);
  assert.strictEqual(readIdeas(root).length, 0);
});
