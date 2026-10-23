'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lessonAtris = require('../commands/lesson');

test('lesson ledger --limit restricts returned record count', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lesson-limit-'));
  const origCwd = process.cwd();
  const origLog = console.log;

  try {
    fs.mkdirSync(path.join(tmpDir, 'atris'), { recursive: true });
    process.chdir(tmpDir);

    lessonAtris.addLesson(tmpDir, 'lesson-alpha', 'pass', 'first note');
    lessonAtris.addLesson(tmpDir, 'lesson-beta', 'pass', 'second note');

    const output = [];
    console.log = (...args) => {
      output.push(args.join(' '));
    };

    lessonAtris('ledger', '--limit', '1', '--json');

    const parsed = JSON.parse(output.join('\n'));
    assert.strictEqual(parsed.count, 1);
    assert.strictEqual(parsed.records.length, 1);
    assert.strictEqual(parsed.records[0].slug, 'lesson-beta');
  } finally {
    process.chdir(origCwd);
    console.log = origLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
