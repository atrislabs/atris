'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function withCommand(t, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-feedback-command-'));
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const logs = [];
  const errors = [];
  const exit = new Error('feedback requested process exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => {
      assert.strictEqual(code, 1);
      throw exit;
    });
    const { feedbackCommand } = require('../commands/feedback');
    await run({
      home, logs, errors, exit,
      invoke: async (...args) => {
        logs.length = 0;
        errors.length = 0;
        process.argv = [process.execPath, 'atris', 'feedback', ...args];
        return feedbackCommand();
      },
    });
  } finally {
    t.mock.restoreAll();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('feedback help aliases print usage and available actions without authentication', async (t) => {
  await withCommand(t, async ({ invoke, logs, errors }) => {
    let expected;
    for (const alias of ['help', '--help', '-h']) {
      assert.strictEqual(await invoke(alias), undefined);
      assert.ok(logs.includes('Usage:'));
      assert.ok(logs.includes('  atris feedback submit "message"        Submit feedback (global)'));
      assert.ok(logs.includes('  atris feedback triage <id> --dispatch  Run triage and record its verdict'));
      assert.ok(logs.includes('IDs may be the first 8 chars of the UUID.'));
      assert.deepStrictEqual(errors, []);
      if (expected) assert.deepStrictEqual(logs, expected);
      expected = [...logs];
    }
  });
});

test('feedback accepts business flags resolved from a temporary business map or UUID', async (t) => {
  await withCommand(t, async ({ home, invoke, logs, errors }) => {
    const id = '12345678-1234-1234-1234-123456789abc';
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      studio: { slug: 'sound-room', business_id: id },
    }));
    for (const flags of [
      ['--business', 'studio'], ['--business=sound-room'], ['-b', 'studio'],
      [`--business=${id}`],
    ]) {
      await invoke('help', ...flags);
      assert.ok(logs.includes('Usage:'));
      assert.deepStrictEqual(errors, []);
    }
  });
});

test('feedback rejects unknown businesses with missing or malformed local state', async (t) => {
  await withCommand(t, async ({ home, invoke, logs, errors, exit }) => {
    for (const malformed of [false, true]) {
      if (malformed) {
        fs.mkdirSync(path.join(home, '.atris'));
        fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), '{broken');
      }
      await assert.rejects(invoke('help', '--business=missing'), (error) => error === exit);
      assert.deepStrictEqual(errors, [
        'Error: unknown business "missing". Check ~/.atris/businesses.json',
      ]);
      assert.deepStrictEqual(logs, []);
    }
  });
});

test('feedback rejects empty messages and invalid triage arguments before authentication', async (t) => {
  await withCommand(t, async ({ invoke, logs, errors, exit }) => {
    for (const args of [['submit'], ['submit', '  ', '\t'], ['   ']]) {
      await assert.rejects(invoke(...args), (error) => error === exit);
      assert.strictEqual(errors[0], 'Error: feedback message is required.');
      assert.ok(errors.includes('Usage:'));
      assert.deepStrictEqual(logs, []);
    }
    for (const args of [['triage'], ['triage', 'abc', 'extra'], ['triage', '--dispatch']]) {
      await assert.rejects(invoke(...args), {
        message: 'usage: atris feedback triage <id> [--dispatch]',
      });
      assert.deepStrictEqual(logs, []);
      assert.deepStrictEqual(errors, []);
    }
  });
});
