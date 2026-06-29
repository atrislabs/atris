const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-lane-auto-review-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writePassingReceipt(dir, rel = 'atris/runs/proof.json') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-test',
    result: { passed: true },
  }) + '\n', 'utf8');
  return rel;
}

function writeFailingReceipt(dir, rel = 'atris/runs/failing.json') {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-test',
    result: { passed: false },
  }) + '\n', 'utf8');
  return rel;
}

function readyTaskWithProof(dir, proof) {
  const created = runCli(['task', 'new', 'auto review probe', '--tag', 'probe'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const ref = created.stdout.trim().split('\t')[0];
  assert.ok(ref, 'task ref required');
  const claimed = runCli(['task', 'claim', ref, '--as', 'probe-agent'], { cwd: dir });
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const ready = runCli(['task', 'ready', ref, '--proof', proof], { cwd: dir });
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  return ref;
}

function laneCounts(dir) {
  const res = runCli(['task', 'review-lane-drain', '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).review_state_counts;
}

function reviewLaneRun(dir) {
  const res = runCli(['task', 'review-lane-run', '--json'], { cwd: dir });
  const payload = JSON.parse(res.stdout);
  return { status: res.status, payload };
}

test('review lane drains a green-receipt task to certified with zero human turns', () => {
  const dir = makeTempDir();
  try {
    const receipt = writePassingReceipt(dir);
    const ref = readyTaskWithProof(dir, `suite green; receipt ${receipt}`);

    // Cadence simulation: bounded agent-only runs, no human commands in between.
    const first = reviewLaneRun(dir);
    assert.equal(first.payload.ok, true, JSON.stringify(first.payload).slice(0, 400));
    const second = reviewLaneRun(dir);
    assert.equal(second.payload.ok, true, JSON.stringify(second.payload).slice(0, 400));

    const counts = laneCounts(dir);
    assert.equal(counts.needs_agent, 0, 'needs-agent must drain');
    assert.equal(counts.certified, 1, 'green-receipt task must reach certified agent-side');

    // The human gate stays intact: certification is not acceptance.
    const show = runCli(['task', 'show', ref], { cwd: dir });
    assert.match(show.stdout, /Approval: pending|Landing: waiting on human/);
    assert.match(show.stdout, /Agent certified: yes|Checked: yes \(\d+ agent checks\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto review refuses prose-only proof and stays safely stopped', () => {
  const dir = makeTempDir();
  try {
    readyTaskWithProof(dir, 'ran node --test test/sample.test.js: 3/3 pass, no receipt file written');
    reviewLaneRun(dir); // posts the review chat
    const second = reviewLaneRun(dir);
    assert.equal(second.payload.ok, true, 'no-evidence stop must stay a safe stop');
    assert.equal(second.payload.stopped_reason, 'auto_review_no_green_evidence');
    const counts = laneCounts(dir);
    assert.equal(counts.certified, 0, 'prose-only proof must not certify');
  } finally {
    cleanupTempDir(dir);
  }
});

test('evidence-less reviews do not head-block green tasks behind them', () => {
  const dir = makeTempDir();
  try {
    // Task A: meaningful proof, no receipt. Task B behind it: green receipt.
    readyTaskWithProof(dir, 'ran node --test test/sample.test.js: 3/3 pass, no receipt file written');
    const receipt = writePassingReceipt(dir);
    readyTaskWithProof(dir, `suite green; receipt ${receipt}`);

    reviewLaneRun(dir); // review chats for both
    const second = reviewLaneRun(dir); // auto review: skips A, certifies B
    assert.equal(second.payload.ok, true, JSON.stringify(second.payload).slice(0, 400));

    const counts = laneCounts(dir);
    assert.equal(counts.certified, 1, 'green task must certify despite the blocked one ahead');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto review rejects failing receipts', () => {
  const dir = makeTempDir();
  try {
    const receipt = writeFailingReceipt(dir);
    readyTaskWithProof(dir, `ran checks; receipt ${receipt}`);
    reviewLaneRun(dir);
    const second = reviewLaneRun(dir);
    assert.equal(second.payload.stopped_reason, 'auto_review_no_green_evidence');
    assert.equal(laneCounts(dir).certified, 0, 'failing receipt must not certify');
  } finally {
    cleanupTempDir(dir);
  }
});
