'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listActiveProcessPaths } = require('../commands/worktree');

// Exercise the real command boundary without inspecting the host's processes.
function withCommands(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-process-paths-'));
  const previousPath = process.env.PATH;
  const canonicalRoot = fs.realpathSync(root);
  function command(name, stdout, status = 0) {
    fs.writeFileSync(path.join(root, name),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exitCode = ${status};\n`,
      { mode: 0o700 });
  }
  process.env.PATH = root;
  try {
    run({ root: canonicalRoot, command });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('combines canonical current folders with absolute command argument paths', () => {
  withCommands(({ root, command }) => {
    const cwd = path.join(root, 'working');
    fs.mkdirSync(cwd);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(cwd, alias, 'dir');
    const script = path.join(root, 'script.js');
    const preload = path.join(root, 'preload.js');
    command('lsof', `p123\nn${alias}\r\nf cwd\n`);
    command('ps', `node ${script}\nnode --require=${preload}\nnode ${script}\n`);

    assert.deepStrictEqual(listActiveProcessPaths(), [cwd, script, preload]);
  });
});

test('keeps both the first token and remainder for an unquoted path with spaces', () => {
  withCommands(({ root, command }) => {
    command('lsof', `n${root}\n`);
    command('ps', `node ${root}/folder with spaces/script.js\n`);

    assert.deepStrictEqual(listActiveProcessPaths(), [
      root, `${root}/folder`, `${root}/folder with spaces/script.js`,
    ]);
  });
});

test('keeps folders when the open-file scan yields no usable paths', () => {
  withCommands(({ command }) => {
    command('lsof', 'p123\nf cwd\n');
    command('ps', 'node relative.js\n');
    assert.strictEqual(listActiveProcessPaths(), null);
  });
});

test('returns null when the current-folder scan fails or cannot launch', () => {
  withCommands(({ root, command }) => {
    command('ps', `node ${root}/script.js\n`);
    assert.strictEqual(listActiveProcessPaths(), null);
    command('lsof', `n${root}\n`, 1);
    assert.strictEqual(listActiveProcessPaths(), null);
  });
});

test('keeps folders when the argument scan fails or cannot launch', () => {
  withCommands(({ root, command }) => {
    command('lsof', `n${root}\n`);
    assert.strictEqual(listActiveProcessPaths(), null);
    command('ps', `node ${root}/discarded.js\n`, 1);
    assert.strictEqual(listActiveProcessPaths(), null);
  });
});
