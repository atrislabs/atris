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

test('cloud mission fanout sends one entry per role and names them back', async () => {
  const root = tempDir();
  const calls = [];
  const output = capture();
  try {
    const result = await runCloudMissionCommand([
      'ship the launch',
      '--cloud',
      '--fanout',
      'researcher:read the competitor pricing pages',
      '--fanout=builder:draft the pricing table',
    ], {
      root,
      ...output,
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return {
          ok: true,
          status: 200,
          data: { task_id: 'task-fanout-1', status: 'pending', lane: 'fast' },
        };
      },
    });

    assert.equal(result.exitCode, 0, output.stderr.join('\n'));
    assert.deepEqual(calls[0].options.body.fanout, [
      { role: 'researcher', task: 'read the competitor pricing pages' },
      { role: 'builder', task: 'draft the pricing table' },
    ]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8').trim()).fanout,
      [
        { role: 'researcher', task: 'read the competitor pricing pages' },
        { role: 'builder', task: 'draft the pricing table' },
      ],
    );
    assert.match(output.stdout.join('\n'), /working in parallel: researcher, builder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mission with no fanout flag still sends the plain body', async () => {
  const root = tempDir();
  const calls = [];
  try {
    await runCloudMissionCommand(['ship the launch', '--cloud'], {
      root,
      log: () => {},
      error: () => {},
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return { ok: true, status: 200, data: { task_id: 'task-plain', status: 'pending', lane: 'fast' } };
      },
    });
    assert.equal('fanout' in calls[0].options.body, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cloud mission fanout refuses a role with no task and more than eight roles', () => {
  assert.throws(
    () => parseCloudRunArgs(['do work', '--cloud', '--fanout', 'researcher']),
    /needs a role and a task/,
  );
  assert.throws(
    () => parseCloudRunArgs(['do work', '--cloud', '--fanout', ':read the docs']),
    /needs a role and a task/,
  );
  const nine = [];
  for (let i = 0; i < 9; i += 1) nine.push('--fanout', `role${i}:task ${i}`);
  assert.throws(
    () => parseCloudRunArgs(['do work', '--cloud', ...nine]),
    /at most 8 roles, got 9/,
  );
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
