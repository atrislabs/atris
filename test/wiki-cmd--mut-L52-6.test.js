const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wikiCommand } = require('../commands/wiki');

test('cloud flag is excluded from related entity arguments', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-mode-args-')));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const lines = [];

  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));

    await wikiCommand('related', '--cloud', 'Ada', '--json');

    const output = JSON.parse(lines.join('\n'));
    assert.strictEqual(output.entity, 'Ada');
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
