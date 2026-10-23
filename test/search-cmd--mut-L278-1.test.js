'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchCommand } = require('../commands/search');

test('compact search points to the matching feature folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feature-search-'));
  const feature = path.join(root, 'atris', 'features', 'invoice-routing');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'idea.md'), '# Invoice routing\n');

  const originalLog = console.log;
  const output = [];
  try {
    console.log = (...args) => output.push(args.join(' '));
    searchCommand(['invoice-routing', '--memory-only'], { root });
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const featureLine = output.join('\n').split('\n').find(line => /^Feature:/.test(line));
  assert.equal(featureLine?.replace(/^Feature:\s*/, '').trim(), 'atris/features/invoice-routing/');
});
