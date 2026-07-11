'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { wishCommand } = require('../commands/wish');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-cloud-test-'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

test('wish cloud enqueues the text and records the cloud receipt', async () => {
  const root = tempDir();
  const previousCwd = process.cwd();
  const calls = [];
  const stdout = [];
  try {
    process.chdir(root);
    const code = await wishCommand([
      'make cloud wishes real',
      '--cloud',
      '--lane',
      'pro',
      '--agent',
      'agent-42',
    ], {
      ts: '2026-07-11T12:00:00.000Z',
      wishId: 'wish-cloud-1',
      log: (line) => stdout.push(String(line)),
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return {
          ok: true,
          status: 200,
          data: { task_id: 'task-cloud-wish-1', status: 'pending', lane: 'pro' },
        };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(calls, [{
      pathname: '/atris2/missions',
      options: {
        method: 'POST',
        token: 'test-token',
        body: { text: 'make cloud wishes real', lane: 'pro', agent_id: 'agent-42' },
      },
    }]);
    assert.deepEqual(
      readJsonl(path.join(root, '.atris', 'state', 'wishes.jsonl')),
      [{
        id: 'wish-cloud-1',
        n: 1,
        ts: '2026-07-11T12:00:00.000Z',
        text: 'make cloud wishes real',
        status: 'delegated',
        dispatched_at: '2026-07-11T12:00:00.000Z',
        cloud: true,
        task_id: 'task-cloud-wish-1',
        lane: 'pro',
      }],
    );
    assert.deepEqual(stdout, [
      'task_id: task-cloud-wish-1',
      'watch: atris mission status --cloud task-cloud-wish-1 --watch',
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wish cloud rejects an invalid lane before making a request or writing state', async () => {
  const root = tempDir();
  const previousCwd = process.cwd();
  const stderr = [];
  let requested = false;
  try {
    process.chdir(root);
    const code = await wishCommand(['do cloud work', '--cloud', '--lane', 'turbo'], {
      error: (line) => stderr.push(String(line)),
      loadCredentials: () => ({ token: 'unused' }),
      apiRequestJson: async () => {
        requested = true;
        return { ok: true, data: {} };
      },
    });

    assert.equal(code, 2);
    assert.equal(requested, false);
    assert.deepEqual(stderr, ['invalid --lane "turbo". expected fast, pro, or max']);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
