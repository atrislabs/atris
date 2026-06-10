const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-confidence-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  const res = runCli(['init'], { cwd: dir, input: '\n' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
}

test('plan, do, and review prompts include the confidence gate', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const plan = runCli(['plan', 'ship a small thing'], { cwd: dir });
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /Run the Confidence Gate before writing tasks/);
    assert.match(plan.stdout, /stale sources, missing owner, weak proof/);

    const doing = runCli(['do'], { cwd: dir });
    assert.equal(doing.status, 0, doing.stderr);
    assert.match(doing.stdout, /Run the Confidence Gate against the task before editing/);
    assert.match(doing.stdout, /rerun the gate against proof and residual risk/);

    // Default review is concise and points to --verbose for the legacy gate.
    const review = runCli(['review'], { cwd: dir });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /atris review --verbose/);

    // The full Confidence Gate lives in the verbose validator prompt.
    const verboseReview = runCli(['review', '--verbose'], { cwd: dir });
    assert.equal(verboseReview.status, 0, verboseReview.stderr);
    assert.match(verboseReview.stdout, /Confidence Gate:/);
    assert.match(verboseReview.stdout, /never use 100% as a vibe/);
  } finally {
    cleanupTempDir(dir);
  }
});
