const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inferBudgetTier } = require('../commands/wish');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function makeFakeEngines(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return binDir;
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

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function todayJournalPath(dir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, 'atris', 'logs', String(now.getFullYear()), `${date}.md`);
}

function assertNoInventedVerbEd(output, verb, operatorText) {
  const invented = `${verb}ed`;
  if (new RegExp(`\\b${invented}\\b`, 'i').test(operatorText)) return;
  assert.doesNotMatch(output, new RegExp(`\\b${invented}\\b`, 'i'));
}

test('wish capture writes the journal inbox and wishes jsonl', () => {
  const dir = makeTempDir();
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  try {
    prepareWorkspace(dir);
    const res = runCli(['wish', 'make the boot screen friendlier'], {
      cwd: dir,
      env: { PATH: `${emptyBin}:${systemPath}` },
    });
    assert.equal(res.status, 1);

    const journal = fs.readFileSync(todayJournalPath(dir), 'utf8');
    assert.match(journal, /make the boot screen friendlier/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records[0].text, 'make the boot screen friendlier');
    assert.equal(records[0].status, 'captured');
    assert.equal(records.at(-1).status, 'needs_input');
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague wish yields numbered questions', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'fix auth'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /^You wished: "fix auth"/);
    assert.match(res.stdout, /1\. What outcome should auth create\?/);
    assert.match(res.stdout, /2\. Who is auth for\?/);
    assert.match(res.stdout, /3\. What part of auth should I change first\?/);
    assert.match(res.stdout.trim(), /answer with atris wish grant <n> "your answer"\.$/);
    assert.doesNotMatch(res.stdout, /What action should I take/);
    assert.doesNotMatch(res.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague wish question exit restates the operator wish and asks specific gaps', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make onboarding better'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /^You wished: "make onboarding better"/);
    assert.match(res.stdout, /What outcome should onboarding create\?/);
    assert.match(res.stdout, /Who is onboarding for\?/);
    assert.match(res.stdout, /What part of onboarding should I change first\?/);
    const numbered = res.stdout.split(/\r?\n/).filter((line) => /^\d+\./.test(line));
    assert.ok(numbered.length >= 1 && numbered.length <= 3);
    assert.match(res.stdout.trim(), /answer with atris wish grant <n> "your answer"\.$/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('delegated wish restates verbatim without invented verb forms or double hedges', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const wish = 'make the boot screen friendlier';
    const res = runCli(['wish', wish], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^I heard you: "make the boot screen friendlier"/);
    assertNoInventedVerbEd(res.stdout, 'make', wish);
    assert.doesNotMatch(res.stdout, /roughly about/);
    assert.doesNotMatch(res.stdout, /workspace check passes/);
    assert.match(res.stdout, /You will know it came true when the git diff whitespace check passes\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('healthy wish delegates a task and starts a verified mission', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'make the boot screen friendlier', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['budget', 'engine', 'mission_id', 'questions', 'status', 'task_id', 'wish_id']);
    assert.equal(payload.status, 'delegated');
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.budget, 'long');
    assert.deepEqual(payload.questions, []);
    assert.ok(payload.task_id);
    assert.ok(payload.mission_id);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).status, 'delegated');
    assert.equal(wishes.at(-1).task_id, payload.task_id);
    assert.equal(wishes.at(-1).mission_id, payload.mission_id);

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    const mission = missions.find((row) => row.id === payload.mission_id);
    assert.equal(mission.runner, 'codex');
    assert.equal(mission.verifier, 'git diff --check');
    assert.deepEqual(mission.task_ids, [payload.task_id]);

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.id === payload.task_id && task.metadata.delegate_via === 'local'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish budget tier inference follows plain wording', () => {
  assert.equal(inferBudgetTier('quick polish the help copy'), 'quick');
  assert.equal(inferBudgetTier('small fix for the prompt'), 'quick');
  assert.equal(inferBudgetTier('overhaul all mission screens'), 'deep');
  assert.equal(inferBudgetTier('make the boot screen friendlier'), 'long');
});

test('json question shape is stable', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'fix auth', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['budget', 'engine', 'mission_id', 'questions', 'status', 'task_id', 'wish_id']);
    assert.equal(payload.status, 'needs_input');
    assert.equal(payload.task_id, null);
    assert.equal(payload.mission_id, null);
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.budget, 'long');
    assert.ok(Array.isArray(payload.questions));
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish grant names the wish verbatim before dispatching', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const wish = 'make onboarding better';
    const created = runCli(['wish', wish], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(created.status, 1, created.stderr || created.stdout);

    const granted = runCli(['wish', 'grant', '1', 'make onboarding better for new users during account setup'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(granted.status, 0, granted.stderr || granted.stdout);
    assert.match(granted.stdout, /^Granting wish 1: "make onboarding better"/);
    assertNoInventedVerbEd(granted.stdout, 'make', wish);
    assert.doesNotMatch(granted.stdout, /roughly about/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish grant mismatch guard stops disjoint answers and shows the list again', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const wish = 'make onboarding better';
    const created = runCli(['wish', wish], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(created.status, 1, created.stderr || created.stdout);

    const guarded = runCli(['wish', 'grant', '1', 'turn dashboard cards blue'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(guarded.status, 1, guarded.stderr || guarded.stdout);
    assert.match(guarded.stdout, /^Granting wish 1: "make onboarding better"/);
    assert.match(guarded.stdout, /This answer may be for a different wish, so I did not dispatch it\./);
    assert.match(guarded.stdout, /1\. make onboarding better - waiting on you/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.status === 'delegated'), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish list stays in plain language without ids', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const created = runCli(['wish', 'make the boot screen friendlier', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);

    const list = runCli(['wish', 'list'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /make the boot screen friendlier - in flight/);
    assert.doesNotMatch(list.stdout, /[0-9A-HJKMNP-TV-Z]{26}/);
    assert.doesNotMatch(list.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});
