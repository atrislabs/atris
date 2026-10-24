require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('search uses the saved business slug to find its wiki', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-saved-slug-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const lines = [];
  const exitSignal = new Error('command exited');
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({
      slug: 'garden-team',
    }));
    const wikiDir = path.join(root, 'atris', 'garden-team', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'index.md'), '- irrigation guide\n');
    console.log = (...args) => lines.push(args.join(' '));
    console.error = () => {};
    process.exit = () => { throw exitSignal; };
    const { wikiCommand } = require('../commands/wiki');
    try {
      await wikiCommand('search', 'irrigation');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.ok(lines.some((line) => line.includes('irrigation guide')));
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
