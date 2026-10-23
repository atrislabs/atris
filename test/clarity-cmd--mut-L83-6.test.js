'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clarityCommand } = require('../commands/clarity');

test('saving focus does not report an empty voice answer as saved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-empty-answer-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'clarity.json'), JSON.stringify({ voice: '' }));
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    await clarityCommand(['--set', 'focus=ship', '--set', 'voice=   ']);

    const saved = output.find((line) => /\bsaved\b/.test(line)) || '';
    assert.match(saved, /\bfocus\b/);
    assert.doesNotMatch(saved, /\bvoice\b/);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
