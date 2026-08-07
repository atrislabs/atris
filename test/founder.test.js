'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-founder-test-'));
  const scanRoot = path.join(fixtureRoot, 'arena');
  fs.mkdirSync(scanRoot, { recursive: true });
  return { fixtureRoot, scanRoot };
}

function initRepo(scanRoot, name) {
  const cwd = path.join(scanRoot, name);
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'founder@test.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'founder test'], { cwd });
  return cwd;
}

function commitAt(cwd, date, message) {
  execFileSync('git', ['commit', '--allow-empty', '-q', '--date', date, '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function runFounder(cwd, args, now) {
  const run = spawnSync(process.execPath, [cliPath, 'founder', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_FOUNDER_NOW: now,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CI: 'true',
    },
  });
  if (run.error) throw run.error;
  return run;
}

function writeTaskProjection(scanRoot, tasks) {
  const file = path.join(scanRoot, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf8');
}

function readRows(cwd) {
  const file = path.join(cwd, '.atris', 'state', 'founder', 'scorecard.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('counts default-branch commits and closed tasks by iso week, then writes a receipt', () => {
  const { fixtureRoot, scanRoot } = makeFixture();
  try {
    const alpha = initRepo(scanRoot, 'alpha');
    const beta = initRepo(scanRoot, 'beta');
    commitAt(alpha, '2026-07-28T12:00:00Z', 'alpha last week');
    commitAt(alpha, '2026-08-03T12:00:00Z', 'alpha this week one');
    commitAt(alpha, '2026-08-06T12:00:00Z', 'alpha this week two');
    commitAt(beta, '2026-06-01T12:00:00Z', 'outside the window');
    commitAt(beta, '2026-07-31T12:00:00Z', 'beta last week');
    commitAt(beta, '2026-08-05T12:00:00Z', 'beta this week');

    const ignored = initRepo(path.join(scanRoot, '.agent-worktrees'), 'ignored');
    commitAt(ignored, '2026-08-04T12:00:00Z', 'must stay ignored');
    fs.mkdirSync(path.join(scanRoot, 'notes'), { recursive: true });

    writeTaskProjection(scanRoot, [
      { id: 'current-done', status: 'done', done_at: '2026-08-04T08:00:00Z' },
      { id: 'current-closed', status: 'closed', closed_at: '2026-08-07T08:00:00Z' },
      { id: 'last-done', status: 'done', done_at: '2026-07-30T08:00:00Z' },
      { id: 'open', status: 'open', updated_at: '2026-08-06T08:00:00Z' },
    ]);

    const run = runFounder(alpha, ['--root', scanRoot, '--days', '21'], '2026-08-07T20:00:00Z');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trimEnd(), [
      'this week: 3 commits landed across 2 projects. last week: 2. slope: +50%.',
      'alpha: 2 this week, 1 last week.',
      'beta: 1 this week, 1 last week.',
      'tasks closed: 2 this week, 1 last week.',
    ].join('\n'));

    const rows = readRows(alpha);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      ts: '2026-08-07T20:00:00.000Z',
      days: 21,
      commitsThisWeek: 3,
      commitsLastWeek: 2,
      slopePct: 50,
      tasksThisWeek: 2,
      tasksLastWeek: 1,
      perRepo: [
        {
          repo: 'alpha',
          commitsThisWeek: 2,
          commitsLastWeek: 1,
          perDay: {
            '2026-07-28': 1,
            '2026-08-03': 1,
            '2026-08-06': 1,
          },
        },
        {
          repo: 'beta',
          commitsThisWeek: 1,
          commitsLastWeek: 1,
          perDay: {
            '2026-07-31': 1,
            '2026-08-05': 1,
          },
        },
      ],
    });
    assert.ok(rows[0].slopePct > 0);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('score alias uses 28 days and reports missing task data without failing', () => {
  const { fixtureRoot, scanRoot } = makeFixture();
  try {
    const alpha = initRepo(scanRoot, 'alpha');
    commitAt(alpha, '2026-08-06T12:00:00Z', 'one current commit');

    const run = runFounder(alpha, ['score'], '2026-08-07');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^this week: 1 commit landed across 1 project\./);
    assert.match(run.stdout, /\nno task data\.\n$/);

    const [row] = readRows(alpha);
    assert.equal(row.days, 28);
    assert.equal(row.tasksThisWeek, null);
    assert.equal(row.tasksLastWeek, null);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('malformed task data is treated as unavailable', () => {
  const { fixtureRoot, scanRoot } = makeFixture();
  try {
    const alpha = initRepo(scanRoot, 'alpha');
    commitAt(alpha, '2026-08-06T12:00:00Z', 'one current commit');
    const projection = path.join(scanRoot, '.atris', 'state', 'tasks.projection.json');
    fs.mkdirSync(path.dirname(projection), { recursive: true });
    fs.writeFileSync(projection, '{not json\n', 'utf8');

    const run = runFounder(alpha, ['--root', scanRoot], '2026-08-07');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\nno task data\.\n$/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
