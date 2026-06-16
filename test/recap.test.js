const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildRecapData, renderRecap, renderShare } = require('../commands/recap');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedDb(dir, tasks) {
  const taskDb = require('../lib/task-db');
  const dbPath = path.join(dir, 'tasks.db');
  process.env.ATRIS_TASKS_DB = dbPath;
  taskDb.close();
  const db = taskDb.open(dbPath);
  const ws = taskDb.workspaceRoot(dir);
  for (const t of tasks) {
    const { id } = taskDb.addTask(db, { title: t.title, workspaceRoot: ws, status: t.status === 'done' ? 'open' : t.status, claimedBy: t.claimedBy });
    if (t.proof) {
      taskDb.readyTask(db, { id, actor: 'tester', proof: t.proof });
    }
    if (t.status === 'done') {
      db.prepare('UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
        .run('done', t.doneAt || Date.now(), Date.now(), id);
    }
  }
  return { db, ws };
}

function resetDbEnv() {
  delete process.env.ATRIS_TASKS_DB;
  require('../lib/task-db').close();
}

test('buildRecapData reports empty workspace without crashing', () => {
  const dir = makeTempDir();
  try {
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    require('../lib/task-db').close();
    const data = buildRecapData(dir);
    assert.equal(data.empty, true);
    assert.match(renderRecap(data), /No task history yet/);
    assert.match(renderShare(data), /Nothing to share yet/);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('buildRecapData buckets shipped, waiting, and in-progress with proof counts', () => {
  const dir = makeTempDir();
  try {
    seedDb(dir, [
      { title: 'Fix the login crash', status: 'done', proof: 'node --test test/login.test.js -> pass', doneAt: Date.now() - 1000 },
      { title: 'Old shipped thing outside window', status: 'done', proof: 'tests pass', doneAt: Date.now() - 30 * 24 * 60 * 60 * 1000 },
      { title: 'Speed up the dashboard', status: 'claimed', claimedBy: 'agent-a', proof: 'bench: 2.1s -> 0.4s' },
      { title: 'Write onboarding email', status: 'open' },
    ]);
    const data = buildRecapData(dir, { days: 7 });
    assert.equal(data.empty, false);
    assert.equal(data.shipped.length, 1);
    assert.equal(data.shipped[0].title, 'Fix the login crash');
    assert.equal(data.waiting.length, 1, 'readyTask moves claimed->review, lands in waiting');
    assert.equal(data.inProgress.length, 1);
    assert.equal(data.proof_attached, 2);
    assert.equal(data.proof_total, 2);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('renderRecap speaks plain English with checks and no internal jargon', () => {
  const dir = makeTempDir();
  try {
    seedDb(dir, [
      { title: 'Fix the login crash', status: 'done', proof: 'node --test test/login.test.js -> pass', doneAt: Date.now() - 1000 },
      { title: 'Speed up the dashboard', status: 'claimed', claimedBy: 'agent-a', proof: 'bench: 2.1s -> 0.4s' },
    ]);
    const out = renderRecap(buildRecapData(dir, { days: 7 }));
    assert.match(out, /Plain English: what changed, how it was checked, and what still needs you/);
    assert.match(out, /DONE — 1/);
    assert.match(out, /Fix the login crash/);
    assert.match(out, /checked: tests passed/);
    assert.match(out, /NEEDS YOU — 1/);
    assert.match(out, /checked: measured improvement/);
    assert.match(out, /next: run atris task reviews/);
    for (const jargon of [/\bproof\b/i, /receipt/i, /sign-off/i, /\blane\b/i, /certified/i, /projection/i, /\brung\b/i, /AgentXP/i]) {
      assert.doesNotMatch(out, jargon);
    }
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('renderShare produces a paste-ready summary with highlights', () => {
  const dir = makeTempDir();
  try {
    seedDb(dir, [
      { title: 'Fix the login crash', status: 'done', proof: 'node --test test/login.test.js -> pass', doneAt: Date.now() - 1000 },
    ]);
    const out = renderShare(buildRecapData(dir, { days: 7 }));
    assert.match(out, /What got done on/);
    assert.match(out, /1 done and accepted/);
    assert.match(out, /Highlights:/);
    assert.match(out, /tests passed/);
    assert.match(out, /actual checks that ran/);
    for (const jargon of [/\bproof\b/i, /receipt/i, /sign-off/i]) {
      assert.doesNotMatch(out, jargon);
    }
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('renderRecap turns self-improvement receipts into a readable check summary', () => {
  const dir = makeTempDir();
  try {
    seedDb(dir, [
      {
        title: 'Make self-improvement recap readable for nonengineers',
        status: 'done',
        proof: [
          'Human approved XP after PR merge.',
          'Receipt atris/runs/cli-293-self-improvement-proof.json verifies this self-improvement tick.',
          'PR https://github.com/atrislabs/atris/pull/98 is MERGED.',
          'Verified before merge: node --test test/task-proof.test.js test/policy-lessons.test.js passed 9/9;',
          'node --check lib/task-proof.js && node --check lib/policy-lessons.js passed;',
          'git diff --check clean.',
        ].join(' '),
        doneAt: Date.now() - 1000,
      },
    ]);
    const out = renderRecap(buildRecapData(dir, { days: 7 }));
    assert.match(out, /Make self-improvement recap readable for nonengineers/);
    assert.match(out, /checked: merged, tests passed, code check passed, record saved, human accepted/);
    for (const jargon of [/\bproof\b/i, /\bpolicy\b/i, /AgentXP/i, /merge commit/i, /receipt/i]) {
      assert.doesNotMatch(out, jargon);
    }
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('buildRecapData falls back to projection JSON when the db is unavailable', () => {
  const dir = makeTempDir();
  try {
    process.env.ATRIS_TASKS_DB = path.join(dir, 'unwritable', 'nope', 'tasks.db');
    require('../lib/task-db').close();
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unwritable'), 'block dir creation', 'utf8');
    fs.writeFileSync(
      path.join(dir, '.atris', 'state', 'tasks.projection.json'),
      JSON.stringify({
        tasks: [
          { id: 'X1', display_id: 'T-1', title: 'Projected done task', status: 'done', done_at: Date.now() - 1000, metadata: { latest_agent_proof: 'tests pass' } },
          { id: 'X2', display_id: 'T-2', title: 'Projected review task', status: 'review', updated_at: Date.now(), metadata: {} },
        ],
      }),
      'utf8'
    );
    const data = buildRecapData(dir, { days: 7 });
    assert.equal(data.empty, false);
    assert.equal(data.shipped.length, 1);
    assert.equal(data.shipped[0].id, 'T-1');
    assert.equal(data.waiting.length, 1);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});
