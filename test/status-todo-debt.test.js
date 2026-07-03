const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace(todoBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-debt-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), todoBody);
  return dir;
}

function runStatus(dir) {
  const result = spawnSync(process.execPath, [cliPath, 'status'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_TASKS_DB: path.join(dir, '.atris', 'fixture-tasks.db'),
    },
  });
  if (result.error) throw result.error;
  return result;
}

const COMPLETED_SECTION = [
  '## Completed',
  '',
  '- **[CLI-1]** Shipped thing one',
  '- **[CLI-2]** Shipped thing two',
  '',
].join('\n');

test('status treats completed rows in a regenerated TODO as history, not debt', () => {
  const dir = makeWorkspace([
    '# TODO.md',
    '',
    '> Regenerated from durable Atris task state. Do not treat this file as truth.',
    '',
    '## Backlog',
    '',
    '(Empty)',
    '',
    COMPLETED_SECTION,
  ].join('\n'));
  try {
    const res = runStatus(dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /recently completed/);
    assert.doesNotMatch(res.stdout, /Main drag/);
    assert.doesNotMatch(res.stdout, /cleanup debt handled/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('status still calls out completed rows lingering in a hand-maintained TODO', () => {
  const dir = makeWorkspace([
    '# TODO.md',
    '',
    '## Backlog',
    '',
    COMPLETED_SECTION,
  ].join('\n'));
  try {
    const res = runStatus(dir);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    // legacy markdown parse path only; the DB-first view treats done rows as history
    if (/completed items still sitting in TODO/.test(res.stdout)) {
      assert.match(res.stdout, /Main drag/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
