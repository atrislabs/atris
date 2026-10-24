'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, listTaste } = require('../lib/taste-lessons');

test('listing any scope includes a lesson saved for design', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-scope-'));
  addTaste({
    verdict: 'keep',
    subject: 'Clear typography',
    why: 'It makes the page easy to scan.',
    scope: 'design',
    added: '2026-08-03',
    root,
  });

  const lessons = listTaste({ scope: 'any', root });
  assert.equal(lessons.some((entry) => entry.scope === 'design'), true);
});
