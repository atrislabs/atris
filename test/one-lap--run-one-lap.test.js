'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function withFixture(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lap-direct-'));
  const savedEnv = { ...process.env };
  const originalLog = console.log;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    const { runOneLap } = require('../commands/one-lap');
    console.log = (...args) => output.push(args.join(' '));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    await check({
      root,
      seed(wishes) {
        fs.writeFileSync(path.join(state, 'wishes.jsonl'), wishes.map(JSON.stringify).join('\n') + '\n');
      },
      async run(ask) {
        output.length = 0;
        const code = await runOneLap(ask, {
          root,
          asJson: true,
          ownCli() { assert.fail('this path must not run CLI commands'); },
          progress() { assert.fail('this path must not start engine work'); },
        });
        assert.strictEqual(output.length, 1);
        return { code, result: JSON.parse(output[0]) };
      },
    });
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('runOneLap resumes the newest matching request awaiting input and releases its lock', async () => {
  await withFixture(async ({ root, seed, run }) => {
    seed([
      { id: 'wish-old', text: 'fix parser', status: 'needs_input', ts: '2020-01-01T00:00:00Z', questions: ['Old question?'] },
      { id: 'wish-current', text: 'FIX parser', status: 'waiting_input', ts: '2020-01-02T00:00:00Z', questions: ['Which format?'] },
      { id: 'wish-other', text: 'fix renderer', status: 'needs_input', ts: '2020-01-03T00:00:00Z', questions: ['Unrelated?'] },
    ]);
    const { code, result } = await run('  fix\n parser  ');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(result, {
      schema: 'atris.one_lap.v1', ok: true, status: 'waiting_input', ask: 'fix parser',
      wish_id: 'wish-current', task_id: null, mission_id: null,
      engine: null, validator: null, verifier: null,
      question: 'Which format?', next_action: 'atris wish answer wish-current \'<answer>\'', resumed: true,
    });
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.atris', 'state', 'one-lap-locks')), []);
  });
});

test('runOneLap supplies a fallback when a saved waiting request has no questions', async () => {
  await withFixture(async ({ seed, run }) => {
    seed([{ id: 'wish-empty-question', text: 'write docs', status: 'waiting_on_operator', ts: '2020-01-01T00:00:00Z', questions: [] }]);
    const { code, result } = await run('write docs');
    assert.strictEqual(code, 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'waiting_input');
    assert.strictEqual(result.resumed, true);
    assert.strictEqual(result.question, 'the existing lap needs operator input before it can continue');
    assert.strictEqual(result.next_action, 'atris wish answer wish-empty-question \'<answer>\'');
  });
});

test('runOneLap rejects empty input without creating a lock', async () => {
  await withFixture(async ({ root, run }) => {
    for (const ask of [undefined, '', ' \n\t ']) {
      const { code, result } = await run(ask);
      assert.strictEqual(code, 2);
      assert.deepStrictEqual(result, {
        schema: 'atris.one_lap.v1', ok: false, status: 'stuck',
        reason: 'a request is required', next_action: 'atris "<request>"',
      });
    }
    assert.strictEqual(fs.existsSync(path.join(root, '.atris', 'state', 'one-lap-locks')), false);
  });
});

test('runOneLap directs an outbound request to the gated wish flow', async () => {
  await withFixture(async ({ root, run }) => {
    const { code, result } = await run('  deploy\n to production  ');
    assert.strictEqual(code, 2);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'stuck');
    assert.strictEqual(result.ask, 'deploy to production');
    assert.strictEqual(result.reason, 'the request includes an outbound or irreversible action');
    assert.strictEqual(result.next_action, "atris wish 'deploy to production'");
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.atris', 'state', 'one-lap-locks')), []);
  });
});
