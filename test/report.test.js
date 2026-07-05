const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildWeekReportData, renderWeekReport } = require('../commands/report');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-05T12:00:00Z').getTime();

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function seedProjection(dir, tasks) {
  const stateDir = path.join(dir, '.atris', 'state');
  ensureDir(stateDir);
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({ tasks }, null, 2), 'utf8');
}

function seedJournal(dir, date, content) {
  const year = date.slice(0, 4);
  const logDir = path.join(dir, 'atris', 'logs', year);
  ensureDir(logDir);
  fs.writeFileSync(path.join(logDir, `${date}.md`), content, 'utf8');
}

function seedXp(dir, rows) {
  const stateDir = path.join(dir, '.atris', 'state');
  ensureDir(stateDir);
  fs.writeFileSync(
    path.join(stateDir, 'career_xp_receipts.jsonl'),
    `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  );
}

test('buildWeekReportData reports empty workspace and friendly render', () => {
  const dir = makeTempDir();
  try {
    const data = buildWeekReportData(dir, { now: NOW });
    assert.equal(data.empty, true);
    assert.deepEqual(data.landings, []);
    assert.deepEqual(data.completions, []);
    assert.equal(data.xp.total, 0);
    assert.match(renderWeekReport(data), /quiet week: no landings/);
  } finally {
    cleanup(dir);
  }
});

test('buildWeekReportData counts only fresh done projection landings', () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      { id: 'fresh-id', display_id: 'CLI-1', title: 'Ship weekly report', status: 'done', done_at: NOW - DAY_MS },
      { id: 'old-id', display_id: 'CLI-2', title: 'Old landing', status: 'done', done_at: NOW - 10 * DAY_MS },
      { id: 'review-id', display_id: 'CLI-3', title: 'Review item', status: 'review', done_at: NOW - DAY_MS },
    ]);
    const data = buildWeekReportData(dir, { days: 7, now: NOW });
    assert.equal(data.empty, false);
    assert.equal(data.landings.length, 1);
    assert.equal(data.landings[0].id, 'CLI-1');
    assert.equal(data.landings[0].title, 'Ship weekly report');
  } finally {
    cleanup(dir);
  }
});

test('buildWeekReportData reads Completed journal section bullets', () => {
  const dir = makeTempDir();
  try {
    seedJournal(dir, '2026-07-05', [
      '# Daily Log',
      '',
      '## Completed',
      '- **LOG-1:** Finish journal-backed report [report]',
      '- Plain completed note',
      '',
      '## Backlog',
      '- Future work',
      '',
    ].join('\n'));
    const data = buildWeekReportData(dir, { days: 7, now: NOW });
    assert.equal(data.empty, false);
    assert.equal(data.completions.length, 2);
    assert.equal(data.completions[0].id, 'LOG-1');
    assert.equal(data.completions[0].title, 'Finish journal-backed report');
    assert.equal(data.completions[0].source, 'journal 2026-07-05');
    assert.equal(data.completions[1].title, 'Plain completed note');
  } finally {
    cleanup(dir);
  }
});

test('buildWeekReportData sums only fresh Career XP receipts', () => {
  const dir = makeTempDir();
  try {
    seedXp(dir, [
      {
        receipt_id: 'task_review:fresh',
        outcome: 'accepted',
        xp: 8,
        title: 'Accepted report task',
        accepted_at: new Date(NOW - 2 * DAY_MS).toISOString(),
      },
      {
        receipt_id: 'task_review:old',
        outcome: 'accepted',
        xp: 5,
        title: 'Old accepted task',
        accepted_at: new Date(NOW - 12 * DAY_MS).toISOString(),
      },
    ]);
    const data = buildWeekReportData(dir, { days: 7, now: NOW });
    assert.equal(data.empty, false);
    assert.equal(data.xp.total, 8);
    assert.equal(data.xp.receipts.length, 1);
    assert.equal(data.xp.receipts[0].receipt_id, 'task_review:fresh');
  } finally {
    cleanup(dir);
  }
});

test('renderWeekReport includes title line and no em dash', () => {
  const data = {
    empty: false,
    days: 7,
    landings: [{ id: 'CLI-1', title: 'Ship report', source: 'task CLI-1' }],
    completions: [{ title: 'Journal win', source: 'journal 2026-07-05' }],
    xp: { total: 3, receipts: [{ title: 'Accepted work', amount: 3, source: 'receipt task_review:1' }] },
  };
  const out = renderWeekReport(data);
  assert.match(out, /^week in review: 1 landed, 1 completions, 3 xp/);
  assert.match(out, /landings: 1 tasks, known from task projection/);
  assert.equal(out.includes('—'), false);
});
