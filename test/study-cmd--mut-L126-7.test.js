'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const study = require('../commands/study');

test('run normalizes a Spanish topic and prints the exact tutor guidance', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-language-'));
  const previousRoot = process.env.ATRIS_STUDY_ROOT;
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  t.mock.method(console, 'error', (...args) => errors.push(args));

  try {
    fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
    // Stop at ingestion failure, before any feed server or browser is contacted.
    fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    process.env.ATRIS_STUDY_ROOT = root;

    assert.equal(await study.run(['  SPANISH  ']), 1);
    assert.deepEqual(logs, [
      ['\n── Tutor loop (production drills) ──'],
      ['  Init (run once from backend repo):'],
      ['    venv/bin/python experiments/tutor-loop/tutor.py init'],
      ['\n  Daily flow:'],
      ['    venv/bin/python experiments/tutor-loop/tutor.py tick'],
      ['    venv/bin/python experiments/tutor-loop/tutor.py reply "<your answers>"'],
      ['    venv/bin/python experiments/tutor-loop/tutor.py receipt'],
      ['\n  Scan (iMessage replies):'],
      ['    venv/bin/python experiments/tutor-loop/tutor.py scan'],
      [''],
      ['\n  Ingest: venv/bin/python experiments/learning-feed/ingest.py learn SPANISH\n'],
    ]);
    assert.deepEqual(errors, [['\n✗ ingest.py learn exited with code 7']]);
  } finally {
    if (previousRoot === undefined) delete process.env.ATRIS_STUDY_ROOT;
    else process.env.ATRIS_STUDY_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
