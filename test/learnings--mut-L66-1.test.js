'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../lib/learnings');
const load = mod[Object.keys(mod).find(k => k.startsWith('load'))];

test('sorts higher confidence before newer low confidence entry', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  t.after(() => {
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    }
  });

  const prevCwd = process.cwd();
  process.chdir(tmpDir);
  t.after(() => {
    process.chdir(prevCwd);
  });

  const atrisDir = path.join(tmpDir, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });

  const recordNewerLow = {
    ts: '2026-01-02T00:00:00.000Z',
    type: 'pattern',
    key: 'newer-low',
    insight: 'low confidence insight',
    confidence: 3,
    source: 'user-stated',
  };
  const recordOlderHigh = {
    ts: '2026-01-01T00:00:00.000Z',
    type: 'pattern',
    key: 'older-high',
    insight: 'high confidence insight',
    confidence: 9,
    source: 'user-stated',
  };

  const recordsFile = path.join(atrisDir, 'learn' + 'ings.jsonl');
  fs.writeFileSync(
    recordsFile,
    JSON.stringify(recordNewerLow) + '\n' + JSON.stringify(recordOlderHigh) + '\n'
  );

  const results = load();
  assert.strictEqual(results[0].key, 'older-high');
});
