'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseCloudRunArgs,
  runCloudMissionCommand,
  statusCloudMissionCommand,
  withReceiptVoice,
} = require('../lib/cloud-mission');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cloud-mission-test-'));
}

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    log: (line) => stdout.push(String(line)),
    error: (line) => stderr.push(String(line)),
  };
}

test('cloud mission enqueue sends the backend contract and appends a local receipt', async () => {
  const root = tempDir();
  const calls = [];
  const output = capture();
  try {
    const result = await runCloudMissionCommand([
      'ship cloud missions',
      '--cloud',
      '--lane',
      'pro',
    ], {
      root,
      ...output,
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return {
          ok: true,
          status: 200,
          data: { task_id: 'task-cloud-1', status: 'pending', lane: 'pro' },
        };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, [{
      pathname: '/atris2/missions',
      options: {
        method: 'POST',
        token: 'test-token',
        body: { text: withReceiptVoice('ship cloud missions'), lane: 'pro' },
      },
    }]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8').trim()),
      { cloud: true, task_id: 'task-cloud-1', lane: 'pro', text: 'ship cloud missions' },
    );
    assert.deepEqual(output.stdout, [
      'cloud mission queued: task-cloud-1',
      'lane: pro',
      'next: atris mission status --cloud task-cloud-1',
    ]);
    assert.deepEqual(output.stderr, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cloud mission enqueue passes an explicit agent id to the backend', async () => {
  const root = tempDir();
  const calls = [];
  try {
    const result = await runCloudMissionCommand([
      'ship with a business agent',
      '--cloud',
      '--agent',
      'agent-business-1',
    ], {
      root,
      log: () => {},
      error: () => {},
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return {
          ok: true,
          status: 200,
          data: { task_id: 'task-cloud-agent', status: 'pending', lane: 'fast' },
        };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[0].options.body, {
      text: withReceiptVoice('ship with a business agent'),
      lane: 'fast',
      agent_id: 'agent-business-1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cloud mission status parses the cloud task id and prints backend status', async () => {
  const calls = [];
  const output = capture();
  const result = await statusCloudMissionCommand(['--cloud', 'task/with-slash'], {
    ...output,
    loadCredentials: () => ({ token: 'status-token' }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          task_id: 'task/with-slash',
          status: 'running',
          lane: 'max',
          result: { summary: 'working through the mission' },
        },
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{
    pathname: '/atris2/missions/task%2Fwith-slash',
    options: { method: 'GET', token: 'status-token' },
  }]);
  assert.deepEqual(output.stdout, [
    'cloud mission: task/with-slash',
    '  status: running',
    '  lane: max',
    '  summary: working through the mission',
  ]);
});

test('cloud mission watch polls every ten seconds and exits on completion', async () => {
  const responses = [
    { task_id: 'task-watch', status: 'pending', lane: 'fast', result: null },
    { task_id: 'task-watch', status: 'completed', lane: 'fast', result: { summary: 'mission shipped' } },
  ];
  const sleeps = [];
  const output = capture();
  const result = await statusCloudMissionCommand(['--cloud', 'task-watch', '--watch'], {
    ...output,
    loadCredentials: () => ({ token: 'watch-token' }),
    apiRequestJson: async () => ({ ok: true, status: 200, data: responses.shift() }),
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(sleeps, [10_000]);
  assert.match(output.stdout.join('\n'), /status: completed/);
  assert.match(output.stdout.join('\n'), /summary: mission shipped/);
});

test('cloud mission rejects lanes outside fast, pro, and max', async () => {
  assert.deepEqual(
    parseCloudRunArgs(['do work', '--cloud']),
    { text: 'do work', lane: 'fast', asJson: false },
  );
  assert.throws(
    () => parseCloudRunArgs(['do work', '--cloud', '--lane', 'turbo']),
    /invalid --lane "turbo"\. expected fast, pro, or max/,
  );

  const output = capture();
  let requested = false;
  const result = await runCloudMissionCommand(['do work', '--cloud', '--lane', 'turbo'], {
    ...output,
    loadCredentials: () => ({ token: 'unused' }),
    apiRequestJson: async () => {
      requested = true;
      return { ok: true, data: {} };
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(requested, false);
  assert.match(output.stderr[0], /invalid --lane/);
});

test('wish grant --cloud enqueues the answered wish and records the task id on the same wish', async () => {
  const { wishCommand } = require('../commands/wish');
  const { appendWishRecord } = require('../lib/wish-store');
  const root = fs.realpathSync(tempDir());
  const startedIn = process.cwd();
  const calls = [];
  const output = capture();
  try {
    process.chdir(root);
    appendWishRecord(root, {
      id: 'wish-cloud-grant-1',
      n: 1,
      ts: new Date().toISOString(),
      text: 'make the nightly report load faster',
      status: 'needs_input',
      questions: ['Which nightly report did you mean?'],
    });

    const code = await wishCommand([
      'grant',
      '1',
      'the nightly report on the ops dashboard',
      '--cloud',
      '--lane',
      'pro',
    ], {
      ...output,
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return {
          ok: true,
          status: 200,
          data: { task_id: 'task-wish-cloud-1', status: 'pending', lane: 'pro' },
        };
      },
    });

    assert.equal(code, 0, output.stderr.join('\n'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/atris2/missions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.body.lane, 'pro');
    // The cloud gets the wish plus the answer, not the unanswered wish.
    assert.match(calls[0].options.body.text, /nightly report on the ops dashboard/);

    const lines = fs.readFileSync(path.join(root, '.atris', 'state', 'wishes.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const delegated = lines.filter((row) => row.status === 'delegated');
    assert.equal(delegated.length, 1);
    assert.equal(delegated[0].id, 'wish-cloud-grant-1');
    assert.equal(delegated[0].cloud, true);
    assert.equal(delegated[0].task_id, 'task-wish-cloud-1');
    assert.equal(delegated[0].lane, 'pro');
    assert.match(output.stdout.join('\n'), /task-wish-cloud-1/);
  } finally {
    process.chdir(startedIn);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wish grant --cloud rejects a bad lane before touching the backend', async () => {
  const { wishCommand } = require('../commands/wish');
  const output = capture();
  const code = await wishCommand(['grant', '1', 'an answer', '--cloud', '--lane', 'turbo'], {
    ...output,
    loadCredentials: () => {
      throw new Error('credentials must not load for an invalid lane');
    },
    apiRequestJson: async () => {
      throw new Error('backend must not be called for an invalid lane');
    },
  });
  assert.equal(code, 2);
  assert.match(output.stderr.join('\n'), /invalid --lane "turbo"/);
});

test('mission run cloud dispatch rejects a bad lane before local mission setup', () => {
  const root = tempDir();
  try {
    const result = spawnSync(process.execPath, [
      cliPath,
      'mission',
      'run',
      'do cloud work',
      '--cloud',
      '--lane',
      'turbo',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /invalid --lane "turbo"/);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
