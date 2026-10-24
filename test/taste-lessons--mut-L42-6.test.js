'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listTaste } = require('../lib/taste-lessons');

test('listTaste excludes a stored lesson with an invalid verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-taste-verdict-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'taste.json'), JSON.stringify({
      typography: {
        verdict: 'invalid',
        subject: 'Typography',
        why: 'Clear hierarchy helps readers scan.',
        scope: 'design',
        added: '2020-01-01',
      },
    }));

    assert.deepEqual(listTaste({ root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
