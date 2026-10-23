'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, matchTaste } = require('../lib/taste-lessons');

test('three-letter subject keywords explain a relevant taste match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-keyword-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    addTaste({
      verdict: 'keep',
      subject: 'Red accents',
      why: 'Clear visual hierarchy.',
      scope: 'design',
      added: '2026-08-03',
      root,
    });
    const matches = matchTaste({ briefText: 'red', scope: 'design', root });
    assert.match(matches[0]?.why_matched || '', /\bred\b/i);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
