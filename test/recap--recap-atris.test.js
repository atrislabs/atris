const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recapAtris } = require('../commands/recap');

// done_at far in the future is always inside the recap window, done_at 1 is
// always outside it, so neither depends on what time the clock says.
const ALWAYS_RECENT = 8.64e15;
const ALWAYS_OLD = 1;

// Runs recapAtris from a throwaway workspace named "ws" with a fake home, no
// ATRIS_* env vars, and a task db path that does not exist, so tasks can only
// come from the projection file written here. Returns the printed text.
function recap(args, { tasks, rawProjection } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recap-atris-test-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const dbPath = path.join(dir, 'none', 'tasks.db');

  if (tasks !== undefined || rawProjection !== undefined) {
    const stateDir = path.join(ws, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'tasks.projection.json'),
      rawProjection !== undefined ? rawProjection : JSON.stringify({ tasks }),
      'utf8'
    );
  }

  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const printed = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.ATRIS_TASKS_DB = dbPath;
    process.chdir(ws);
    console.log = (...parts) => { printed.push(parts.join(' ')); };
    const returned = recapAtris(args);
    assert.strictEqual(returned, undefined, 'recapAtris prints and returns nothing here');
    assert.ok(!fs.existsSync(dbPath), 'reading a recap never creates the task db');
    return printed.join('\n');
  } finally {
    console.log = savedLog;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mixedBoard() {
  return [
    {
      id: 'T-SHIP',
      title: 'Fix the login crash',
      status: 'done',
      done_at: ALWAYS_RECENT,
      metadata: { latest_agent_proof: 'node --test test/login.test.js -> pass' },
    },
    { id: 'T-OLD', title: 'Ancient receipts policy', status: 'done', done_at: ALWAYS_OLD, metadata: {} },
    {
      id: 'T-CERT',
      title: 'Speed up the dashboard',
      status: 'review',
      updated_at: 5,
      metadata: { agent_certified: true, latest_agent_proof: 'bench: 2.1s -> 0.4s' },
    },
    { id: 'T-CHK', title: 'Write the onboarding email', status: 'review', updated_at: 4, metadata: {} },
    { id: 'T-WIP', title: 'Port the billing page', status: 'claimed', claimed_by: 'agent-a', metadata: {} },
    { id: 'T-NEW', title: 'Draft the changelog', status: 'open', metadata: { assigned_to: 'sam' } },
  ];
}

test('recapAtris prints help for --help, -h, and a leading help word', () => {
  for (const args of [['--help'], ['-h'], ['help'], ['recap', '--help']]) {
    const out = recap(args);
    assert.match(out, /atris recap - what got done, in spoken lines/, args.join(' '));
    assert.match(out, /atris recap --days 30\s+widen the window/);
    assert.match(out, /atris recap --share\s+paste-ready summary/);
    assert.match(out, /atris recap --json\s+structured output/);
  }
});

test('recapAtris --verbose reports every bucket of a mixed board', () => {
  const out = recap(['--verbose'], { tasks: mixedBoard() });
  const lines = out.split('\n');

  assert.strictEqual(lines[0], 'RECAP: ws, last 7 days');
  assert.ok(lines.includes('1 done · 1 needs you · 1 still being checked · 2 still working'));

  assert.ok(lines.includes('DONE: 1'));
  assert.ok(lines.includes('  T-SHIP  Fix the login crash'));
  assert.ok(lines.includes('          checked: tests passed'));
  assert.ok(!out.includes('T-OLD'), 'a task finished outside the window is left out');

  assert.ok(lines.includes('NEEDS YOU: 1'));
  assert.ok(lines.includes('  T-CERT  Speed up the dashboard'));
  assert.ok(lines.includes('          checked: measured improvement'));
  assert.ok(lines.includes('  next: atris task accept T-CERT'));

  assert.ok(lines.includes('STILL BEING CHECKED: 1'));
  assert.ok(lines.includes('  T-CHK  Write the onboarding email'));

  assert.ok(lines.includes('STILL WORKING: 2'));
  assert.ok(lines.includes('  T-WIP  Port the billing page  @agent-a'));
  assert.ok(lines.includes('  T-NEW  Draft the changelog  @sam'));

  assert.ok(lines.includes('Checked: 2/3 finished items.'));
  assert.strictEqual(lines[lines.length - 1], 'Share this: atris recap --share');
});

test('recapAtris treats --full the same as --verbose', () => {
  const tasks = mixedBoard();
  assert.strictEqual(recap(['--full'], { tasks }), recap(['--verbose'], { tasks }));
});

test('recapAtris --json --verbose prints the structured recap', () => {
  const out = recap(['--json', '--verbose'], { tasks: mixedBoard() });
  const data = JSON.parse(out);

  assert.strictEqual(data.empty, false);
  assert.strictEqual(data.days, 7);
  assert.strictEqual(data.workspace, 'ws');
  assert.deepStrictEqual(data.shipped.map((t) => t.id), ['T-SHIP']);
  assert.strictEqual(data.shipped[0].proof, 'node --test test/login.test.js -> pass');
  assert.deepStrictEqual(data.waiting.map((t) => t.id), ['T-CERT']);
  assert.deepStrictEqual(data.checking.map((t) => t.id), ['T-CHK']);
  assert.deepStrictEqual(data.inProgress.map((t) => [t.id, t.owner]), [['T-WIP', 'agent-a'], ['T-NEW', 'sam']]);
  assert.strictEqual(data.next, 'atris task accept T-CERT');
  assert.strictEqual(data.proof_attached, 2);
  assert.strictEqual(data.proof_total, 3);
});

test('recapAtris --share prints a paste-ready summary with highlights', () => {
  const out = recap(['--share'], { tasks: mixedBoard() });
  const lines = out.split('\n');

  assert.strictEqual(lines[0], 'What got done on ws in the last 7 days:');
  assert.ok(lines.includes('- 1 done and accepted'));
  assert.ok(lines.includes('- 1 ready for you to approve or send back'));
  assert.ok(lines.includes('- 1 still being checked'));
  assert.ok(lines.includes('- 2 still being worked on'));
  assert.ok(lines.includes('Highlights:'));
  assert.ok(lines.includes('- Fix the login crash (tests passed)'));
  assert.ok(lines.includes('- Speed up the dashboard (measured improvement)'));
  assert.ok(!out.includes('Write the onboarding email'), 'items with no checks are not highlighted');
});

test('recapAtris reports an empty workspace in every format', () => {
  const verbose = recap(['--verbose']);
  assert.match(verbose, /^RECAP: ws\n\nNo task history yet\.\n/);
  assert.match(verbose, /Run "atris init"/);

  assert.strictEqual(
    recap(['--share']),
    'Nothing to share yet on ws, no finished tasks on record.'
  );

  assert.deepStrictEqual(JSON.parse(recap(['--json', '--verbose'])), {
    empty: true,
    days: 7,
    workspace: 'ws',
  });
});

test('recapAtris treats a broken or empty projection file as no history', () => {
  for (const rawProjection of ['{ not json', JSON.stringify({ tasks: 'nope' }), JSON.stringify({ tasks: [] })]) {
    const out = recap(['--verbose'], { rawProjection });
    assert.match(out, /No task history yet\./, rawProjection);
  }
});

test('recapAtris --days sets the window label and ignores bad values', () => {
  const tasks = mixedBoard();
  assert.match(recap(['--verbose', '--days', '1'], { tasks }), /^RECAP: ws, last 1 day$/m);
  assert.match(recap(['--verbose', '--days', '30'], { tasks }), /^RECAP: ws, last 30 days$/m);

  for (const bad of [['--days', 'abc'], ['--days', '0'], ['--days', '-3'], ['--days']]) {
    const out = recap(['--verbose', ...bad], { tasks });
    assert.match(out, /^RECAP: ws, last 7 days$/m, bad.join(' '));
  }
});

test('recapAtris --days wide enough pulls in old finished work and rewrites jargon in titles', () => {
  const tasks = mixedBoard();
  const narrow = recap(['--verbose'], { tasks });
  assert.ok(!narrow.includes('T-OLD'));

  const wide = recap(['--verbose', '--days', '1000000000'], { tasks });
  assert.match(wide, /^2 done · 1 needs you/m);
  assert.ok(wide.includes('DONE: 2'));
  assert.ok(wide.includes('  T-OLD  Ancient records rules'), 'receipts and policy become records and rules');
  assert.ok(!wide.includes('receipts policy'));
  assert.ok(wide.includes('Checked: 2/4 finished items.'));
});

test('recapAtris lists the first 12 finished items and counts the rest', () => {
  const tasks = [];
  for (let i = 0; i < 14; i++) {
    tasks.push({
      id: `T-${String(i).padStart(2, '0')}`,
      title: `Job ${i}`,
      status: 'done',
      done_at: ALWAYS_RECENT - i,
      metadata: {},
    });
  }
  const out = recap(['--verbose'], { tasks });
  const lines = out.split('\n');

  assert.ok(lines.includes('DONE: 14'));
  assert.ok(lines.includes('  T-00  Job 0'), 'newest finish comes first');
  assert.ok(lines.includes('  T-11  Job 11'));
  assert.ok(!lines.includes('  T-12  Job 12'));
  assert.ok(lines.includes('  … and 2 more'));
  assert.ok(lines.includes('Checked: 0/14 finished items.'));
});

test('recapAtris shows a quiet-window headline when only unrelated tasks exist', () => {
  const tasks = [{ id: 'T-OLD', title: 'Long ago', status: 'done', done_at: ALWAYS_OLD, metadata: {} }];
  const out = recap(['--verbose'], { tasks });
  assert.match(out, /^Quiet window\. nothing moved in this period\.$/m);
  assert.match(out, /^Checked: 0\/0 finished items\.$/m);
});
