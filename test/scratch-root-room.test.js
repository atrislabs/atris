'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { workspaceRoot } = require('../lib/task-db');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const {
  isGenericScratchRoot,
  isUnderGenericScratchRoot,
  isUnboundScratchFolder,
} = require('../lib/scratch-root');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const CANARY_TASK = 'auto review probe canary-tmp-own-room';
const CANARY_MISSION = 'usage wall swap canary-tmp-own-room';

function scratchRoot() {
  return fs.realpathSync(os.tmpdir());
}

function runCli(args, { cwd, env, timeout = 20000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
      USER: 'keshav',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }
  if (result.error) throw result.error;
  return result;
}

function combined(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function ensureDir(dir, createdDirs) {
  if (fs.existsSync(dir)) return;
  ensureDir(path.dirname(dir), createdDirs);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    createdDirs.push(dir);
  }
}

function writeIfMissing(file, body, createdFiles, createdDirs) {
  if (fs.existsSync(file)) return false;
  ensureDir(path.dirname(file), createdDirs);
  fs.writeFileSync(file, body);
  createdFiles.push(file);
  return true;
}

// Seed /tmp as a workspace only when those files are missing. Never delete a
// workspace that was already there; restore only files this test created.
function seedScratchWorkspace(root) {
  const createdFiles = [];
  const createdDirs = [];
  writeIfMissing(
    path.join(root, 'atris', 'atris.md'),
    `# ${CANARY_MISSION}\n`,
    createdFiles,
    createdDirs,
  );
  writeIfMissing(
    path.join(root, '.atris', 'state', 'missions.jsonl'),
    `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-canary-tmp-own-room',
      objective: CANARY_MISSION,
      owner: 'tester',
      status: 'running',
      created_at: '2026-08-26T00:00:00Z',
      updated_at: '2026-08-26T00:00:00Z',
    })}\n`,
    createdFiles,
    createdDirs,
  );
  writeIfMissing(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [{
        id: 'task-canary-tmp-own-room',
        display_id: 'TMP-1',
        title: CANARY_TASK,
        status: 'open',
        updated_at: Date.now(),
      }],
    }, null, 2),
    createdFiles,
    createdDirs,
  );
  return { createdFiles, createdDirs };
}

function restoreScratchWorkspace(createdFiles, createdDirs) {
  for (const file of [...createdFiles].reverse()) {
    try { fs.rmSync(file, { force: true }); } catch { /* keep going */ }
  }
  for (const dir of [...createdDirs].reverse()) {
    try { fs.rmdirSync(dir); } catch { /* pre-existing or not empty */ }
  }
}

function isolatedEnv(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
  };
}

function leakNeedles(scratch) {
  const needles = [CANARY_TASK, CANARY_MISSION, 'canary-tmp-own-room'];
  try {
    const missions = fs.readFileSync(path.join(scratch, '.atris', 'state', 'missions.jsonl'), 'utf8');
    for (const line of missions.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row && row.objective) needles.push(String(row.objective));
    }
  } catch {
    // Parent may have no mission file.
  }
  return [...new Set(needles.filter(Boolean))];
}

test('empty child under tmp is an unbound scratch folder', () => {
  const scratch = scratchRoot();
  const child = fs.mkdtempSync(path.join(scratch, 'atris-unbound-'));
  try {
    assert.equal(isUnderGenericScratchRoot(child), true);
    assert.equal(isUnboundScratchFolder(child), true);
    assert.equal(isUnboundScratchFolder(scratch), !fs.existsSync(path.join(scratch, 'atris')));
    fs.mkdirSync(path.join(child, 'atris'), { recursive: true });
    assert.equal(isUnboundScratchFolder(child), false);
  } finally {
    fs.rmSync(child, { recursive: true, force: true });
  }
});

test('empty folder under tmp does not inherit the tmp workspace', () => {
  const scratch = scratchRoot();
  assert.equal(isGenericScratchRoot(scratch), true, 'os.tmpdir must be a generic scratch root');

  const seed = seedScratchWorkspace(scratch);
  const child = fs.mkdtempSync(path.join(scratch, 'atris-next-'));
  const envHome = fs.mkdtempSync(path.join(scratch, 'atris-next-home-'));
  const env = isolatedEnv(envHome);
  try {
    const taskDb = require('../lib/task-db');
    taskDb.close();
    const db = taskDb.open(env.ATRIS_TASKS_DB);
    taskDb.addTask(db, {
      title: CANARY_TASK,
      workspaceRoot: scratch,
      status: 'open',
    });
    taskDb.addTask(db, {
      title: 'parent tmp review canary-tmp-own-room',
      workspaceRoot: scratch,
      status: 'review',
      metadata: { agent_certified: true, agent_review_pass_count: 2 },
    });
    taskDb.close();

    assert.equal(fs.realpathSync(workspaceRoot(child)), fs.realpathSync(child));
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(child)), fs.realpathSync(child));
    assert.notEqual(fs.realpathSync(workspaceRoot(child)), scratch);

    const needles = leakNeedles(scratch);
    const parentWork = new RegExp(needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const anchor = /anchoring mission state to the workspace root/;

    const recap = runCli(['recap'], { cwd: child, env });
    const recapText = combined(recap);
    assert.doesNotMatch(recapText, parentWork);
    assert.doesNotMatch(recapText, anchor);
    assert.match(recap.stdout, /no task history yet|nothing moved|quiet window|clean start/i);

    const mission = runCli(['mission'], { cwd: child, env });
    const missionText = combined(mission);
    assert.doesNotMatch(missionText, parentWork);
    assert.doesNotMatch(missionText, anchor);
    assert.doesNotMatch(missionText, /Mission: #\d+/);

    const bare = runCli([], { cwd: child, env });
    assert.match(bare.stdout, /clean start/);
    assert.match(bare.stdout, /^next: atris init --minimal$/m);
    assert.doesNotMatch(combined(bare), parentWork);

    const task = runCli(['task'], { cwd: child, env });
    assert.match(task.stdout, /clean start/);
    assert.match(task.stdout, /^next: atris init --minimal$/m);
    assert.doesNotMatch(combined(task), parentWork);

    const review = runCli(['review'], { cwd: child, env });
    const reviewText = combined(review);
    assert.doesNotMatch(reviewText, parentWork);
    assert.match(review.stdout, /nothing is waiting|clean start|no task history/i);
  } finally {
    taskDbSafeClose();
    fs.rmSync(child, { recursive: true, force: true });
    fs.rmSync(envHome, { recursive: true, force: true });
    restoreScratchWorkspace(seed.createdFiles, seed.createdDirs);
  }
});

test('recap from src in a real project still sees that project', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-real-src-')));
  const repo = path.join(base, 'launch-day');
  const src = path.join(repo, 'src');
  fs.mkdirSync(src, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  const env = isolatedEnv(base);
  try {
    const taskDb = require('../lib/task-db');
    taskDb.close();
    const db = taskDb.open(env.ATRIS_TASKS_DB);
    taskDb.addTask(db, {
      title: 'ship the launch-day card',
      workspaceRoot: fs.realpathSync(repo),
      status: 'open',
    });
    taskDb.close();

    assert.equal(fs.realpathSync(workspaceRoot(src)), fs.realpathSync(repo));
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(src)), fs.realpathSync(repo));

    const recap = runCli(['recap'], { cwd: src, env });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(combined(recap), /ship the launch-day card/i);
  } finally {
    taskDbSafeClose();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function taskDbSafeClose() {
  try {
    require('../lib/task-db').close();
  } catch {
    // db may already be closed
  }
}
