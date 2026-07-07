const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REVIEW_WORD_SCORES,
  inferBudgetTier,
  sweepWishes,
  waitingOperatorWishes,
} = require('../commands/wish');

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

function appendWishEvent(dir, event) {
  const file = path.join(dir, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function appendMissionRecord(dir, mission) {
  const file = path.join(dir, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(mission)}\n`, 'utf8');
}

function withProcessEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function todayJournalPath(dir) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(dir, 'atris', 'logs', String(now.getFullYear()), `${date}.md`);
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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

test('vague wish asks one plain question at a time', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'fix auth'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /^Got it, wish #1: fix auth\./);
    assert.match(res.stdout, /What should be different about auth when this wish comes true\?/);
    assert.doesNotMatch(res.stdout, /Who is this for\?/);
    assert.doesNotMatch(res.stdout, /^\d+\./m);
    assert.match(res.stdout.trim(), /Answer with: atris wish answer "your words"$/);
    assert.doesNotMatch(res.stdout, /wish grant/);
    assert.doesNotMatch(res.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague wish question names the wish and asks the first gap only', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make onboarding better'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /^Got it, wish #1: make onboarding better\./);
    assert.match(res.stdout, /What should be different about onboarding when this wish comes true\?/);
    assert.doesNotMatch(res.stdout, /What part of onboarding should I change first\?/);
    const questionLines = res.stdout.split(/\r?\n/).filter((line) => /\?$/.test(line));
    assert.equal(questionLines.length, 1);
    assert.match(res.stdout.trim(), /Answer with: atris wish answer "your words"$/);
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
    assert.match(res.stdout, /^Got it, wish #1: make boot screen\. I'm on it\./);
    assertNoInventedVerbEd(res.stdout, 'make', wish);
    assert.doesNotMatch(res.stdout, /roughly about/);
    assert.doesNotMatch(res.stdout, /budget/);
    assert.doesNotMatch(res.stdout, /delegated/);
    assert.doesNotMatch(res.stdout, /workspace check passes/);
    assert.doesNotMatch(res.stdout, /git diff whitespace check/);
    assert.match(res.stdout, /I will show you the result to judge\./);
    assert.doesNotMatch(res.stderr || '', /Warning:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('healthy wish delegates a task and records honest proof status', () => {
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
    assert.equal(payload.engine, 'claude');
    assert.equal(payload.budget, 'long');
    assert.deepEqual(payload.questions, []);
    assert.ok(payload.task_id);
    assert.ok(payload.mission_id);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).status, 'delegated');
    assert.equal(wishes.at(-1).task_id, payload.task_id);
    assert.equal(wishes.at(-1).mission_id, payload.mission_id);
    assert.ok(wishes.at(-1).mission_room_receipt_path);

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    const mission = missions.find((row) => row.id === payload.mission_id);
    assert.equal(mission.runner, 'claude');
    assert.equal(mission.wish_id, payload.wish_id);
    assert.equal(mission.metadata.wish_id, payload.wish_id);
    assert.equal(mission.mission_room_receipt_path, wishes.at(-1).mission_room_receipt_path);
    assert.equal(mission.verifier, '');
    assert.deepEqual(mission.task_ids, [payload.task_id]);
    assert.equal(wishes.at(-1).verify_status, 'needs-review');
    assert.equal(wishes.at(-1).verify_outcome, 'I will show you the result to judge');

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, wishes.at(-1).mission_room_receipt_path), 'utf8'));
    assert.equal(receipt.wish_id, payload.wish_id);
    assert.equal(receipt.room.wish_id, payload.wish_id);
    assert.equal(receipt.room.source.wish_id, payload.wish_id);

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.id === payload.task_id && task.metadata.delegate_via === 'local'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --engine uses an explicit ready engine for task and mission execution', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const wish = 'make the boot screen friendlier';
    const res = runCli(['wish', wish, '--engine', 'codex', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'delegated');
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.requested_engine, 'codex');
    assert.equal(payload.engine_fallback_reason, undefined);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes[0].text, wish);
    assert.equal(wishes.at(-1).engine, 'codex');
    assert.equal(wishes.at(-1).requested_engine, 'codex');
    assert.equal(wishes.at(-1).engine_fallback_reason, undefined);

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    assert.equal(missions.find((row) => row.id === payload.mission_id).runner, 'codex');

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const task = projection.tasks.find((row) => row.id === payload.task_id);
    assert.equal(task.metadata.executed_by, 'codex');
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --engine falls back when the requested engine is not ready and records the reason', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'make the boot screen friendlier', '--engine', 'devin', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.requested_engine, 'devin');
    assert.match(payload.engine_fallback_reason, /Requested engine devin is not ready \(not_installed\); fell back to codex\./);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).engine, 'codex');
    assert.equal(wishes.at(-1).requested_engine, 'devin');
    assert.match(wishes.at(-1).engine_fallback_reason, /fell back to codex/);

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    assert.equal(missions.find((row) => row.id === payload.mission_id).runner, 'codex');

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    const task = projection.tasks.find((row) => row.id === payload.task_id);
    assert.equal(task.metadata.executed_by, 'codex');
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --engine errors clearly for an unknown engine id', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make the boot screen friendlier', '--engine', 'not-real', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Unknown engine "not-real"/);
    assert.match(res.stderr, /Registered engine ids: .*codex/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'wishes.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --metric wires a metric verifier into the mission', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make the boot screen friendlier', '--metric', 'stripe.active_subs>=10', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'delegated');
    assert.ok(payload.mission_id);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).metric, 'stripe.active_subs>=10');
    assert.equal(wishes.at(-1).verify_status, 'metric');

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    const mission = missions.find((row) => row.id === payload.mission_id);
    assert.equal(
      mission.verifier,
      'cd /Users/keshavrao/arena/atrisos-backend && venv/bin/python backend/scripts/metric_verify.py stripe.active_subs --gte 10',
    );
    assert.equal(mission.stop_condition, 'verifier green (metric target hit)');
    assert.equal(mission.metadata.metric, 'stripe.active_subs>=10');
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --metric rejects malformed expressions with a clear error', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make the boot screen friendlier', '--metric', 'active subs at least ten', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Invalid --metric/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'wishes.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --no-mission records without starting a mission', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'make the boot screen friendlier', '--no-mission', '--json'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'captured');
    assert.equal(payload.mission_id, null);
    assert.equal(payload.task_id, null);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).status, 'captured_no_mission');
    assert.equal(wishes.at(-1).no_mission, true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);

    const sweep = withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
    }, () => sweepWishes(dir));
    assert.equal(sweep.dispatched, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish budget tier inference follows plain wording', () => {
  assert.equal(inferBudgetTier('quick polish the help copy'), 'quick');
  assert.equal(inferBudgetTier('small fix for the prompt'), 'quick');
  assert.equal(inferBudgetTier('quick tests with more real results'), 'long');
  assert.equal(inferBudgetTier('quick refactor the system test suite'), 'deep');
  assert.equal(inferBudgetTier('overhaul all mission screens'), 'deep');
  assert.equal(inferBudgetTier('make the boot screen friendlier'), 'long');
});

test('multi-part wish decomposes and records out-of-scope parts', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'make wish list clearer and gm mode in project obelisk'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^Got it, wish #1: make wish list\. It has 2 parts\./);
    assert.match(res.stdout, /Starting now: make wish list clearer\./);
    assert.match(res.stdout, /This part lives somewhere else, so I cannot do it from here: gm mode in project obelisk\./);
    assert.doesNotMatch(res.stdout, /Part \d:/);
    assert.doesNotMatch(res.stdout, /needs its own home/);
    assert.doesNotMatch(res.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const latest = records.at(-1);
    assert.equal(latest.status, 'decomposed');
    assert.equal(latest.delegated_parts.length, 1);
    assert.equal(latest.delegated_parts[0].text, 'make wish list clearer');
    assert.equal(latest.out_of_scope_parts.length, 1);
    assert.equal(latest.out_of_scope_parts[0].status, 'waiting');
    assert.match(latest.out_of_scope_parts[0].reason, /project obelisk is not in this checkout/);

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.title === 'make wish list clearer'));
    assert.equal(projection.tasks.some((task) => /project obelisk/.test(task.title)), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('multi-part wish asks one question about an unclear part', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'fix auth and make wish list clearer'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Starting now: make wish list clearer\./);
    assert.match(res.stdout, /One question about "fix auth": What should be different about auth when this wish comes true\?/);
    assert.doesNotMatch(res.stdout, /clearer answer before I start/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('multi-part wish asks one question per unclear part', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'fix auth and fix billing and make wish list clearer'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /One question about "fix auth":/);
    assert.match(res.stdout, /One question about "fix billing":/);
    assert.doesNotMatch(res.stdout, /parts 1-2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish derives proof text from test nouns', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const res = runCli(['wish', 'improve tests with more real results'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /You will know it came true when the fast test run passes and is timed\./);
    assert.doesNotMatch(res.stdout, /git diff whitespace check/);

    const wishes = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(wishes.at(-1).verify, 'node --test');
    assert.equal(wishes.at(-1).verify_status, 'derived');
    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    assert.equal(missions.find((row) => row.id === wishes.at(-1).mission_id).verifier, 'node --test');
  } finally {
    cleanupTempDir(dir);
  }
});

test('vague wish questions do not splice raw fragments', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'we can take this to the finish line'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const questions = res.stdout.split(/\r?\n/).filter((line) => /\?$/.test(line)).join('\n');
    assert.doesNotMatch(questions, /we can take this/);
    assert.match(res.stdout, /What should be different when this wish comes true\?/);
  } finally {
    cleanupTempDir(dir);
  }
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
    assert.match(granted.stdout, /^Got it, wish #1: make onboarding better\. I'm on it\./);
    assertNoInventedVerbEd(granted.stdout, 'make', wish);
    assert.doesNotMatch(granted.stdout, /roughly about/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish sweep dispatches an answered wish once and stamps it', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    const ts = new Date().toISOString();
    appendWishEvent(dir, {
      id: 'wish-answered-onboarding',
      ts,
      text: 'make onboarding better',
      status: 'needs_input',
      questions: ['Who is onboarding for?'],
      vague: true,
      missing_slots: ['audience'],
    });
    appendWishEvent(dir, {
      id: 'wish-answered-onboarding',
      ts: new Date(Date.parse(ts) + 1000).toISOString(),
      text: 'make onboarding better',
      status: 'needs_input',
      answer: 'make onboarding better for new users during account setup',
    });

    const first = withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: dbPath,
    }, () => sweepWishes(dir));
    assert.equal(first.dispatched, 1);
    assert.equal(first.waiting_on_operator, 0);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const delegated = records.filter((record) => record.status === 'delegated');
    assert.equal(delegated.length, 1);
    assert.ok(delegated[0].dispatched_at);
    assert.ok(delegated[0].task_id);
    assert.ok(delegated[0].mission_id);

    const second = withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: dbPath,
    }, () => sweepWishes(dir));
    assert.equal(second.dispatched, 0);
    assert.equal(readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl')).filter((record) => record.status === 'delegated').length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish sweep respects the three dispatch cap', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    for (let index = 1; index <= 5; index += 1) {
      appendWishEvent(dir, {
        id: `wish-captured-${index}`,
        ts: new Date(Date.now() + index).toISOString(),
        text: `make boot screen ${index} friendlier for users`,
        status: 'captured',
      });
    }
    const first = withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: dbPath,
    }, () => sweepWishes(dir));
    assert.equal(first.dispatched, 3);
    assert.equal(first.capped, 2);
    assert.equal(readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl')).filter((record) => record.status === 'delegated').length, 3);

    const second = withProcessEnv({
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: dbPath,
    }, () => sweepWishes(dir));
    assert.equal(second.dispatched, 2);
    assert.equal(second.capped, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish sweep skips unanswered needs_input wishes', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-waiting',
      ts: new Date().toISOString(),
      text: 'make onboarding better',
      status: 'needs_input',
      questions: ['Who is onboarding for?'],
    });
    const before = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl')).length;
    const sweep = sweepWishes(dir);
    assert.equal(sweep.dispatched, 0);
    assert.equal(sweep.waiting_on_operator, 1);
    assert.equal(readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl')).length, before);
    assert.deepEqual(waitingOperatorWishes(dir).map((wish) => wish.text), ['make onboarding better']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish sweep skips dispatch when no executor resolves', () => {
  const dir = makeTempDir();
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-no-executor',
      ts: new Date().toISOString(),
      text: 'make the boot screen friendlier for users',
      status: 'captured',
    });
    const sweep = withProcessEnv({
      PATH: `${emptyBin}:${systemPath}`,
    }, () => sweepWishes(dir));
    assert.equal(sweep.dispatched, 0);
    assert.equal(sweep.skipped_no_executor, 1);
    assert.equal(sweep.waiting_on_operator, 1);
    const waiting = waitingOperatorWishes(dir);
    assert.equal(waiting[0].need, 'needs a working builder before it can start');
    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.status === 'delegated'), false);
    assert.equal(records.at(-1).status, 'needs_input');
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
    assert.match(guarded.stdout, /^That answer sounds like a different wish, so I did not start wish #1: make onboarding better\./);
    assert.match(guarded.stdout, /1\. #1 make onboarding better - waiting on you/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.status === 'delegated'), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish review latest appends record', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-old',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make old thing clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });
    appendWishEvent(dir, {
      id: 'wish-new',
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make new thing clearer',
      status: 'complete',
      completed_at: '2026-07-06T11:00:00.000Z',
    });

    const reviewed = runCli(['wish', 'review', 'It landed cleanly.'], {
      cwd: dir,
      env: { ATRIS_AGENT_ID: 'keshav' },
    });
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);
    assert.match(reviewed.stdout, /^Review captured for "make new thing clearer"\.\n$/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.deepEqual(records.at(-1), {
      kind: 'review',
      wish_id: 'wish-new',
      ts: records.at(-1).ts,
      review_text: 'It landed cleanly.',
      review_score: null,
      reviewed_by: 'keshav',
    });

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /make new thing - done \[reviewed\]/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish say appends steer event and pings linked mission', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-old',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make old thing clearer',
      status: 'complete',
      completed_at: '2026-07-06T10:00:00.000Z',
      mission_id: 'mission-old',
    });
    appendWishEvent(dir, {
      id: 'wish-target',
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make the target clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T11:00:00.000Z',
      mission_id: 'mission-target',
    });
    appendMissionRecord(dir, {
      id: 'mission-target',
      objective: 'make the target clearer',
      status: 'running',
      owner: 'mission-lead',
      runner: 'claude',
      created_at: '2026-07-06T11:00:00.000Z',
      updated_at: '2026-07-06T11:00:00.000Z',
      wish_id: 'wish-target',
      metadata: { wish_id: 'wish-target' },
    });

    const steered = runCli(['wish', 'say', 'try a darker tone'], {
      cwd: dir,
      env: { ATRIS_AGENT_ID: 'keshav' },
    });
    assert.equal(steered.status, 0, steered.stderr || steered.stdout);
    assert.match(steered.stdout, /^Steering captured for "make the target clearer" and sent to mission-target\.\n$/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.deepEqual(records.at(-1), {
      kind: 'steer',
      wish_id: 'wish-target',
      ts: records.at(-1).ts,
      note: 'try a darker tone',
      steered_by: 'keshav',
      mission_id: 'mission-target',
    });

    const missions = readJsonl(path.join(dir, '.atris', 'state', 'missions.jsonl'));
    const saved = missions.at(-1);
    assert.equal(saved.id, 'mission-target');
    assert.equal(saved.pings.at(-1).text, 'try a darker tone');
    assert.equal(saved.pings.at(-1).from, 'keshav');
    assert.equal(saved.pings.at(-1).consumed_at, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish review by id appends record for that wish', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-target',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make the target clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });
    appendWishEvent(dir, {
      id: 'wish-other',
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make the other thing clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T11:00:00.000Z',
    });

    const reviewed = runCli(['wish', 'review', 'wish-target', 'Useful but too broad.'], { cwd: dir });
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.at(-1).kind, 'review');
    assert.equal(records.at(-1).wish_id, 'wish-target');
    assert.equal(records.at(-1).review_text, 'Useful but too broad.');
    assert.equal(records.at(-1).review_score, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish review missing wish errors clearly', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const reviewed = runCli(['wish', 'review', 'latest', 'Nothing to review yet.'], { cwd: dir });
    assert.equal(reviewed.status, 2);
    assert.match(reviewed.stderr, /No wishes to review yet\./);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'wishes.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish review score flag parsed', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-scored',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make scoring clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });

    const reviewed = runCli(['wish', 'review', 'latest', 'This missed the point.', '--score', '-1'], { cwd: dir });
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.at(-1).kind, 'review');
    assert.equal(records.at(-1).wish_id, 'wish-scored');
    assert.equal(records.at(-1).review_score, -1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish review plain words map to scores when no score flag is passed', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    assert.equal(REVIEW_WORD_SCORES.get('great'), 5);
    assert.equal(REVIEW_WORD_SCORES.get('love it'), 5);
    assert.equal(REVIEW_WORD_SCORES.get('nice'), 4);
    assert.equal(REVIEW_WORD_SCORES.get('ok'), 3);
    assert.equal(REVIEW_WORD_SCORES.get('weak'), 2);
    assert.equal(REVIEW_WORD_SCORES.get('wrong'), 1);
    appendWishEvent(dir, {
      id: 'wish-scored-word',
      n: 7,
      ts: isoHoursAgo(2),
      text: 'make word scoring clearer',
      status: 'delegated',
      dispatched_at: isoHoursAgo(2),
    });

    const scored = runCli(['wish', 'review', '7', 'great'], { cwd: dir });
    assert.equal(scored.status, 0, scored.stderr || scored.stdout);

    const unscored = runCli(['wish', 'review', '7', 'helpful but still slow'], { cwd: dir });
    assert.equal(unscored.status, 0, unscored.stderr || unscored.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.at(-2).review_score, 5);
    assert.equal(records.at(-2).review_text, 'great');
    assert.equal(records.at(-1).review_score, null);
    assert.equal(records.at(-1).review_text, 'helpful but still slow');
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish list folds older quiet wishes and --all shows them', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-old-done',
      n: 1,
      ts: isoDaysAgo(9),
      text: 'make old report calmer',
      status: 'complete',
      completed_at: isoDaysAgo(9),
    });
    appendWishEvent(dir, {
      id: 'wish-fresh-done',
      n: 2,
      ts: isoHoursAgo(2),
      text: 'make fresh report clearer',
      status: 'complete',
      completed_at: isoHoursAgo(2),
    });
    appendWishEvent(dir, {
      id: 'wish-old-working',
      n: 3,
      ts: isoDaysAgo(9),
      text: 'make old worker steady',
      status: 'delegated',
      dispatched_at: isoDaysAgo(9),
    });
    appendWishEvent(dir, {
      id: 'wish-old-waiting',
      n: 4,
      ts: isoDaysAgo(9),
      text: 'make old answer clear',
      status: 'needs_input',
      questions: ['What should be different?'],
    });

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.doesNotMatch(list.stdout, /old report calmer/);
    assert.match(list.stdout, /#2 make fresh report - done/);
    assert.match(list.stdout, /#3 make old worker - working/);
    assert.match(list.stdout, /#4 make old answer - waiting on you/);
    assert.match(list.stdout, /1 older wish is resting\. See them with atris wish list --all/);

    const all = runCli(['wish', 'list', '--all'], { cwd: dir });
    assert.equal(all.status, 0, all.stderr || all.stdout);
    assert.match(all.stdout, /#1 make old report - done, unreviewed/);
    assert.match(all.stdout, /#2 make fresh report - done/);
    assert.doesNotMatch(all.stdout, /resting/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare wish stops nudging old shipped wishes without reviews', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-fresh-review',
      n: 1,
      ts: isoHoursAgo(2),
      text: 'make fresh nudge clearer',
      status: 'complete',
      completed_at: isoHoursAgo(2),
    });
    appendWishEvent(dir, {
      id: 'wish-stale-review',
      n: 2,
      ts: isoHoursAgo(25),
      text: 'make stale nudge quieter',
      status: 'complete',
      completed_at: isoHoursAgo(25),
    });

    const nudge = runCli(['wish'], { cwd: dir });
    assert.equal(nudge.status, 2);
    assert.match(nudge.stdout, /#1 make fresh nudge: atris wish review 1 "<one sentence>"/);
    assert.doesNotMatch(nudge.stdout, /stale nudge/);

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /#2 make stale nudge - done, unreviewed/);
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
    assert.match(list.stdout, /#1 make boot screen - working/);
    assert.doesNotMatch(list.stdout, /in flight/);
    assert.doesNotMatch(list.stdout, /[0-9A-HJKMNP-TV-Z]{26}/);
    assert.doesNotMatch(list.stdout, /wish-|mission-|[A-Z0-9]{3}-\d/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish list renders stopped when its mission was stopped', () => {
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
    const payload = JSON.parse(created.stdout);
    const missionsPath = path.join(dir, '.atris', 'state', 'missions.jsonl');
    fs.appendFileSync(missionsPath, JSON.stringify({
      id: payload.mission_id,
      status: 'stopped',
      updated_at: new Date().toISOString(),
    }) + '\n', 'utf8');

    const list = runCli(['wish', 'list'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /make boot screen - stuck/);
    assert.doesNotMatch(list.stdout, /working/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish --as builder records a builder slice without delegation', () => {
  const dir = makeTempDir();
  const emptyBin = path.join(dir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  try {
    prepareWorkspace(dir);
    const res = runCli(['wish', 'improve tests with more real results', '--as', 'builder'], {
      cwd: dir,
      env: { PATH: `${emptyBin}:${systemPath}` },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^Builder wish: "improve tests with more real results"/);
    assert.match(res.stdout, /Outcome: improve tests with more real results/);
    assert.match(res.stdout, /Exit criteria: the fast test run passes and is timed\./);
    assert.match(res.stdout, /Verify: node --test/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.at(-1).status, 'builder');
    assert.equal(records.at(-1).mode, 'builder');
    assert.equal(records.at(-1).task_id, undefined);
    assert.equal(records.at(-1).mission_id, undefined);
    assert.equal(records.at(-1).builder_slice.verify, 'node --test');
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /#1 improve tests more - waiting on you/);
    assert.doesNotMatch(list.stdout, /ready for builder/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish board prints wish rows with review score', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-board-reviewed',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make board reviewed row clearer',
      status: 'delegated',
      engine: 'codex',
      verify_status: 'derived',
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-board-reviewed',
      ts: '2026-07-06T10:05:00.000Z',
      review_text: 'Good row.',
      review_score: 1,
      reviewed_by: 'keshav',
    });
    appendWishEvent(dir, {
      id: 'wish-board-builder',
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make board builder row clearer',
      status: 'builder',
      mode: 'builder',
      verify_status: 'needs-review',
    });

    const board = runCli(['wish', 'board'], { cwd: dir });
    assert.equal(board.status, 0, board.stderr || board.stdout);
    assert.match(board.stdout, /^wish\s+text\s+status\s+engine\s+verify_status\s+review/m);
    assert.match(board.stdout, /make board reviewed\s+make board reviewed row clearer\s+working\s+codex\s+derived\s+reviewed\/1/);
    assert.match(board.stdout, /make board builder\s+make board builder row clearer\s+waiting on you\s+-\s+needs-review\s+-/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare wish prints review nudges for completed or verified wishes', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-done',
      ts: isoHoursAgo(2),
      text: 'make completed thing clearer',
      status: 'complete',
      completed_at: isoHoursAgo(2),
    });
    appendWishEvent(dir, {
      id: 'wish-verified',
      ts: isoHoursAgo(2),
      text: 'make verified thing clearer',
      status: 'delegated',
      dispatched_at: isoHoursAgo(2),
      verify_status: 'verified',
    });
    appendWishEvent(dir, {
      id: 'wish-reviewed',
      ts: isoHoursAgo(2),
      text: 'make reviewed thing clearer',
      status: 'complete',
      completed_at: isoHoursAgo(2),
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-reviewed',
      ts: isoHoursAgo(1),
      review_text: 'Already reviewed.',
      review_score: 1,
    });

    const res = runCli(['wish'], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stdout, /Usage: atris wish/);
    assert.match(res.stdout, /Wishes ready for review:/);
    assert.match(res.stdout, /make completed thing: atris wish review \S+ "<one sentence>"/);
    assert.match(res.stdout, /make verified thing: atris wish review \S+ "<one sentence>"/);
    assert.doesNotMatch(res.stdout, /make reviewed thing: atris wish review/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish again records parent id and inherits engine override', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    appendWishEvent(dir, {
      id: 'wish-parent',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make parent thing clearer',
      status: 'delegated',
      engine: 'codex',
      requested_engine: 'codex',
    });

    const res = runCli(['wish', 'again', 'wish-parent', 'make follow-up clearer for operators', '--no-mission'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const followUps = records.filter((record) => record.parent_id === 'wish-parent');
    assert.equal(followUps.length, 2);
    assert.match(res.stdout, new RegExp(`Created follow-up wish ${followUps[0].id} from wish-parent\\.`));
    assert.equal(followUps[0].requested_engine, 'codex');
    assert.equal(followUps.at(-1).requested_engine, 'codex');
    assert.equal(followUps.at(-1).status, 'captured_no_mission');
    assert.equal(followUps.at(-1).no_mission, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish rewards summarizes reviews and wish review scorecards', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-rewards-parent-'));
  const dir = path.join(parent, 'cli');
  try {
    fs.mkdirSync(dir, { recursive: true });
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-one',
      ts: '2026-07-06T10:00:00.000Z',
      review_text: 'First landed.',
      review_score: 1,
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-two',
      ts: '2026-07-06T11:00:00.000Z',
      review_text: 'Second landed.',
      review_score: 3,
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-three',
      ts: '2026-07-06T12:00:00.000Z',
      review_text: 'Third has no score.',
      review_score: null,
    });
    const scorecards = path.join(parent, 'atrisos-backend', '.atris', 'state', 'scorecards.jsonl');
    fs.mkdirSync(path.dirname(scorecards), { recursive: true });
    fs.appendFileSync(scorecards, JSON.stringify({ source: 'wish_review', feedback: 'good' }) + '\n', 'utf8');
    fs.appendFileSync(scorecards, JSON.stringify({ source: 'other', feedback: { kind: 'wish_review' } }) + '\n', 'utf8');
    fs.appendFileSync(scorecards, JSON.stringify({ source: 'other', feedback: 'no match' }) + '\n', 'utf8');

    const rewards = runCli(['wish', 'rewards'], { cwd: dir });
    assert.equal(rewards.status, 0, rewards.stderr || rewards.stdout);
    assert.match(rewards.stdout, /reviews count: 3/);
    assert.match(rewards.stdout, /avg score: 2/);
    assert.match(rewards.stdout, /last 5 review lines:/);
    assert.match(rewards.stdout, /wish-three Third has no score\./);
    assert.match(rewards.stdout, /reward rows found: 2/);
  } finally {
    cleanupTempDir(parent);
  }
});

test('wish answer targets the waiting question, not the wish list number', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    // A wish already working sits at list number 1, like the night the interview collided.
    appendWishEvent(dir, {
      id: 'wish-busy',
      n: 1,
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make the boot screen friendlier',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });

    const created = runCli(['wish', 'make onboarding better'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(created.status, 1, created.stderr || created.stdout);
    assert.match(created.stdout.trim(), /Answer with: atris wish answer "your words"$/);

    const answered = runCli(['wish', 'answer', 'make onboarding better for new users during account setup'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);
    assert.match(answered.stdout, /^Got it, wish #2: make onboarding better\. I'm on it\./);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    const dispatched = records.filter((record) => record.status === 'delegated' && record.dispatched_at && record.id !== 'wish-busy');
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0].text, /make onboarding better/);
    assert.equal(records.some((record) => record.id === 'wish-busy' && record.answer), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish answer routes a decomposed waiting part instead of an older waiting wish', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    appendWishEvent(dir, {
      id: 'wish-old',
      n: 1,
      ts: isoHoursAgo(4),
      text: 'make billing copy warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });
    appendWishEvent(dir, {
      id: 'wish-parent',
      n: 2,
      ts: isoMinutesAgo(10),
      text: 'make onboarding calmer and make billing copy warmer',
      status: 'decomposed',
      parts: [
        { part: 1, text: 'make onboarding checklist clearer', status: 'waiting' },
      ],
      waiting_parts: [
        {
          part: 1,
          text: 'make onboarding checklist clearer',
          status: 'waiting',
          reason: 'What should be different about onboarding checklist when this part comes true?',
          questions: ['What should be different about onboarding checklist when this part comes true?'],
        },
      ],
      delegated_parts: [],
    });

    const answered = runCli(['wish', 'answer', 'for new users during account setup'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);
    assert.match(answered.stdout, /Got it, wish #3: make onboarding checklist/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.id === 'wish-old' && record.answer), false);
    assert.equal(records.some((record) => record.id === 'wish-old' && record.status === 'delegated'), false);
    const childRecords = records.filter((record) => record.parent_id === 'wish-parent' && record.id !== 'wish-parent');
    assert.equal(childRecords.some((record) => record.text === 'make onboarding checklist clearer' && record.answer), true);
    assert.equal(childRecords.some((record) => record.text === 'make onboarding checklist clearer' && record.status === 'delegated' && record.dispatched_at), true);
    const latestParent = records.filter((record) => record.id === 'wish-parent').at(-1);
    assert.deepEqual(latestParent.waiting_parts, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish answer refuses stale fallback without an explicit wish ref', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-older',
      n: 1,
      ts: isoHoursAgo(6),
      text: 'make billing copy warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });
    appendWishEvent(dir, {
      id: 'wish-newer',
      n: 2,
      ts: isoHoursAgo(2),
      text: 'make onboarding copy warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });

    const answered = runCli(['wish', 'answer', 'for founders during signup'], { cwd: dir });
    assert.equal(answered.status, 2);
    assert.match(answered.stderr, /The wish waiting on you is #2 make onboarding copy, asked 2 hours ago\. If you mean that one, say: atris wish answer #2 "your words"/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.answer), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish answer explicit stale ref still applies', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    appendWishEvent(dir, {
      id: 'wish-old',
      n: 1,
      ts: isoHoursAgo(3),
      text: 'make onboarding copy warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });

    const answered = runCli(['wish', 'answer', '#1', 'for founders during signup'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.id === 'wish-old' && record.answer === 'for founders during signup'), true);
    assert.equal(records.some((record) => record.id === 'wish-old' && record.status === 'delegated' && record.dispatched_at), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish answer fresh fallback still applies', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const dbPath = path.join(dir, 'tasks.db');
    appendWishEvent(dir, {
      id: 'wish-fresh',
      n: 1,
      ts: isoMinutesAgo(20),
      text: 'make onboarding copy warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });

    const answered = runCli(['wish', 'answer', 'for founders during signup'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}`, ATRIS_TASKS_DB: dbPath },
    });
    assert.equal(answered.status, 0, answered.stderr || answered.stdout);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records.some((record) => record.id === 'wish-fresh' && record.answer === 'for founders during signup'), true);
    assert.equal(records.some((record) => record.id === 'wish-fresh' && record.status === 'delegated' && record.dispatched_at), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish claim keeps the command word out of the wish text', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const fakeBin = makeFakeEngines(dir);
    const res = runCli(['wish', 'claim', 'fix auth'], {
      cwd: dir,
      env: { PATH: `${fakeBin}:${systemPath}` },
    });
    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.doesNotMatch(res.stdout, /claim/);
    assert.doesNotMatch(res.stderr || '', /Warning/);

    const records = readJsonl(path.join(dir, '.atris', 'state', 'wishes.jsonl'));
    assert.equal(records[0].text, 'fix auth');
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish list shows only the five plain status words', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendWishEvent(dir, {
      id: 'wish-fresh',
      ts: '2026-07-06T09:00:00.000Z',
      text: 'make signups grow soon',
      status: 'captured',
    });
    appendWishEvent(dir, {
      id: 'wish-going',
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make login flow smoother',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });
    appendWishEvent(dir, {
      id: 'wish-finished',
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make billing page load fast',
      status: 'complete',
    });
    appendWishEvent(dir, {
      id: 'wish-halted',
      ts: '2026-07-06T12:00:00.000Z',
      text: 'make search results smarter',
      status: 'delegated',
      dispatched_at: '2026-07-06T12:00:00.000Z',
      mission_id: 'mission-halted',
    });
    appendMissionRecord(dir, {
      id: 'mission-halted',
      status: 'stopped',
      updated_at: '2026-07-06T12:30:00.000Z',
    });
    appendWishEvent(dir, {
      id: 'wish-asking',
      ts: '2026-07-06T13:00:00.000Z',
      text: 'make emails warmer',
      status: 'needs_input',
      questions: ['Who is this for?'],
    });

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /make signups grow - new/);
    assert.match(list.stdout, /make login flow - working/);
    assert.match(list.stdout, /make billing page - done/);
    assert.match(list.stdout, /make search results - stuck/);
    assert.match(list.stdout, /make emails warmer - waiting on you/);
    assert.doesNotMatch(list.stdout, /captured|delegated|in flight|came true|waiting on another home|decomposed/);
  } finally {
    cleanupTempDir(dir);
  }
});
