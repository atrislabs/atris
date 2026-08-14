'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fleet = require('../lib/fleet');

const WATCHDOG = path.join(__dirname, '..', 'scripts', 'det', 'codex-watchdog.js');
const TASK = { display_id: 'CLI-WATCHDOG', title: 'test codex dispatch' };

function shellQuoted(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

test('buildEngineCommand wraps codex through the watchdog with stdin sealed', () => {
  const cmd = fleet.buildEngineCommand('codex', '/tmp/p.md');
  assert.ok(cmd.startsWith(`${shellQuoted(process.execPath)} ${shellQuoted(WATCHDOG)} --startup-deadline 90 --max-runtime 3600 -- sh -c '`));
  assert.match(cmd, /<\/dev\/null$/);
  assert.match(cmd, /sh -c 'codex exec /);
});

test('buildEngineCommand keeps sealed and yolo flags inside the wrapped codex command', () => {
  const sealed = fleet.buildEngineCommand('codex', '/tmp/p.md', { sealed: true });
  assert.match(sealed, /codex-watchdog\.js/);
  assert.match(sealed, /<\/dev\/null$/);
  assert.match(sealed, /sh -c 'codex exec --sandbox workspace-write --ephemeral --ignore-user-config --ignore-rules /);

  const yolo = fleet.buildEngineCommand('codex', '/tmp/p.md', { yolo: true });
  assert.match(yolo, /codex-watchdog\.js/);
  assert.match(yolo, /<\/dev\/null$/);
  assert.match(yolo, /sh -c 'codex exec --dangerously-bypass-approvals-and-sandbox /);
});

test('buildEngineCommand leaves non-codex engines unwrapped', () => {
  assert.match(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /^cursor-agent --trust -p/);
  assert.doesNotMatch(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /codex-watchdog/);
  assert.match(fleet.buildEngineCommand('claude', '/tmp/p.md'), /^claude -p /);
  assert.doesNotMatch(fleet.buildEngineCommand('claude', '/tmp/p.md'), /codex-watchdog/);
  assert.match(fleet.buildEngineCommand('devin', '/tmp/p.md'), /^devin -p --permission-mode dangerous /);
  assert.doesNotMatch(fleet.buildEngineCommand('devin', '/tmp/p.md'), /codex-watchdog/);
});

test('dispatchToEngine copies the codex watchdog beside the prompt and gives it the long backstop', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-codex-watchdog-'));
  try {
    let invocation;
    const result = fleet.dispatchToEngine({
      task: TASK,
      engine: 'codex',
      worktreePath: worktree,
      runner: (command, options) => {
        invocation = { command, options };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const watchdogCopy = path.join(worktree, '.atris', 'codex-watchdog.js');
    assert.equal(result.exitCode, 0);
    assert.ok(fs.existsSync(watchdogCopy));
    assert.equal(fs.readFileSync(watchdogCopy, 'utf8'), fs.readFileSync(WATCHDOG, 'utf8'));
    assert.ok(invocation.command.startsWith(`${shellQuoted(process.execPath)} ${shellQuoted(watchdogCopy)} `));
    assert.match(invocation.command, /--receipt '[^']+\/\.atris\/codex-watchdog-CLI-WATCHDOG-[a-f0-9]+\.json'/);
    assert.match(result.watchdog_artifact, /codex-watchdog-CLI-WATCHDOG-[a-f0-9]+\.json$/);
    assert.equal(invocation.options.timeoutMs, 3660000);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('sealed codex dispatch copies the watchdog beside the runtime prompt', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sealed-worktree-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sealed-runtime-'));
  try {
    let command = '';
    fleet.dispatchToEngine({
      task: TASK,
      engine: 'codex',
      worktreePath: worktree,
      sealed: true,
      environment: { ATRIS_ONE_LAP_RUNTIME_DIR: runtimeDir },
      runner: (value) => {
        command = value;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const watchdogCopy = path.join(runtimeDir, 'codex-watchdog.js');
    assert.ok(fs.existsSync(path.join(runtimeDir, 'fleet-prompt-CLI-WATCHDOG.md')));
    assert.ok(fs.existsSync(watchdogCopy));
    assert.ok(command.startsWith(`${shellQuoted(process.execPath)} ${shellQuoted(watchdogCopy)} `));
    assert.ok(!command.includes(shellQuoted(WATCHDOG)));
    assert.ok(command.includes(`--receipt '${path.join(worktree, '.atris', 'codex-watchdog-CLI-WATCHDOG-')}`));
    assert.ok(!command.includes(`${runtimeDir}/codex-watchdog-CLI-WATCHDOG`));
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('dispatch result preserves the watchdog timeout artifact before cleanup', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watchdog-artifact-'));
  try {
    const artifact = {
      schema: 'atris.codex_watchdog_receipt.v1',
      status: 'timed_out',
      reason: 'max_runtime',
      exit_code: 125,
    };
    const result = fleet.dispatchToEngine({
      task: TASK,
      engine: 'codex',
      worktreePath: worktree,
      runner: (command) => {
        const receiptPath = (command.match(/--receipt '([^']+)'/) || [])[1];
        fs.writeFileSync(receiptPath, `${JSON.stringify(artifact)}\n`);
        return { status: 125, stdout: '', stderr: 'watchdog timed out' };
      },
    });
    assert.equal(result.exitCode, 125);
    assert.deepEqual(result.watchdog_receipt, artifact);
    assert.equal(fs.existsSync(result.watchdog_artifact), true);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('non-codex dispatch keeps the 15 minute default backstop', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cursor-timeout-'));
  try {
    let timeoutMs;
    fleet.dispatchToEngine({
      task: TASK,
      engine: 'cursor',
      worktreePath: worktree,
      runner: (_command, options) => {
        timeoutMs = options.timeoutMs;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(timeoutMs, 900000);
    assert.equal(fs.existsSync(path.join(worktree, '.atris', 'codex-watchdog.js')), false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
