const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-stats-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
}

function appendWishEvent(dir, event) {
  const file = path.join(dir, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function writeReceipt(dir, name, receipt) {
  const file = path.join(dir, 'atris', 'runs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function todayJournalPath(dir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, 'atris', 'logs', String(now.getFullYear()), `${date}.md`);
}

test('wish stats prints week, review, score, and haiku receipt math', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-this-shipped',
      ts: isoDaysAgo(1),
      text: 'make this week shipped',
      status: 'complete',
      completed_at: isoDaysAgo(1),
    });
    appendWishEvent(dir, {
      id: 'wish-this-captured',
      ts: isoDaysAgo(2),
      text: 'make this week captured',
      status: 'captured',
    });
    appendWishEvent(dir, {
      id: 'wish-prior-shipped',
      ts: isoDaysAgo(8),
      text: 'make prior week shipped',
      status: 'complete',
      completed_at: isoDaysAgo(8),
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-this-shipped',
      ts: isoDaysAgo(1),
      review_text: 'great',
      review_score: 5,
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-this-captured',
      ts: isoDaysAgo(2),
      review_text: 'fine',
      review_score: 3,
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-prior-shipped',
      ts: isoDaysAgo(8),
      review_text: 'weak',
      review_score: 2,
    });
    writeReceipt(dir, 'mission-haiku-pass.json', {
      schema: 'atris.mission_receipt.v1',
      result: {
        frozen: { runner: 'haiku' },
        verifier_result: { passed: true },
      },
    });
    writeReceipt(dir, 'mission-codex-fail.json', {
      schema: 'atris.mission_receipt.v1',
      result: {
        frozen: { runner: 'codex' },
        verifier_result: { status: 1 },
      },
    });

    const expected = [
      'wishes this week: 2, prior week 1',
      'reviews per shipped wish: 1.50',
      'average score trend: 4 this week, 2 prior week',
      'haiku pass rate: 1/1, all other runners 0/1',
    ];

    const stats = runCli(['wish', 'stats'], { cwd: dir });
    assert.equal(stats.status, 0, stats.stderr || stats.stdout);
    assert.equal(stats.stdout, `${expected.join('\n')}\n`);

    const written = runCli(['wish', 'stats', '--write'], { cwd: dir });
    assert.equal(written.status, 0, written.stderr || written.stdout);
    assert.equal(written.stdout, `${expected.join('\n')}\n`);
    const journal = fs.readFileSync(todayJournalPath(dir), 'utf8');
    assert.match(journal, new RegExp(`## Wish stats\\n${expected.join('\\n')}`));
  } finally {
    cleanupTempDir(dir);
  }
});
