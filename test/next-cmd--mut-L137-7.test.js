'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('approving a waiting wish preserves its unanswered question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-review-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    const { nextCommand } = require('../commands/next');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify({
      id: 'wish-8',
      n: 8,
      text: 'Publish the guide',
      status: 'needs_input',
      questions: ['Which audience should the guide address?'],
    }) + '\n');

    const lines = [];
    nextCommand(['yes'], root, { log: (line) => lines.push(String(line)) });

    assert.match(lines.join('\n'), /\baudience\b/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
