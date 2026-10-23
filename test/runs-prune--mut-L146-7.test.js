'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneRuns } = require('../lib/runs-prune');

test('keeping the newest run protects it even when its name sorts last', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newest-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const older = path.join(runs, 'a-older.txt');
  const newer = path.join(runs, 'z-newer.txt');
  fs.writeFileSync(older, 'old run');
  fs.writeFileSync(newer, 'new run');
  const olderTime = Date.UTC(2026, 8, 1) / 1000;
  const newerTime = Date.UTC(2026, 8, 10) / 1000;
  fs.utimesSync(older, olderTime, olderTime);
  fs.utimesSync(newer, newerTime, newerTime);

  pruneRuns(root, {
    nowMs: Date.UTC(2026, 9, 23),
    apply: true,
    archive: false,
    keepDays: 0,
    keepNewest: 1,
  });

  assert.strictEqual(fs.existsSync(newer), true);
  assert.strictEqual(fs.existsSync(older), false);
});
