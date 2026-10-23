'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addTaste, listTaste } = require('../lib/taste-lessons');

test('listing puts the newest verdict first even when its subject sorts last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-order-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    addTaste({ root, verdict: 'keep', subject: 'Airy typography',
      why: 'The text is easy to scan.', scope: 'design', added: '2026-08-01' });
    const newer = addTaste({ root, verdict: 'more', subject: 'Warm typography',
      why: 'The page feels welcoming.', scope: 'design', added: '2026-08-03' });

    assert.equal(listTaste({ root })[0].slug, newer.slug);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
