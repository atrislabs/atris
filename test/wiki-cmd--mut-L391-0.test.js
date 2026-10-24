require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('consolidation rejects cloud mode as local-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-consolidate-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const errors = [];
  const stopped = new Error('command exited');
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'wiki', 'index.md'), '# Wiki Index\n');
    console.log = () => {};
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = () => { throw stopped; };
    const { wikiCommand } = require('../commands/wiki');
    try {
      await wikiCommand('consolidate', '--cloud');
    } catch (err) {
      if (err !== stopped) throw err;
    }
    assert.match(errors.join('\n'), /local-only/i);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
