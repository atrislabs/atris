const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { spokenLineCount } = require('../lib/first-minute');
const { buildRecapData, renderRecap, renderRecapMinute, renderShare } = require('../commands/recap');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

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
    const { id } = taskDb.addTask(db, {
      title: t.title,
      workspaceRoot: ws,
      status: t.status === 'done' ? 'open' : t.status,
      claimedBy: t.claimedBy,
      metadata: t.metadata,
    });
    if (t.proof) {
      taskDb.readyTask(db, { id, actor: 'tester', proof: t.proof });
    }
    if (t.certified) {
      const row = taskDb.getTask(db, id);
      const meta = {
        ...(row.metadata || {}),
        agent_certified: true,
        agent_review_pass_count: 2,
      };
      db.prepare('UPDATE tasks SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('review', JSON.stringify(meta), Date.now(), id);
    }
    if (t.status === 'done') {
      db.prepare('UPDATE tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
        .run('done', t.doneAt || Date.now(), Date.now(), id);
    }
  }
  return { db, ws };
}

function writeProjection(dir, tasks) {
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ schema: 'atris.task_projection.v1', tasks }, null, 2),
    'utf8'
  );
}

function runCli(args, { cwd, env, timeout = 15000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
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
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }
  if (result.error) throw result.error;
  return result;
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
    assert.match(renderRecapMinute(data, { person: 'keshav' }), /hey keshav, no task history yet\./);
    assert.match(renderRecapMinute(data, { person: 'keshav' }), /^next: atris init --minimal$/m);
    assert.doesNotMatch(renderRecapMinute(data), /RECAP|Plain English|Share this/);
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
    assert.equal(data.waiting.length, 0, 'one-pass readyTask is not certified, so it is not needs-you');
    assert.equal(data.checking.length, 1, 'readyTask moves claimed->review, lands in still being checked');
    assert.equal(data.inProgress.length, 1);
    assert.equal(data.next, null);
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
      { title: 'Speed up the dashboard', status: 'claimed', claimedBy: 'agent-a', proof: 'bench: 2.1s -> 0.4s', certified: true },
    ]);
    const data = buildRecapData(dir, { days: 7 });
    const out = renderRecap(data);
    assert.match(out, /Plain English: what changed, how it was checked, and what still needs you/);
    assert.match(out, /DONE: 1/);
    assert.match(out, /Fix the login crash/);
    assert.match(out, /checked: tests passed/);
    assert.match(out, /NEEDS YOU: 1/);
    assert.match(out, /checked: measured improvement/);
    assert.match(out, new RegExp(`next: atris task accept ${data.waiting[0].id}`));
    assert.doesNotMatch(out, /task reviews/);
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
        title: 'Make self-improvement proof readable for nonengineers',
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
    assert.match(out, /Make self-improvement checks readable for nonengineers/);
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
    assert.equal(data.waiting.length, 0);
    assert.equal(data.checking.length, 1);
    assert.equal(data.checking[0].id, 'T-2');
    assert.equal(data.next, null);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('recap treats only certified review as needs you, same as first-minute', () => {
  const dir = makeTempDir();
  try {
    process.env.ATRIS_TASKS_DB = path.join(dir, 'empty.db');
    require('../lib/task-db').close();
    writeProjection(dir, [
      {
        id: 'task-1',
        display_id: 'UNW-1',
        title: 'Open follow-up',
        status: 'open',
        updated_at: 10,
      },
      {
        id: 'task-2',
        display_id: 'UNW-2',
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
      {
        id: 'task-3',
        display_id: 'UNW-3',
        title: 'Second check still open',
        status: 'review',
        updated_at: 30,
        review: { agent_review_pass_count: 1 },
      },
      {
        id: 'task-4',
        display_id: 'UNW-4',
        title: 'Newer review still waiting',
        status: 'review',
        updated_at: 40,
        review: { agent_review_pass_count: 1 },
      },
    ]);
    const data = buildRecapData(dir, { days: 7 });
    const out = renderRecap(data);
    assert.equal(data.waiting.map(t => t.id).join(','), 'UNW-2');
    assert.deepEqual(data.checking.map(t => t.id), ['UNW-4', 'UNW-3']);
    assert.equal(data.next, 'atris task accept UNW-2');
    assert.match(out, /1 needs you/);
    assert.match(out, /2 still being checked/);
    assert.match(out, /1 still working/);
    assert.match(out, /NEEDS YOU: 1/);
    assert.match(out, /UNW-2/);
    assert.match(out, /^ {2}next: atris task accept UNW-2$/m);
    assert.match(out, /STILL BEING CHECKED: 2/);
    assert.match(out, /UNW-3/);
    assert.match(out, /UNW-4/);
    assert.doesNotMatch(out, /3 needs you/);
    assert.doesNotMatch(out, /task reviews/);
    const spoken = renderRecapMinute(data, { person: 'keshav' });
    assert.match(spoken, /hey keshav, "print a human line like" is waiting for your ok\./);
    assert.match(spoken, /2 still being checked\./);
    assert.match(spoken, /^next: atris task accept UNW-2$/m);
    assert.doesNotMatch(spoken, /RECAP|Plain English|Share this|needs you|NEEDS YOU/);
    assert.equal(spokenLineCount(spoken), 3);
    const share = renderShare(data);
    assert.match(share, /1 ready for you to approve or send back/);
    assert.match(share, /2 still being checked/);
    assert.doesNotMatch(share, /3 ready for you to approve/);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('two-pass review without the certified flag still needs you', () => {
  const dir = makeTempDir();
  try {
    process.env.ATRIS_TASKS_DB = path.join(dir, 'empty.db');
    require('../lib/task-db').close();
    writeProjection(dir, [{
      id: 'task-8',
      display_id: 'UNW-8',
      title: 'Two pass no flag',
      status: 'review',
      updated_at: 10,
      review: { agent_review_pass_count: 2 },
    }]);
    const data = buildRecapData(dir, { days: 7 });
    assert.equal(data.waiting.map(t => t.id).join(','), 'UNW-8');
    assert.equal(data.checking.length, 0);
    assert.equal(data.next, 'atris task accept UNW-8');
    assert.match(renderRecap(data), /^ {2}next: atris task accept UNW-8$/m);
    assert.match(renderRecapMinute(data, { person: 'keshav' }), /^next: atris task accept UNW-8$/m);
    assert.match(renderRecapMinute(data, { person: 'keshav' }), /"two pass no flag" is waiting for your ok\./);
  } finally {
    resetDbEnv();
    cleanup(dir);
  }
});

test('renderRecapMinute leads with certified accept and keeps uncertified checking', () => {
  const text = renderRecapMinute({
    empty: false,
    waiting: [{
      id: 'UNW-2',
      title: 'Print a human line like 4 words so the count is easy to read.',
    }],
    checking: [{ id: 'UNW-3', title: 'Second check still open' }],
    shipped: [],
    inProgress: [],
    next: 'atris task accept UNW-2',
  }, { person: 'keshav' });
  assert.match(text, /hey keshav, "print a human line like" is waiting for your ok\./);
  assert.match(text, /1 still being checked\./);
  assert.match(text, /^next: atris task accept UNW-2$/m);
  assert.doesNotMatch(text, /RECAP|Plain English|Share this|needs you|NEEDS YOU/);
  assert.equal(spokenLineCount(text), 3);
});

test('renderRecapMinute names a claimed file, not factory map.md', () => {
  const text = renderRecapMinute({
    empty: false,
    waiting: [],
    checking: [],
    shipped: [],
    inProgress: [
      { id: 'T1', title: 'Generate MAP.md — scan codebase', owner: null },
      { id: 'T2', title: 'notes.md', owner: 'keshav' },
    ],
    next: null,
  }, { person: 'keshav' });
    assert.match(text, /^hey keshav, "notes.md" is already yours\.$/m);
    assert.match(text, /^next: atris task ready T2 --verify "git diff --check"$/m);
  assert.doesNotMatch(text, /generate map|ready to claim/i);
  assert.equal(spokenLineCount(text), 2);
});

test('renderRecapMinute still names a claimed non-seed task', () => {
  const text = renderRecapMinute({
    empty: false,
    waiting: [],
    checking: [],
    shipped: [],
    inProgress: [
      { id: 'T1', title: 'Generate MAP.md — scan codebase', owner: null },
      { id: 'T2', title: 'Ship the landing page', owner: 'keshav' },
    ],
    next: null,
  }, { person: 'keshav' });
    assert.match(text, /^hey keshav, "ship the landing page" is already yours\.$/m);
    assert.match(text, /^next: atris task ready T2 --verify "git diff --check"$/m);
  assert.doesNotMatch(text, /generate map|ready to claim/i);
  assert.equal(spokenLineCount(text), 2);
});

test('renderRecapMinute keeps uncertified work still being checked, not needs-you', () => {
  const text = renderRecapMinute({
    empty: false,
    waiting: [],
    checking: [{ id: 'UNW-3', title: 'Second check still open' }],
    shipped: [],
    inProgress: [],
    next: null,
  }, { person: 'keshav' });
  assert.equal(text, 'hey keshav, "second check still open" is still being checked.');
  assert.doesNotMatch(text, /waiting for your ok|needs you|atris task accept|RECAP|Share this/);
  assert.equal(spokenLineCount(text), 1);
});

test('headless recap on mixed review board names one accept and does not prompt', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-parent-'));
  const dir = path.join(parent, 'atris-use-now');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeProjection(dir, [
      {
        id: 'task-2',
        display_id: 'UNW-2',
        title: 'Print a human line like 4 words so the count is easy to read.',
        status: 'review',
        updated_at: 20,
        review: { agent_certified: true, agent_review_pass_count: 2 },
      },
      {
        id: 'task-3',
        display_id: 'UNW-3',
        title: 'Second check still open',
        status: 'review',
        updated_at: 30,
        review: { agent_review_pass_count: 1 },
      },
      {
        id: 'task-4',
        display_id: 'UNW-4',
        title: 'Newer review still waiting',
        status: 'review',
        updated_at: 40,
        review: { agent_review_pass_count: 1 },
      },
    ]);
    const env = {
      HOME: path.join(parent, 'home'),
      USER: 'keshavrao',
      ATRIS_TASKS_DB: path.join(dir, 'empty.db'),
      ATRIS_NO_INTERACTIVE: '1',
    };
    const recap = runCli(['recap'], { cwd: dir, env });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(recap.stdout, /"print a human line like" is waiting for your ok\./);
    assert.match(recap.stdout, /2 still being checked\./);
    assert.match(recap.stdout, /^next: atris task accept UNW-2$/m);
    assert.doesNotMatch(recap.stdout, /RECAP/);
    assert.doesNotMatch(recap.stdout, /Plain English/);
    assert.doesNotMatch(recap.stdout, /Share this/);
    assert.doesNotMatch(recap.stdout, /needs you/);
    assert.doesNotMatch(recap.stdout, /3 needs you/);
    assert.doesNotMatch(recap.stdout, /task reviews/);
    assert.doesNotMatch(recap.stdout, /\? $/m);
    assert.doesNotMatch(recap.stdout, /What do you want/);
    assert.ok(spokenLineCount(recap.stdout) >= 2 && spokenLineCount(recap.stdout) <= 4);
    const verbose = runCli(['recap', '--verbose'], { cwd: dir, env });
    assert.equal(verbose.status, 0, verbose.stderr || verbose.stdout);
    assert.match(verbose.stdout, /RECAP/);
    assert.match(verbose.stdout, /Plain English: what changed, how it was checked, and what still needs you/);
    assert.match(verbose.stdout, /Share this: atris recap --share/);
    assert.match(verbose.stdout, /^ {2}next: atris task accept UNW-2$/m);
    assert.doesNotMatch(verbose.stdout, /\? $/m);
    assert.doesNotMatch(verbose.stdout, /What do you want/);
    const json = runCli(['recap', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next, 'atris task accept UNW-2');
    assert.equal(payload.waiting.length, 1);
    assert.equal(payload.checking.length, 2);
  } finally {
    resetDbEnv();
    cleanup(parent);
  }
});

test('headless recap keeps uncertified work still being checked and does not prompt', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-parent-'));
  const dir = path.join(parent, 'atris-use-now');
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeProjection(dir, [{
      id: 'task-3',
      display_id: 'UNW-3',
      title: 'Second check still open',
      status: 'review',
      updated_at: 30,
      review: { agent_review_pass_count: 1 },
    }]);
    const env = {
      HOME: path.join(parent, 'home'),
      USER: 'keshavrao',
      ATRIS_TASKS_DB: path.join(dir, 'empty.db'),
      ATRIS_NO_INTERACTIVE: '1',
    };
    const recap = runCli(['recap'], { cwd: dir, env, timeout: 15000 });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(recap.stdout, /"second check still open" is still being checked\./);
    assert.doesNotMatch(recap.stdout, /waiting for your ok|needs you|atris task accept|RECAP|Share this/);
    assert.doesNotMatch(recap.stdout, /\? $/m);
    assert.doesNotMatch(recap.stdout, /What do you want/);
    assert.ok(spokenLineCount(recap.stdout) <= 4);
  } finally {
    resetDbEnv();
    cleanup(parent);
  }
});

test('headless recap after a claimed file skips factory map.md and does not prompt', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-file-'));
  const dir = path.join(parent, 'notes-room');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'already writing\n', 'utf8');
  try {
    writeProjection(dir, [
      {
        id: 'task-1',
        display_id: 'T1',
        title: 'Generate MAP.md — scan codebase',
        status: 'open',
        updated_at: 10,
      },
      {
        id: 'task-2',
        display_id: 'T2',
        title: 'notes.md',
        status: 'claimed',
        claimed_by: 'keshav',
        updated_at: 20,
      },
    ]);
    const env = {
      HOME: path.join(parent, 'home'),
      USER: 'keshav',
      ATRIS_OPERATOR: 'keshav',
      ATRIS_TASKS_DB: path.join(dir, 'empty.db'),
      ATRIS_NO_INTERACTIVE: '1',
    };
    const recap = runCli(['recap'], { cwd: dir, env });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(recap.stdout, /^hey keshav, "notes\.md" is already yours\.$/m);
    assert.match(recap.stdout, /^next: atris task ready T2 --verify "git diff --check"$/m);
    assert.doesNotMatch(recap.stdout, /generate map|ready to claim|RECAP|Share this/i);
    assert.doesNotMatch(recap.stdout, /\? $/m);
    assert.doesNotMatch(recap.stdout, /What do you want/);
    assert.equal(spokenLineCount(recap.stdout), 2);

    const json = runCli(['recap', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next_action, 'atris task ready T2 --verify "git diff --check"');
    assert.equal(payload.reason, '"notes.md" is already yours');
    assert.doesNotMatch(json.stdout, /generate map|ready to claim/i);
  } finally {
    resetDbEnv();
    cleanup(parent);
  }
});

test('headless recap still names a claimed non-seed task when factory map.md is open', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-claimed-'));
  const dir = path.join(parent, 'landing-room');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n', 'utf8');
  try {
    writeProjection(dir, [
      {
        id: 'task-1',
        display_id: 'T1',
        title: 'Generate MAP.md — scan codebase',
        status: 'open',
        updated_at: 10,
      },
      {
        id: 'task-2',
        display_id: 'T2',
        title: 'Ship the landing page',
        status: 'claimed',
        claimed_by: 'keshav',
        updated_at: 20,
      },
    ]);
    const env = {
      HOME: path.join(parent, 'home'),
      USER: 'keshav',
      ATRIS_OPERATOR: 'keshav',
      ATRIS_TASKS_DB: path.join(dir, 'empty.db'),
      ATRIS_NO_INTERACTIVE: '1',
    };
    const recap = runCli(['recap'], { cwd: dir, env });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(recap.stdout, /^hey keshav, "ship the landing page" is already yours\.$/m);
    assert.match(recap.stdout, /^next: atris task ready T2 --verify "git diff --check"$/m);
    assert.doesNotMatch(recap.stdout, /generate map|ready to claim|RECAP/i);
    assert.equal(spokenLineCount(recap.stdout), 2);
  } finally {
    resetDbEnv();
    cleanup(parent);
  }
});

test('headless recap after init-shaped claim keeps the next, not silent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-claim-'));
  const dir = path.join(parent, 'claim-room');
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n', 'utf8');
  try {
    writeProjection(dir, [
      {
        id: 'task-1',
        display_id: 'INT-1',
        title: 'Generate MAP.md — scan codebase',
        status: 'open',
        updated_at: 10,
      },
    ]);
    const env = {
      HOME: path.join(parent, 'home'),
      USER: 'keshav',
      ATRIS_OPERATOR: 'keshav',
      ATRIS_TASKS_DB: path.join(dir, 'empty.db'),
      ATRIS_NO_INTERACTIVE: '1',
    };
    const recap = runCli(['recap'], { cwd: dir, env });
    assert.equal(recap.status, 0, recap.stderr || recap.stdout);
    assert.match(recap.stdout, /generate map\.md/i);
    assert.match(recap.stdout, /ready to claim/);
    assert.match(recap.stdout, /^next: atris task claim INT-1 --as keshav$/m);
    assert.doesNotMatch(recap.stdout, /RECAP|Plain English|Share this|no task history yet|already yours/i);
    assert.equal(spokenLineCount(recap.stdout), 2);

    const json = runCli(['recap', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.next, 'atris task claim INT-1 --as keshav');
    assert.doesNotMatch(json.stdout, /RECAP|Plain English|Share this/);
  } finally {
    resetDbEnv();
    cleanup(parent);
  }
});

test('recap --help names spoken default and verbose report', () => {
  const dir = makeTempDir();
  try {
    const help = runCli(['recap', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /spoken lines/);
    assert.match(help.stdout, /--verbose/);
    assert.match(help.stdout, /old report/);
    assert.doesNotMatch(help.stdout, /Last 7 days: done, needs you/);
  } finally {
    cleanup(dir);
  }
});

// --- recap today: what your ai agent did here, before any setup ---

const { buildAgentToday, renderAgentToday, claudeProjectDir, readFirstJsonLine } = require('../lib/agent-today');

function todayFixture() {
  const home = makeTempDir();
  const project = fs.realpathSync(makeTempDir());
  const now = new Date();
  const ts = now.toISOString();
  const yesterday = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  return { home, project, now, ts, yesterday };
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function seedClaude({ home, project, ts, yesterday }, claudeConfigDir = '') {
  writeJsonl(path.join(claudeProjectDir(home, project, { CLAUDE_CONFIG_DIR: claudeConfigDir }), 's1.jsonl'), [
    { type: 'user', timestamp: yesterday, message: { content: 'old ask from two days ago' } },
    { type: 'user', timestamp: ts, message: { content: 'add a login page' } },
    { type: 'user', timestamp: ts, message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', timestamp: ts, message: { content: [
      { type: 'tool_use', name: 'Write', input: { file_path: path.join(project, 'src', 'login.js') } },
      { type: 'tool_use', name: 'Edit', input: { file_path: path.join(project, 'src', 'app.js') } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] } },
    { type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', timestamp: ts, message: { content: 'now add tests' } },
    { type: 'user', timestamp: ts, isMeta: true, message: { content: 'Stop hook feedback:\n[keep going]' } },
    { type: 'user', timestamp: ts, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued from a previous conversation.' } },
  ]);
}

function seedCodex({ home, project, now, ts }, cwd = project, meta = {}, name = path.basename(cwd), codexHome = path.join(home, '.codex')) {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const patch = `*** Begin Patch\n*** Update File: ${path.join(project, 'README.md')}\n@@\n-old\n+new\n*** End Patch`;
  writeJsonl(path.join(codexHome, 'sessions', y, m, d, `rollout-${name}.jsonl`), [
    { type: 'session_meta', timestamp: ts, payload: { cwd, ...meta } },
    { type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>` }] } },
    { type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the readme typo' }] } },
    { type: 'response_item', timestamp: ts, payload: { type: 'custom_tool_call', name: 'exec', input: `text(await tools.apply_patch(${JSON.stringify(patch)}))` } },
  ]);
}

test('recap today reads a claude code session for this folder only', () => {
  const fx = todayFixture();
  try {
    seedClaude(fx);
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.equal(t.sessions.claude, 1);
    assert.equal(t.sessions.codex, 0);
    assert.equal(t.prompts, 2, 'counts today\'s typed asks, skips old asks, wrappers, hook notes, chat summaries, and tool results');
    assert.deepEqual(t.files, ['src/app.js', 'src/login.js']);
    const out = renderAgentToday(t);
    assert.match(out, /2 things, across 1 session in claude code/);
    assert.match(out, /changed 2 files, mostly in src/);
    assert.ok(out.split('\n').length <= 5, out);
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('recap today reads codex patches and ignores codex sessions in other folders', () => {
  const fx = todayFixture();
  const other = makeTempDir();
  try {
    seedCodex(fx);
    seedCodex(fx, other);
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.equal(t.sessions.codex, 1);
    assert.equal(t.prompts, 1, 'the project notes codex injects are not an ask');
    assert.deepEqual(t.files, ['README.md']);
    assert.match(renderAgentToday(t), /1 thing, across 1 session in codex\.\nit changed 1 file in the top folder\./);
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
    cleanup(other);
  }
});

test('recap today in an empty folder says nothing happened yet, in plain words', () => {
  const fx = todayFixture();
  try {
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.equal(t.isGit, false);
    assert.equal(
      renderAgentToday(t),
      `today in ${path.basename(fx.project)}\nno ai sessions or saved changes here yet today.\nrun this again after your agent does some work.`,
    );
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('bare recap with no atris folder shows today, with commits and unsaved files', () => {
  const fx = todayFixture();
  try {
    seedClaude(fx);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    spawnSync('git', ['init', '-q'], { cwd: fx.project });
    fs.writeFileSync(path.join(fx.project, 'a.txt'), 'a');
    spawnSync('git', ['add', '.'], { cwd: fx.project });
    spawnSync('git', ['commit', '-qm', 'add the login page'], { cwd: fx.project, env: gitEnv });
    fs.writeFileSync(path.join(fx.project, 'b.txt'), 'b');
    const r = spawnSync(process.execPath, [cliPath, 'recap'], {
      cwd: fx.project,
      encoding: 'utf8',
      env: { ...process.env, HOME: fx.home, ATRIS_TASKS_DB: path.join(fx.home, 'tasks.db'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^today in /);
    assert.match(r.stdout, /1 change saved to git\. latest: "add the login page"/);
    assert.match(r.stdout, /1 file changed but not saved to git yet\./);
    assert.ok(!fs.existsSync(path.join(fx.project, 'atris')), 'recap must not set anything up');
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('recap today keeps what you typed apart from jobs agents ran on their own', () => {
  const fx = todayFixture();
  try {
    seedClaude(fx);
    writeJsonl(path.join(claudeProjectDir(fx.home, fx.project), 'tick.jsonl'), [
      { type: 'user', timestamp: fx.ts, entrypoint: 'sdk-cli', promptSource: 'sdk', message: { content: 'run one mission tick' } },
      { type: 'assistant', timestamp: fx.ts, message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: path.join(fx.project, 'lib', 'tick.js') } },
      ] } },
    ]);
    seedCodex(fx, fx.project, { originator: 'Codex Desktop', source: 'vscode' }, 'chat');
    seedCodex(fx, fx.project, { originator: 'codex_exec', source: 'exec' }, 'exec');
    seedCodex(fx, fx.project, { originator: 'codex_exec', source: { subagent: 'review' } }, 'helper');
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.deepEqual(t.sessions, { claude: 1, codex: 1 }, 'only chats a person typed in');
    assert.equal(t.prompts, 3, 'program prompts are not your asks');
    assert.equal(t.autoRuns, 2, 'one claude program run and one codex exec; the helper is part of another session');
    assert.ok(t.files.includes('lib/tick.js'), 'files from program runs still count');
    const out = renderAgentToday(t);
    assert.match(out, /you asked your ai agent for 3 things, across 1 session in claude code and 1 session in codex\.\nyour agents also ran 2 jobs on their own\./);
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('recap today stays at five lines by folding saved and unsaved into one git line', () => {
  const out = renderAgentToday({
    folder: 'shop', sessions: { claude: 2, codex: 0 }, prompts: 4, autoRuns: 3,
    files: ['src/a.js', 'src/b.js'], areas: ['src'], commits: ['add cart'], unsaved: 2, isGit: true,
  });
  assert.equal(out, [
    'today in shop',
    'you asked your ai agent for 4 things, across 2 sessions in claude code.',
    'your agents also ran 3 jobs on their own.',
    'it changed 2 files, mostly in src.',
    '1 change saved to git, 2 files not saved yet.',
  ].join('\n'));
  const onlyAuto = renderAgentToday({
    folder: 'shop', sessions: { claude: 0, codex: 0 }, prompts: 0, autoRuns: 1,
    files: [], areas: [], commits: [], unsaved: 0, isGit: true,
  });
  assert.equal(onlyAuto, 'today in shop\nyour agents ran 1 job on their own.\nit read and ran things but changed no files.');
});

test('recap today reads a whole first line even when it spans several reads', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'big.jsonl');
    const meta = { type: 'session_meta', payload: { cwd: '/x', notes: 'n'.repeat(200 * 1024) } };
    fs.writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'later' })}\n`);
    assert.deepEqual(readFirstJsonLine(file), meta);
    fs.writeFileSync(file, '{"half": ');
    assert.equal(readFirstJsonLine(file), null, 'a half-written line is not a session');
    assert.equal(readFirstJsonLine(path.join(dir, 'missing.jsonl')), null);
  } finally {
    cleanup(dir);
  }
});

test('a first recap before any setup writes nothing to your home or folder', () => {
  const fx = todayFixture();
  try {
    seedClaude(fx);
    spawnSync('git', ['init', '-q'], { cwd: fx.project });
    const before = fs.readdirSync(fx.project).sort();
    const env = { ...process.env, HOME: fx.home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    delete env.ATRIS_TASKS_DB;
    for (const args of [['recap'], ['recap', 'today'], ['recap', '--json']]) {
      const r = spawnSync(process.execPath, [cliPath, ...args], { cwd: fx.project, encoding: 'utf8', env });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /add a login page|"prompts": 2|2 things/, `${args.join(' ')} shows today: ${r.stdout}`);
    }
    assert.equal(fs.existsSync(path.join(fx.home, '.atris')), false, 'reading must not create the task db');
    assert.deepEqual(fs.readdirSync(fx.project).sort(), before, 'recap must not add files to the folder');
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('recap today looks where each tool keeps its logs when that folder was moved', () => {
  const fx = todayFixture();
  const moved = makeTempDir();
  try {
    const claudeDir = path.join(moved, 'claude-config');
    const codexDir = path.join(moved, 'codex-home');
    seedClaude({ ...fx, home: '/nowhere' }, claudeDir);
    seedCodex({ ...fx, home: '/nowhere' }, fx.project, {}, 'moved', codexDir);
    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env, now: fx.now });
    assert.deepEqual(t.sessions, { claude: 1, codex: 1 });
    const plain = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.deepEqual(plain.sessions, { claude: 0, codex: 0 }, 'nothing in the usual place');
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
    cleanup(moved);
  }
});

test('recap today finds a deep folder whose long name claude code shortened', () => {
  const fx = todayFixture();
  try {
    const deep = path.join(fx.project, 'a'.repeat(120), 'b'.repeat(120), 'mine');
    const sibling = path.join(fx.project, 'a'.repeat(120), 'b'.repeat(120), 'other');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const key = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    assert.ok(key(deep).length > 200 && key(deep).slice(0, 200) === key(sibling).slice(0, 200), 'both share the shortened prefix');
    const projects = path.join(fx.home, '.claude', 'projects');
    writeJsonl(path.join(projects, `${key(deep).slice(0, 200)}-abc123`, 's.jsonl'), [
      { type: 'user', timestamp: fx.ts, cwd: deep, message: { content: 'fix the deep thing' } },
    ]);
    writeJsonl(path.join(projects, `${key(sibling).slice(0, 200)}-zzz999`, 's.jsonl'), [
      { type: 'user', timestamp: fx.ts, cwd: sibling, message: { content: 'not this folder' } },
      { type: 'user', timestamp: fx.ts, cwd: sibling, message: { content: 'still not this one' } },
    ]);
    const t = buildAgentToday({ cwd: deep, home: fx.home, env: {}, now: fx.now });
    assert.equal(t.sessions.claude, 1);
    assert.equal(t.prompts, 1, 'the sibling that shares the prefix is not counted');
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
  }
});

test('recap today finds sessions started through a shortcut to this folder', () => {
  const fx = todayFixture();
  const links = makeTempDir();
  try {
    const shortcut = path.join(fs.realpathSync(links), 'proj-link');
    fs.symlinkSync(fx.project, shortcut);
    seedClaude({ ...fx, project: shortcut });
    seedCodex({ ...fx, project: shortcut }, shortcut, {}, 'via-link');
    const t = buildAgentToday({ cwd: fx.project, home: fx.home, env: { PWD: shortcut }, now: fx.now });
    assert.deepEqual(t.sessions, { claude: 1, codex: 1 });
    assert.deepEqual(t.files, ['README.md', 'src/app.js', 'src/login.js'], 'files recorded under the shortcut count as here');
    const noPwd = buildAgentToday({ cwd: fx.project, home: fx.home, env: {}, now: fx.now });
    assert.deepEqual(noPwd.sessions, { claude: 0, codex: 0 }, 'without the shell path there is nothing to match');
    const stranger = buildAgentToday({ cwd: fx.project, home: fx.home, env: { PWD: links }, now: fx.now });
    assert.deepEqual(stranger.sessions, { claude: 0, codex: 0 }, 'a PWD that points somewhere else is ignored');
  } finally {
    cleanup(fx.home);
    cleanup(fx.project);
    cleanup(links);
  }
});
