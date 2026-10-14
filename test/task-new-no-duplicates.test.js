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

function runCli(args, { cwd, input } = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  for (const marker of AGENT_MARKERS) delete env[marker];
  delete env.ATRIS_AGENT_PROOF_ONLY;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd, input, encoding: 'utf8', timeout: 20000, env,
  });
  if (result.error) throw result.error;
  return result;
}

function addJson(dir, title, extra = []) {
  const res = runCli(['task', 'new', title, ...extra, '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout);
}

function withWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-no-dup-'));
  try {
    const init = runCli(['init'], { cwd: dir, input: '\n' });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openTitles(dir) {
  const res = runCli(['task', 'list', '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  const tasks = Array.isArray(payload) ? payload : (payload.tasks || []);
  return tasks.map((task) => task.title);
}

test('adding the same unfinished job twice reuses the first one', () => {
  withWorkspace((dir) => {
    const first = addJson(dir, 'Fix the login page');
    assert.equal(first.action, 'created');
    assert.equal(first.inserted, true);

    const second = addJson(dir, '  fix the   LOGIN page ');
    assert.equal(second.action, 'reused');
    assert.equal(second.inserted, false);
    assert.equal(second.task_id, first.task_id);

    const matches = openTitles(dir).filter((title) => /fix the login page/i.test(title));
    assert.equal(matches.length, 1, `expected one job, got ${JSON.stringify(matches)}`);
  });
});

test('plain text output says the job already exists', () => {
  withWorkspace((dir) => {
    const first = runCli(['task', 'new', 'Write the release notes'], { cwd: dir });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const ref = first.stdout.trim().split(/\s+/)[0];

    const second = runCli(['task', 'new', 'Write the release notes'], { cwd: dir });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /already/i);
    assert.ok(second.stdout.includes(ref), `expected ${ref} in: ${second.stdout}`);
  });
});

test('a different title still makes a new job', () => {
  withWorkspace((dir) => {
    const first = addJson(dir, 'Fix the login page');
    const other = addJson(dir, 'Fix the signup page');
    assert.equal(other.action, 'created');
    assert.notEqual(other.task_id, first.task_id);
  });
});

test('a finished job does not block adding it again', () => {
  withWorkspace((dir) => {
    const first = addJson(dir, 'Rotate the logs');
    const done = runCli(['task', 'done', first.task_id, '--proof', 'logs rotated, see atris/runs/rotate.json'], { cwd: dir });
    assert.equal(done.status, 0, done.stderr || done.stdout);

    const again = addJson(dir, 'Rotate the logs');
    assert.equal(again.action, 'created');
    assert.notEqual(again.task_id, first.task_id);
  });
});
