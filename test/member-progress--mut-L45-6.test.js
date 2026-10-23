'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendProgress } = require('../lib/member-progress');

test('trimming keeps a recent run start exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recent-start-'));
  const previous = process.env.ATRIS_PROGRESS_DIR;
  try {
    process.env.ATRIS_PROGRESS_DIR = dir;
    const file = path.join(dir, 'architect.log');
    const stamp = '2026-10-14T14:00:00.000Z';
    const step = `${stamp} current reading notes.txt\n`;
    fs.writeFileSync(file, step.repeat(8000)
      + `${stamp} current started: review notes\n`
      + step.repeat(20));

    appendProgress('architect', 'editing notes.txt', 'current');

    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split('\n').filter((line) => line.includes(' started: ')).length, 1);
  } finally {
    if (previous === undefined) delete process.env.ATRIS_PROGRESS_DIR;
    else process.env.ATRIS_PROGRESS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
