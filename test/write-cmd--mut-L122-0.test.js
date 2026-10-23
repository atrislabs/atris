'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, syncStates, readPlan } = require('../commands/write');

test('deleting all words from a drafted beat saves its empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-beat-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  process.env.HOME = root;
  process.chdir(root);
  console.log = () => {};
  try {
    start(['Revision', '--beats', 'Opening'], root);
    const draft = path.join(root, 'atris', 'writing', 'revision', 'draft.md');
    fs.writeFileSync(draft, '# Revision\n\n## Opening\nThe kettle woke me.\n');
    syncStates('revision', root);
    fs.writeFileSync(draft, '# Revision\n\n## Opening\n');
    syncStates('revision', root);

    assert.strictEqual(readPlan('revision', root).beats[0].state, ' ');
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
