'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logDirect } = require('../commands/learn');

test('a logged entry keeps the file paths it was given', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-L404-7-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });

  const origCwd = process.cwd();
  process.chdir(cwd);
  try {
    logDirect(JSON.stringify({
      type: 'pattern',
      key: 'map-first',
      insight: 'check MAP.md before grep',
      confidence: 8,
      source: 'observed',
      files: ['atris/MAP.md', 'bin/atris.js'],
    }), {
      cwd,
      output: () => {},
      error: () => {},
      exit: () => {},
    });
  } finally {
    process.chdir(origCwd);
  }

  const name = fs.readdirSync(path.join(cwd, 'atris')).find((n) => n.endsWith('.jsonl'));
  const entry = JSON.parse(fs.readFileSync(path.join(cwd, 'atris', name), 'utf8').trim());
  assert.deepStrictEqual(entry.files, ['atris/MAP.md', 'bin/atris.js']);
});
