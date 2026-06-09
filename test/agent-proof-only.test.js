const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'DEVIN_SESSION_ID',
];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-proof-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function baseEnv() {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  for (const marker of AGENT_MARKERS) delete env[marker];
  delete env.ATRIS_AGENT_PROOF_ONLY;
  return env;
}

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...baseEnv(), ...(env || {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function setupReviewTask(dir) {
  const init = runCli(['init'], { cwd: dir, input: '\n' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const created = runCli(['task', 'new', 'Guard accept from agents', '--tag', 'test'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const id = String(created.stdout).trim().split(/\s+/)[0];
  assert.ok(id, `expected task id in output: ${created.stdout}`);
  const claimed = runCli(['task', 'claim', id, '--as', 'executor'], { cwd: dir });
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const ready = runCli(
    ['task', 'ready', id, '--proof', 'node --test test/agent-proof-only.test.js -> pass'],
    { cwd: dir },
  );
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  return id;
}

test('task accept is blocked when an agent env marker is present', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    for (const marker of AGENT_MARKERS) {
      const res = runCli(['task', 'accept', id], { cwd: dir, env: { [marker]: '1' } });
      assert.notEqual(res.status, 0, `${marker}: accept should fail\n${res.stdout}`);
      assert.match(
        `${res.stdout}${res.stderr}`,
        /cannot accept tasks or award XP/i,
        `${marker}: expected proof-only block`,
      );
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('ATRIS_AGENT_PROOF_ONLY=0 overrides agent env detection for human accept', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    const res = runCli(['task', 'accept', id], {
      cwd: dir,
      env: { CLAUDECODE: '1', ATRIS_AGENT_PROOF_ONLY: '0' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /accepted/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('explicit ATRIS_AGENT_PROOF_ONLY=1 still blocks accept without agent markers', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    const res = runCli(['task', 'accept', id], { cwd: dir, env: { ATRIS_AGENT_PROOF_ONLY: '1' } });
    assert.notEqual(res.status, 0, `accept should fail\n${res.stdout}`);
    assert.match(`${res.stdout}${res.stderr}`, /cannot accept tasks or award XP/i);
  } finally {
    cleanupTempDir(dir);
  }
});
