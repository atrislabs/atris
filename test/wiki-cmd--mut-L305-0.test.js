const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('local ingest stages a source without requiring a cloud login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-local-ingest-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const stopped = new Error('command stopped');
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    console.error = () => {};
    process.exit = () => { throw stopped; };
    fs.writeFileSync(path.join(root, 'notes.txt'), 'Orchard irrigation notes.\n');
    const { wikiCommand } = require('../commands/wiki');
    try {
      await wikiCommand('ingest', '--local', 'notes.txt');
    } catch (error) {
      if (error !== stopped) throw error;
    }
    const staged = fs.readdirSync(root, { recursive: true }).find((entry) =>
      entry !== 'notes.txt' && path.basename(entry) === 'notes.txt');
    assert.equal(staged ? fs.readFileSync(path.join(root, staged), 'utf8') : null,
      'Orchard irrigation notes.\n', 'local ingest must copy the source into its staging folder');
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
