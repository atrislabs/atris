'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { treeCommand } = require('../commands/tree');

const USAGE = 'usage: atris tree hash [--json]';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function capture(fn) {
  const logs = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    return { code: fn(), logs, errors };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tree-command-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('atris tree command', { concurrency: false }, () => {
  test('help prints the usage line and returns 0', () => {
    for (const subcommand of ['help', '--help', '-h']) {
      const result = capture(() => treeCommand(subcommand));
      assert.strictEqual(result.code, 0);
      assert.deepStrictEqual(result.logs, [USAGE]);
      assert.deepStrictEqual(result.errors, []);
    }
  });

  test('an unknown or missing name prints the error and usage and returns 2', () => {
    const named = capture(() => treeCommand('prune'));
    assert.strictEqual(named.code, 2);
    assert.deepStrictEqual(named.errors, ['unknown tree command: prune']);
    assert.deepStrictEqual(named.logs, [USAGE]);

    const missing = capture(() => treeCommand());
    assert.strictEqual(missing.code, 2);
    assert.deepStrictEqual(missing.errors, ['unknown tree command:']);
    assert.deepStrictEqual(missing.logs, [USAGE]);
  });

  test('hash reports the working directory and --json prints the same result', () => {
    withTempRoot((dir) => {
      const empty = capture(() => treeCommand('hash'));
      assert.strictEqual(empty.code, 0);
      assert.deepStrictEqual(empty.errors, []);
      assert.deepStrictEqual(empty.logs, [`${EMPTY_HASH.slice(0, 12)}  0 files`]);

      fs.mkdirSync(path.join(dir, 'atris', 'skills', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'atris.md'), 'doctrine\n');
      fs.writeFileSync(path.join(dir, 'atris', 'skills', 'demo', 'SKILL.md'), 'skill\n');

      const plain = capture(() => treeCommand('hash', 'ignored'));
      const json = capture(() => treeCommand('hash', 'ignored', '--json'));
      assert.strictEqual(plain.code, 0);
      assert.strictEqual(json.code, 0);
      assert.deepStrictEqual(plain.errors, []);
      assert.deepStrictEqual(json.errors, []);

      const parsed = JSON.parse(json.logs[0]);
      assert.strictEqual(parsed.schema, 'atris.tree_hash.v1');
      assert.strictEqual(parsed.files, 2);
      assert.strictEqual(parsed.short, parsed.hash.slice(0, 12));
      assert.notStrictEqual(parsed.hash, EMPTY_HASH);
      assert.deepStrictEqual(parsed.manifest.map((file) => file.path), [
        'atris.md',
        'atris/skills/demo/SKILL.md',
      ]);
      assert.deepStrictEqual(plain.logs, [`${parsed.short}  ${parsed.files} files`]);
    });
  });

  test('hash returns 1 when a doctrine path cannot be read', () => {
    withTempRoot((dir) => {
      fs.mkdirSync(path.join(dir, 'atris.md'));
      const result = capture(() => treeCommand('hash'));
      assert.strictEqual(result.code, 1);
      assert.deepStrictEqual(result.logs, []);
      assert.strictEqual(result.errors.length, 1);
      assert.match(result.errors[0], /^tree hash failed: /);
    });
  });
});
