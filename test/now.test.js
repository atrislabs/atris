const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  countJournalCompletedReceipts,
  countOpenTodoItems,
  countOpenWorkItems,
  countTaskReceiptsToday,
  ensureNowFile,
  formatLocalDate,
  nowAtris,
  refreshNowFile,
  renderDefaultNow,
  renderPortfolioNow,
} = require('../commands/now');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-now-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function captureLogs(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

test('ensureNowFile creates atris/now.md as the workspace front door', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n- **T1:** Ship it\n', 'utf8');

    const result = ensureNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.equal(result.created, true);
    assert.match(content, /# now/);
    assert.match(content, /What Matters Now/);
    assert.match(content, /Current Priority/);
    assert.match(content, /Receipts/);
  } finally {
    cleanup(dir);
  }
});

test('refreshNowFile regenerates now.md from current local signals', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n\n- **T1:** Ship it\n- **T2:** Validate it\n', 'utf8');
    const date = formatLocalDate(new Date());
    const journalDir = path.join(dir, 'atris', 'logs', date.slice(0, 4));
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, `${date}.md`), [
      '# Log',
      '',
      '## Notes',
      '',
      '- 9:00 am',
      '  Proof: shipped the proof-backed change.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), 'old', 'utf8');

    refreshNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.match(content, /Open TODO items: 2/);
    assert.match(content, /Completed receipts today: 1/);
    assert.doesNotMatch(content, /^old$/);
  } finally {
    cleanup(dir);
  }
});

test('countOpenTodoItems ignores rendered blocked and completed task rows', () => {
  const dir = makeTempDir();
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '- **[CLI-2]** Active task [brain]',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked task [brain]',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');

    assert.equal(countOpenTodoItems(todoPath), 1);
  } finally {
    cleanup(dir);
  }
});

test('countOpenWorkItems prefers task projection over rendered TODO fallbacks', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## Blocked',
      '',
      '- **[CLI-3]** Blocked fallback row [brain]',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'CLI-1', status: 'open' },
        { display_id: 'CLI-2', status: 'claimed' },
        { display_id: 'CLI-3', status: 'blocked' },
        { display_id: 'CLI-4', status: 'review' },
        { display_id: 'CLI-5', status: 'done' },
      ],
    }), 'utf8');

    assert.equal(countOpenTodoItems(todoPath), 0);
    assert.equal(countOpenWorkItems(dir, todoPath), 2);
    assert.match(renderDefaultNow(dir), /Open TODO items: 2/);
  } finally {
    cleanup(dir);
  }
});

test('countJournalCompletedReceipts counts proof receipts before legacy completed markers', () => {
  const dir = makeTempDir();
  try {
    const journalPath = path.join(dir, 'journal.md');
    fs.writeFileSync(journalPath, [
      '# Log',
      '',
      '## Notes',
      '',
      '- 9:00 am',
      '  Proof so far: partial verifier output.',
      '',
      '- 9:15 am',
      '  Proof: shipped with verifier output.',
      '',
      '- **C1:** Legacy completed receipt',
      '',
    ].join('\n'), 'utf8');

    assert.equal(countJournalCompletedReceipts(journalPath), 1);
  } finally {
    cleanup(dir);
  }
});

test('countJournalCompletedReceipts supports legacy completed markers', () => {
  const dir = makeTempDir();
  try {
    const journalPath = path.join(dir, 'journal.md');
    fs.writeFileSync(journalPath, '- **C1:** Done\n- **C2:** Also done\n', 'utf8');

    assert.equal(countJournalCompletedReceipts(journalPath), 2);
  } finally {
    cleanup(dir);
  }
});

test('renderDefaultNow counts today task receipts from task state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n', 'utf8');

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'task_episodes.jsonl'), [
      JSON.stringify({
        episode_id: 'ep-today',
        task_id: 'task-1',
        workspace_root: dir,
        created_at: today.toISOString(),
        proof: 'node --test test/now.test.js passed',
        action: { event_type: 'reviewed' },
      }),
      JSON.stringify({
        episode_id: 'ep-old',
        task_id: 'task-2',
        workspace_root: dir,
        created_at: yesterday.toISOString(),
        proof: 'node --test old passed',
        action: { event_type: 'reviewed' },
      }),
      JSON.stringify({
        episode_id: 'ep-no-proof',
        task_id: 'task-3',
        workspace_root: dir,
        created_at: today.toISOString(),
        action: { event_type: 'reviewed' },
      }),
      JSON.stringify({
        episode_id: 'ep-other-workspace',
        task_id: 'task-4',
        workspace_root: path.join(dir, 'other'),
        created_at: today.toISOString(),
        proof: 'node --test other passed',
        action: { event_type: 'reviewed' },
      }),
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl'), [
      JSON.stringify({
        receipt_id: 'task_review:ep-today',
        source_type: 'task_review',
        source_episode_id: 'ep-today',
        workspace_root: dir,
        accepted_at: today.toISOString(),
        proof: 'node --test duplicate accepted receipt passed',
      }),
      JSON.stringify({
        receipt_id: 'task_review:ep-accepted',
        source_type: 'task_review',
        source_episode_id: 'ep-accepted',
        workspace_root: dir,
        accepted_at: today.toISOString(),
        proof: 'node --test accepted receipt passed',
      }),
      '',
    ].join('\n'), 'utf8');

    assert.equal(countTaskReceiptsToday(dir, today), 2);
    assert.match(renderDefaultNow(dir), /Completed receipts today: 2/);
  } finally {
    cleanup(dir);
  }
});

test('renderDefaultNow refuses non-Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    assert.throws(() => renderDefaultNow(dir), /atris\/ folder not found/);
  } finally {
    cleanup(dir);
  }
});

test('now dates use local calendar day near UTC boundary', () => {
  const output = execFileSync(process.execPath, [
    '-e',
    "const { formatLocalDate } = require('./commands/now'); console.log(formatLocalDate(new Date('2026-05-10T03:30:00Z')));",
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8',
  }).trim();

  assert.equal(output, '2026-05-09');
});

test('ensureNowFile creates a portfolio now.md for a parent of Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'example-co', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'example-co', 'atris', 'MAP.md'), '# ExampleCo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'example-co', 'atris', 'TODO.md'), '# TODO\n\n- **P1:** Recruit\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'parked', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'MAP.md'), '# Parked Map\n', 'utf8');

    const result = ensureNowFile(dir);
    const content = fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8');

    assert.equal(result.created, true);
    assert.match(content, /portfolio of Atris workspaces/);
    assert.match(content, /example-co: ExampleCo Map; 1 open TODO item/);
    assert.match(content, /parked: Parked Map; 0 open TODO items/);
  } finally {
    cleanup(dir);
  }
});

test('renderPortfolioNow ignores completed rows in child TODO views', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'child', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'child', 'atris', 'MAP.md'), '# Child Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'child', 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Blocked',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '- **[CLI-1]** Completed task [brain]',
      '',
    ].join('\n'), 'utf8');

    const content = renderPortfolioNow(dir);

    assert.match(content, /child: Child Map; 0 open TODO items/);
  } finally {
    cleanup(dir);
  }
});

test('renderPortfolioNow refuses a parent with no child Atris workspaces', () => {
  const dir = makeTempDir();
  try {
    assert.throws(() => renderPortfolioNow(dir), /atris\/ folder not found/);
  } finally {
    cleanup(dir);
  }
});

test('now --all refreshes the parent portfolio and every child workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'example-co', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'example-co', 'atris', 'MAP.md'), '# ExampleCo Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'example-co', 'atris', 'TODO.md'), '# TODO\n\n- **P1:** Recruit\n', 'utf8');

    fs.mkdirSync(path.join(dir, 'parked', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'MAP.md'), '# Parked Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'parked', 'atris', 'TODO.md'), '# TODO\n', 'utf8');

    const output = captureLogs(() => nowAtris(['--all'], dir));

    assert.match(output, /Refreshed 2 child workspaces/);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'now.md'), 'utf8'), /portfolio of Atris workspaces/);
    assert.match(fs.readFileSync(path.join(dir, 'example-co', 'atris', 'now.md'), 'utf8'), /ExampleCo Map/);
    assert.match(fs.readFileSync(path.join(dir, 'parked', 'atris', 'now.md'), 'utf8'), /Parked Map/);
  } finally {
    cleanup(dir);
  }
});
