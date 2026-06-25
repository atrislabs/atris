const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PROFILE_REL_PATH,
  createStarterTask,
  hasContextProfile,
  inferDomain,
  loadContextProfile,
  renderPrompt,
  saveContextProfile,
  shouldGatherContext,
  starterTaskTitle,
  isAtrisMetaQuestion,
} = require('../lib/context-gatherer');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-context-gatherer-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('context gatherer saves a first-answer profile', () => {
  const dir = makeTempDir();
  try {
    const profile = saveContextProfile(dir, 'I need help organizing college applications');
    assert.equal(profile.inferred_domain, 'school');
    assert.equal(hasContextProfile(dir), true);
    assert.equal(loadContextProfile(dir).first_answer, 'I need help organizing college applications');
    assert.ok(fs.existsSync(path.join(dir, PROFILE_REL_PATH)));
  } finally {
    cleanupTempDir(dir);
  }
});

test('context gatherer creates an onboarding task when Atris workspace exists', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const previousDb = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n', 'utf8');
    const task = createStarterTask(dir, 'build a simple personal website');
    assert.equal(task.inserted, true);
    assert.equal(task.title, starterTaskTitle('build a simple personal website'));
    assert.match(task.display_id, /^[A-Z0-9]{3}-1$/);
    const db = taskDb.open();
    const rows = taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot(dir) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tag, 'onboarding');
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8'), /First useful step: build a simple personal website/);
  } finally {
    taskDb.close();
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    cleanupTempDir(dir);
  }
});

test('isAtrisMetaQuestion distinguishes questions about Atris from task requests', () => {
  // Questions about the product itself → show the overview.
  assert.equal(isAtrisMetaQuestion('what is atris'), true);
  assert.equal(isAtrisMetaQuestion('what is atris?'), true);
  assert.equal(isAtrisMetaQuestion('what can you do'), true);
  assert.equal(isAtrisMetaQuestion('who are you'), true);
  assert.equal(isAtrisMetaQuestion('how does this work'), true);
  assert.equal(isAtrisMetaQuestion('explain atris'), true);

  // Real work, even when phrased as a question, is never a meta-question.
  assert.equal(isAtrisMetaQuestion('build a website'), false);
  assert.equal(isAtrisMetaQuestion('what is my status'), false);
  assert.equal(isAtrisMetaQuestion('fix the login bug'), false);
  assert.equal(isAtrisMetaQuestion('update atris docs'), false);
  assert.equal(isAtrisMetaQuestion(''), false);
  assert.equal(isAtrisMetaQuestion(null), false);
});

test('context gatherer only interrupts when first-contact context is missing', () => {
  const dir = makeTempDir();
  try {
    assert.equal(shouldGatherContext({ root: dir, mapStatus: 'placeholder', backlogCount: 1 }), true);
    saveContextProfile(dir, 'learn coding with a tiny project');
    assert.equal(shouldGatherContext({ root: dir, mapStatus: 'placeholder', backlogCount: 1 }), false);
    assert.equal(inferDomain('please help me plan my week'), 'planning');
    assert.match(renderPrompt({ projectName: 'demo' }), /What are you trying to make easier/);
  } finally {
    cleanupTempDir(dir);
  }
});
