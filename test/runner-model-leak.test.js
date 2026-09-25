'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { buildRunnerCommand } = require('../lib/runner-command');
const { resolveMissionTickRunnerModel } = require('../commands/mission');
const fleet = require('../lib/fleet');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

// The tick spawn hands resolveMissionTickRunnerModel's answer to
// buildRunnerCommand, so the pair is the command a mission tick would run.
function tickCommand(mission) {
  return buildRunnerCommand({
    promptFile: '/tmp/p.tmp',
    model: resolveMissionTickRunnerModel(mission),
  });
}

test('an unpinned grok mission tick carries no --model flag', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'grok' }, () => {
    const command = tickCommand({ runner: 'grok' });
    assert.doesNotMatch(command, /--model/);
    assert.equal(command, 'grok --always-approve -p "$(cat /tmp/p.tmp)"');
  });
});

test('an unpinned devin mission tick carries no --model flag', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'devin' }, () => {
    const command = tickCommand({ runner: 'devin' });
    assert.doesNotMatch(command, /--model/);
    assert.equal(command, 'devin -p -- "$(cat /tmp/p.tmp)"');
  });
});

test('a pinned grok or devin mission tick keeps its own model flag', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'grok' }, () => {
    assert.match(
      tickCommand({ runner: 'grok', model: 'grok-4.7-build-fast' }),
      /--model grok-4\.7-build-fast/,
    );
  });
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'devin' }, () => {
    assert.match(
      tickCommand({ runner: 'devin', model: 'swe-2-max' }),
      /--model swe-2-max/,
    );
  });
});

test('an unpinned claude mission tick still pins the default model', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'claude' }, () => {
    assert.match(tickCommand({ runner: 'claude' }), /--model claude-opus-5-5/);
    assert.equal(resolveMissionTickRunnerModel({ runner: 'manual' }), 'claude-opus-5-5');
  });
});

test('a dispatch time cap kills the whole engine process group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-groupkill-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-groupkill-wt-'));
  const binDir = path.join(root, 'bin');
  const pidFile = path.join(root, 'grandchild.pid');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, [
    '#!/bin/sh',
    'sleep 30 &',
    `echo $! > "${pidFile}"`,
    'wait',
    '',
  ].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
  try {
    const result = await fleet.dispatchToEngine({
      task: { display_id: 'CLI-KILL', status: 'open', title: 'x Done: x. Check: y.' },
      engine: 'cursor',
      worktreePath: wt,
      skipBriefCapture: true,
      liveLogPath: path.join(root, 'dispatch.live.log'),
      timeoutMs: 300,
      environment: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.timed_out, true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the engine should have written its grandchild pid');
    // The orphan is reaped by init once the group is gone, so allow a beat.
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    assert.throws(() => process.kill(pid, 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

// A detached dispatch child leads its own group, so Ctrl-C on the parent
// never reaches the engine; the guard must kill the group and re-raise.
test('ctrl-c on a dispatch kills the engine process group too', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const repoRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-wt-'));
  const binDir = path.join(root, 'bin');
  const pidFile = path.join(root, 'grandchild.pid');
  const parentScript = path.join(root, 'parent.js');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, [
    '#!/bin/sh',
    'sleep 30 &',
    `echo $! > "${pidFile}"`,
    'wait',
    '',
  ].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
  fs.writeFileSync(parentScript, [
    'const path = require("path");',
    'const fleet = require(process.argv[2]);',
    'const [binDir, wt, liveLog] = process.argv.slice(3);',
    'fleet.dispatchToEngine({',
    '  task: { display_id: "CLI-SIGINT", status: "open", title: "x Done: x. Check: y." },',
    '  engine: "cursor",',
    '  worktreePath: wt,',
    '  skipBriefCapture: true,',
    '  liveLogPath: liveLog,',
    '  environment: { PATH: binDir + path.delimiter + process.env.PATH },',
    '});',
    '',
  ].join('\n'));
  const parent = spawn(process.execPath, [
    parentScript,
    path.join(repoRoot, 'lib', 'fleet.js'),
    binDir,
    wt,
    path.join(root, 'dispatch.live.log'),
  ], { cwd: repoRoot, stdio: 'inherit' });
  try {
    await waitUntil(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the engine should have written its grandchild pid');
    parent.kill('SIGINT');
    const closed = await new Promise((resolve) => {
      const bail = setTimeout(() => resolve(null), 10000);
      parent.once('close', (code, sig) => {
        clearTimeout(bail);
        resolve({ code, sig });
      });
    });
    assert.ok(closed, 'the parent should exit on SIGINT');
    assert.equal(closed.sig, 'SIGINT');
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 5000);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

// Every guard a dispatch installs must come back off when the child closes,
// or listener counts grow across many dispatches in one process.
test('a finished dispatch leaves no parent listeners behind', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'];
  const before = new Map(events.map((event) => [event, process.listenerCount(event)]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guard-cleanup-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guard-cleanup-wt-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeCursor, 0o755);
  try {
    const result = await fleet.dispatchToEngine({
      task: { display_id: 'CLI-GUARD', status: 'open', title: 'x Done: x. Check: y.' },
      engine: 'cursor',
      worktreePath: wt,
      skipBriefCapture: true,
      liveLogPath: path.join(root, 'dispatch.live.log'),
      environment: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.exitCode, 0);
    for (const [event, count] of before) {
      assert.equal(process.listenerCount(event), count, `${event} listener count should be restored`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
