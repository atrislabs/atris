require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('local search prints the matching index entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-search-match-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const wikiDir = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Index\n\n- [Orchard irrigation](concepts/orchard.md)\n');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { wikiCommand } = require('../commands/wiki');
    await wikiCommand('search', 'irrigation');
    assert.match(lines.join('\n'), /concepts\/orchard\.md/);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
