const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inferBudgetTier, sweepWishes, waitingOperatorWishes } = require('../commands/wish');

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
    assert.doesNotMatch(res.stdout, /git diff whitespace check/);
    assert.match(res.stdout, /I will show you the result to judge\./);
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
    assert.match(res.stdout, /This wish has 2 parts\./);
    assert.match(res.stdout, /Part 1: make wish list clearer/);
    assert.match(res.stdout, /Part 2: gm mode in project obelisk/);
    assert.match(res.stdout, /I can start part 1 now; part 2 needs its own home\./);
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

test('multi-part wish uses singular agreement for one waiting part', () => {
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
    assert.match(res.stdout, /part 1 needs one clearer answer before I start\./);
    assert.doesNotMatch(res.stdout, /part 1 need one clearer answer/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('multi-part wish uses plural agreement for waiting parts', () => {
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
    assert.match(res.stdout, /parts 1-2 need one clearer answer before I start\./);
    assert.doesNotMatch(res.stdout, /parts 1-2 needs one clearer answer/);
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
    const questions = res.stdout.split(/\r?\n/).filter((line) => /^\d+\./.test(line)).join('\n');
    assert.doesNotMatch(questions, /we can take this/);
    assert.match(res.stdout, /What would done look like for this wish\?/);
    assert.match(res.stdout, /What should exist when it comes true\?/);
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
    assert.match(granted.stdout, /^Granting wish 1: "make onboarding better"/);
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
    assert.match(list.stdout, /make the boot screen friendlier - stopped/);
    assert.doesNotMatch(list.stdout, /make the boot screen friendlier - in flight/);
  } finally {
    cleanupTempDir(dir);
  }
});
