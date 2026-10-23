'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const learnAtris = require('../commands/learn');

test('learn prune does not report conflicts when only stale entries exist', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-mut-'));
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

  const record = {
    ts: '2026-10-23T00:00:00.000Z',
    type: 'pattern',
    key: 'stale-test-key',
    insight: 'stale test insight',
    confidence: 8,
    source: 'user-stated',
    files: ['missing-file.txt'],
  };
  fs.writeFileSync(
    path.join(atrisDir, 'learnings.jsonl'),
    JSON.stringify(record) + '\n'
  );

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  t.after(() => {
    console.log = origLog;
  });

  learnAtris('prune');

  const output = logs.join('\n');
  assert.ok(output.includes('STALE'));
  assert.ok(!output.includes('CONFLICTS'));
});
