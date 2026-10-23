const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCommand } = require('../commands/install');

const usage = [
  'Usage: atris install',
  'alias: atris workspace install',
  '',
  'installs the atris/ brain into the current directory if missing.',
];

function inEmptyWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-command-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalLog = console.log;
  const output = [];
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = (line) => output.push(line);
    run(root, output);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('install help prints usage and leaves an empty workspace untouched', () => {
  inEmptyWorkspace((root, output) => {
    for (const flag of ['-h', '--help', 'help']) {
      output.length = 0;
      assert.strictEqual(installCommand([flag]), 0);
      assert.deepStrictEqual(output, usage);
      assert.deepStrictEqual(fs.readdirSync(root), []);
    }
  });
});

test('workspace install alias handles help after the install subcommand', () => {
  inEmptyWorkspace((root, output) => {
    for (const flag of ['-h', '--help', 'help']) {
      output.length = 0;
      assert.strictEqual(installCommand(['install', flag], { verb: 'workspace' }), 0);
      assert.deepStrictEqual(output, usage);
      assert.deepStrictEqual(fs.readdirSync(root), []);
    }
  });
});

test('workspace accepts help directly without an install subcommand', () => {
  inEmptyWorkspace((root, output) => {
    for (const flag of ['-h', '--help', 'help']) {
      output.length = 0;
      assert.strictEqual(installCommand([flag], { verb: 'workspace' }), 0);
      assert.deepStrictEqual(output, usage);
      assert.deepStrictEqual(fs.readdirSync(root), []);
    }
  });
});
