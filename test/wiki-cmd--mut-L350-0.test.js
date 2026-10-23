const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wikiCommand } = require('../commands/wiki');

test('query in default mode targets public wiki', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-')));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(root, '.atris', 'presidio'), { recursive: true });

    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => {
      throw new Error(`process.exit: ${code}`);
    };

    await wikiCommand('query', 'sample question');

    assert.ok(lines.includes('Target: atris/wiki'));
  } finally {
    process.exit = previousExit;
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
