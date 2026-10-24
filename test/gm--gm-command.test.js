'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gmCommand } = require('../commands/gm');

// Each call owns its working directory, home, environment, and captured output.
// These tests deliberately avoid board, engine, server, and watch paths.
async function isolated(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-command-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  const output = { logs: [], errors: [] };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    process.exitCode = undefined;
    console.log = (...args) => output.logs.push(args.join(' '));
    console.error = (...args) => output.errors.push(args.join(' '));
    await run(root, output);
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('gmCommand prints help for all supported help spellings before dispatch', async () => {
  await isolated(async (root, output) => {
    let expected;
    for (const args of [['--help'], ['-h'], ['help'], ['phone', '--help']]) {
      output.logs.length = 0;
      assert.strictEqual(await gmCommand(...args), undefined);
      const text = output.logs.join('\n');
      assert.match(text, /Usage: atris gm/);
      assert.match(text, /--no-seed\s+Do not create a starter player mission\./);
      if (expected) assert.strictEqual(text, expected);
      expected = text;
      assert.deepStrictEqual(output.errors, []);
      assert.strictEqual(process.exitCode, undefined);
      assert.deepStrictEqual(fs.readdirSync(root), []);
    }
  });
});

test('gmCommand greets a sleeping member and normalizes a mixed-case email name', async () => {
  await isolated(async (root, output) => {
    const memberDir = path.join(root, 'atris', 'team', 'maze');
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Maze\n');
    const switches = path.join(stateDir, 'member-switches.json');
    const contents = JSON.stringify({ members: { maze: { awake: false } } });
    fs.writeFileSync(switches, contents);
    for (const name of ['maze', '  MAZE@example.test  ']) {
      output.logs.length = 0;
      assert.strictEqual(await gmCommand(name), undefined);
      assert.deepStrictEqual(output.logs, ['maze is asleep']);
      assert.deepStrictEqual(output.errors, []);
      assert.strictEqual(process.exitCode, undefined);
      assert.strictEqual(fs.readFileSync(switches, 'utf8'), contents);
    }
  });
});

test('gmCommand rejects an invalid replay span without reading or creating history', async () => {
  await isolated(async (root, output) => {
    // Invalid spans return before any history lookup or date formatting.
    assert.strictEqual(await gmCommand('replay', '--since', 'not-a-span', '--plain'), undefined);
    assert.deepStrictEqual(output.logs, []);
    assert.deepStrictEqual(output.errors, [
      'replay: --since takes a span like 30m, 12h, 2d, or last-seen',
    ]);
    assert.strictEqual(process.exitCode, 1);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});
