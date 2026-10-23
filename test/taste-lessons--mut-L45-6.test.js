'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, matchTaste } = require('../lib/taste-lessons');

test('matching across scopes excludes a stored lesson with an invalid scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-taste-scope-'));
  try {
    const old = addTaste({
      root,
      verdict: 'keep',
      subject: 'Readable typography',
      why: 'Clear hierarchy helps readers scan.',
      scope: 'design',
      added: '2020-01-01',
    });
    const file = path.join(root, 'atris', 'taste.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored[old.slug].scope = 'unsupported';
    fs.writeFileSync(file, JSON.stringify(stored));

    const matches = matchTaste({
      root,
      briefText: 'Readable typography with clear hierarchy',
      scope: 'any',
    });
    assert.equal(matches.some((entry) => entry.slug === old.slug), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
