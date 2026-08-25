'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dogfood-p0-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

test('P0-1: non-interactive brainstorm with idea captures and exits', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);
    const res = runCli(['brainstorm', 'ship a tiny kanban'], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
      input: '',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /captured I\d+: ship a tiny kanban/);
    assert.match(res.stdout, /Next: atris plan/);
    assert.doesNotMatch(res.stdout, /Describe the desired outcome/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-1: non-interactive login without force behaves like whoami when signed in', () => {
  const home = makeTempDir();
  const dir = makeTempDir();
  try {
    const credDir = path.join(home, '.atris');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
      provider: 'manual',
      saved_at: new Date().toISOString(),
    }), 'utf8');

    const res = runCli(['login'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_NONINTERACTIVE: '1',
      },
      input: '',
      timeout: 8000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Currently signed in as: dogfood@example\.com/);
    assert.match(res.stdout, /Next: atris whoami/);
    assert.doesNotMatch(res.stdout + res.stderr, /Choice \(1-3\)/);
    assert.doesNotMatch(res.stdout + res.stderr, /Choose login method/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('P0-1: non-interactive log with no args exits without REPL hang', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, timeout: 60000 }).status, 0);
    const res = runCli(['log'], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
      input: '',
      timeout: 8000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Daily log REPL needs a terminal/);
    assert.match(res.stdout, /Next:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-2: whoami/now/skill list/member list --json emit JSON', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, timeout: 60000 }).status, 0);

    const now = runCli(['now', '--json'], { cwd: dir });
    assert.equal(now.status, 0, now.stderr);
    const nowJson = JSON.parse(now.stdout);
    assert.equal(nowJson.ok, true);
    assert.ok(typeof nowJson.content === 'string');

    const skills = runCli(['skill', 'list', '--json'], { cwd: dir });
    assert.equal(skills.status, 0, skills.stderr);
    const skillJson = JSON.parse(skills.stdout);
    assert.equal(skillJson.ok, true);
    assert.ok(Array.isArray(skillJson.skills));

    const members = runCli(['member', 'list', '--json'], { cwd: dir });
    assert.equal(members.status, 0, members.stderr);
    const memberJson = JSON.parse(members.stdout);
    assert.equal(memberJson.ok, true);
    assert.ok(memberJson.count >= 1);
    assert.ok(Array.isArray(memberJson.members));

    const whoami = runCli(['whoami', '--json'], { cwd: dir });
    // not logged in in clean env: still must be JSON
    const whoamiJson = JSON.parse(whoami.stdout);
    assert.equal(whoamiJson.ok, false);
    assert.equal(whoamiJson.logged_in, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-2: version --json is a contract violation (exit 2)', () => {
  const res = runCli(['version', '--json'], { cwd: makeTempDir() });
  assert.equal(res.status, 2);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /does not support --json/);
});

test('P0-3: fresh init --yes seeds one task visible to status and task list', function () {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, env, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);

    const list = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(list.status, 0, list.stderr);
    const payload = JSON.parse(list.stdout);
    const tasks = payload.tasks || payload.projection?.tasks || [];
    assert.ok(tasks.length >= 1, `expected >=1 task, got ${tasks.length}: ${list.stdout.slice(0, 400)}`);
    assert.ok(
      tasks.some((t) => /MAP\.md/i.test(t.title)),
      `expected MAP.md task in ${tasks.map((t) => t.title).join(' | ')}`
    );

    const status = runCli(['status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusJson = JSON.parse(status.stdout);
    const backlog = statusJson.backlog || statusJson.todo?.backlog || [];
    assert.ok(
      backlog.length >= 1 || (statusJson.counts && statusJson.counts.backlog >= 1),
      `status should show queued work: ${status.stdout.slice(0, 500)}`
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-4: plan/do/ingest start with PROMPT ONLY or ACTION TAKEN', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, timeout: 60000 }).status, 0);

    const plan = runCli(['plan'], { cwd: dir });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(plan.stdout.trimStart().split(/\r?\n/)[0], 'PROMPT ONLY');

    const doit = runCli(['do'], { cwd: dir });
    assert.equal(doit.status, 0, doit.stderr);
    assert.equal(doit.stdout.trimStart().split(/\r?\n/)[0], 'PROMPT ONLY');

    const src = path.join(dir, 'note.md');
    fs.writeFileSync(src, '# note\n\nhello\n', 'utf8');
    const ingest = runCli(['ingest', src], { cwd: dir });
    assert.equal(ingest.status, 0, ingest.stderr);
    assert.equal(ingest.stdout.trimStart().split(/\r?\n/)[0], 'ACTION TAKEN');

    const lint = runCli(['wiki', 'lint'], { cwd: dir });
    assert.equal(lint.status, 0, lint.stderr);
    assert.equal(lint.stdout.trimStart().split(/\r?\n/)[0], 'PROMPT ONLY');
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-13: local verify receipt is enough proof; unfetched actions URL is rejected', function () {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, env, timeout: 60000 }).status, 0);
    const add = runCli(['task', 'add', 'Ship keyword search for operators', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const receipt = runCli(['task', 'receipt', ref, '--verify', 'true', '--no-falsify-check', '--json'], { cwd: dir, env });
    assert.equal(receipt.status, 0, receipt.stderr);
    const receiptPayload = JSON.parse(receipt.stdout);
    assert.equal(receiptPayload.passed, true);
    assert.equal(receiptPayload.exit, 0);
    assert.ok(receiptPayload.receipt_path);

    const readyOk = runCli([
      'task', 'ready', ref,
      '--verify', 'true',
      '--no-falsify-check',
      '--result', 'Operators can now find tasks by keyword instead of scrolling the full list.',
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.equal(readyOk.status, 0, readyOk.stderr || readyOk.stdout);
    const readyPayload = JSON.parse(readyOk.stdout);
    assert.match(readyPayload.task.review.proof, /\[verified\].*passed \(exit 0\)/);
    assert.match(readyPayload.task.review.proof, /Receipt: atris\/runs\//);

    const add2 = runCli(['task', 'add', 'Reject fabricated CI URL', '--json'], { cwd: dir, env });
    assert.equal(add2.status, 0, add2.stderr);
    const ref2 = JSON.parse(add2.stdout).task.display_id;
    const fakeUrl = 'https://github.com/keshav/atris-dogfood-2/actions/runs/123456';
    const readyFake = runCli([
      'task', 'ready', ref2,
      '--proof', `npm test passed ${fakeUrl}`,
      '--result', 'Operators can now find tasks by keyword instead of scrolling the full list.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(readyFake.status, 2, readyFake.stderr || readyFake.stdout);
    const fakePayload = JSON.parse(readyFake.stdout);
    assert.equal(fakePayload.reason, 'weak_proof');
    assert.match(fakePayload.detail, /local success example/i);
    assert.match(fakePayload.detail, /fetched|i-fetched|receipt/i);

    const readyMention = runCli([
      'task', 'ready', ref2,
      '--verify', 'true',
      '--no-falsify-check',
      '--result', 'Operators can find tasks by keyword after the npm test so they stop scrolling.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(readyMention.status, 0, readyMention.stderr || readyMention.stdout);
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-14: unknown verb atris context exits 2 and does not create a task', function () {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, env, timeout: 60000 }).status, 0);
    const beforeList = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(beforeList.status, 0, beforeList.stderr);
    const beforeCount = (JSON.parse(beforeList.stdout).tasks || []).length;
    const beforeTodo = fs.existsSync(path.join(dir, 'atris', 'TODO.md'))
      ? fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8')
      : '';

    const res = runCli(['context'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.match(res.stderr + res.stdout, /Unknown command.*context/i);
    assert.match(res.stderr + res.stdout, /activate|status/i);
    assert.doesNotMatch(res.stderr + res.stdout, /Treating as natural language/i);

    const afterList = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(afterList.status, 0, afterList.stderr);
    const afterCount = (JSON.parse(afterList.stdout).tasks || []).length;
    assert.equal(afterCount, beforeCount);
    const afterTodo = fs.existsSync(path.join(dir, 'atris', 'TODO.md'))
      ? fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8')
      : '';
    assert.equal(afterTodo, beforeTodo);
  } finally {
    cleanupTempDir(dir);
  }
});

test('P0-15: mission attach-task binds the live claimed task instead of spawning a Mission XP twin', function () {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'cursor-agent' };
  const objective = 'Add keyword search so operators can find tasks without scrolling';
  try {
    assert.equal(runCli(['init', '--yes'], { cwd: dir, env, timeout: 60000 }).status, 0);
    const add = runCli(['task', 'add', objective, '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const task = JSON.parse(add.stdout).task;
    const claim = runCli(['task', 'claim', task.display_id, '--as', 'cursor-agent', '--json'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr || claim.stdout);

    const start = runCli([
      'mission', 'start', objective,
      '--owner', 'mission-lead',
      '--runner', 'manual',
      '--lane', 'code',
      '--verify', 'true',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const started = JSON.parse(start.stdout);
    assert.ok(started.mission.task_ids.includes(task.id) || started.mission.current_task_id === task.id
      || (started.mission.xp_task && started.mission.xp_task.task_id === task.id),
      `expected start to bind ${task.id}: ${start.stdout.slice(0, 500)}`);

    const beforeList = JSON.parse(runCli(['task', 'list', '--json'], { cwd: dir, env }).stdout);
    const beforeCount = (beforeList.tasks || []).length;

    const attach = runCli(['mission', 'attach-task', started.mission.id, '--json'], { cwd: dir, env });
    assert.equal(attach.status, 0, attach.stderr || attach.stdout);
    const attached = JSON.parse(attach.stdout);
    assert.ok(
      attached.action === 'mission_task_spine_exists'
      || attached.action === 'mission_task_spine_bound'
      || (attached.task && attached.task.task_id === task.id),
      `unexpected attach action: ${attached.action}`,
    );
    const spineId = attached.task_spine?.task_id
      || attached.mission?.task_spine?.task_id
      || attached.task?.task_id
      || attached.mission?.current_task_id;
    assert.equal(spineId, task.id);

    const afterList = JSON.parse(runCli(['task', 'list', '--json'], { cwd: dir, env }).stdout);
    const afterTasks = afterList.tasks || [];
    assert.equal(afterTasks.length, beforeCount);
    assert.equal(afterTasks.filter((row) => /^Mission XP:/i.test(row.title)).length, 0);

    const { pickRunnableMission } = require('../commands/run-front');
    const map = new Map([[started.mission.id, { ...started.mission, status: 'ready', runner: 'claude' }]]);
    assert.equal(pickRunnableMission(dir, map).id, started.mission.id);
  } finally {
    cleanupTempDir(dir);
  }
});
