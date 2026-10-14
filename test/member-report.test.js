'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { formatReport, memberReport, parseSince } = require('../lib/member-report');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const NOW = new Date(2026, 9, 14, 12, 0);

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayName(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

function entry(time, title, fields) {
  return [`## ${time} · ${title}`, ...Object.entries(fields).map(([key, value]) => `- ${key}: ${value}`), ''].join('\n');
}

function workspace(t, diaries, day = NOW) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-report-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [member, text] of Object.entries(diaries)) {
    const logs = path.join(root, 'atris', 'team', member, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', member, 'MEMBER.md'), `# ${member}\n`);
    if (text) fs.writeFileSync(path.join(logs, dayName(day)), text);
  }
  return root;
}

const BUILDER_DAY = [
  entry('07:00', 'Task claimed', { task: 'CLI-1', title: 'Stop works for codex', actor: 'builder' }),
  entry('07:01', 'Mission started', { member: 'builder', mission: 'Stop works for codex' }),
  entry('08:00', 'Mission run tick 1', {
    member: 'builder', mission: 'Make the board faster', state: 'blocked', verifier: 'failed', summary: 'half done',
  }),
  entry('09:00', 'Mission run tick 1', {
    member: 'builder', mission: 'Make the board faster, a long job description', state: 'complete', verifier: 'passed',
    summary: 'The board now opens in half the time. I timed it ten times.',
  }),
  entry('09:30', 'Mission run tick 1', {
    member: 'builder', mission: 'Stop works for codex', state: 'complete', verifier: 'passed', summary: 'Stop works.',
  }),
  entry('10:00', 'Task completed', {
    task: 'CLI-1', title: 'Stop works for codex', status: 'done', action: 'merged',
    proof: 'its change merged on GitHub: https://github.com/acme/repo/pull/42',
  }),
  entry('10:30', 'Task archived', {
    task: 'CLI-2', title: 'Report shows the team', status: 'archived', action: 'archived', proof: 'printed a raw log, not a summary',
  }),
  entry('11:00', 'Task note', { task: 'CLI-3', title: 'Something', note: 'just a note' }),
].join('');

test('each member gets merged with links, finished in plain words, and turned down with the reason', (t) => {
  const root = workspace(t, { builder: BUILDER_DAY, quiet: '' });
  const report = memberReport(root, { since: 'today', now: NOW });

  assert.deepEqual(report.members.map((row) => row.member), ['builder']);
  const builder = report.members[0];
  assert.deepEqual(builder.merged, [
    { title: 'Stop works for codex', link: 'https://github.com/acme/repo/pull/42', took_minutes: 180, tries: 1 },
  ]);
  // The tick that failed its check and the bookkeeping lines are left out; the
  // tick for the merged job is folded into the merge line.
  assert.deepEqual(builder.finished.map((item) => item.title), ['Make the board faster, a long job description']);
  assert.deepEqual(builder.turned_down, [{ title: 'Report shows the team', reason: 'printed a raw log, not a summary' }]);
  assert.deepEqual(report.totals, { merged: 1, finished: 1, turned_down: 1, waiting: 0 });

  const text = formatReport(report);
  assert.match(text, /what the team did since 00:00/);
  assert.match(text, /1 merged, 1 finished, 1 turned down, 0 not merged yet/);
  assert.match(text, /merged\s+Stop works for codex\s+https:\/\/github\.com\/acme\/repo\/pull\/42/);
  assert.match(text, /finished\s+The board now opens in half the time\.\n/);
  assert.match(text, /turned down\s+Report shows the team: printed a raw log, not a summary/);
  assert.doesNotMatch(text, /Task claimed|Mission started|Task note|half done|quiet/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T|Z\b/, 'no utc timestamps in the summary');
});

test('tasks a person sent back and tasks waiting on a person come from the task list', (t) => {
  const root = workspace(t, { builder: '', validator: '' });
  const sentBack = new Date(2026, 9, 14, 9, 0).toISOString();
  const longAgo = new Date(2026, 9, 10, 9, 0).toISOString();
  const tasks = [
    { title: 'Board shows last result', status: 'review', updated_at: NOW.getTime() - 60e3, claimed_by: 'builder', metadata: { approval_status: 'pending' } },
    { title: 'Report v1', status: 'review', updated_at: NOW.getTime(), claimed_by: 'builder', metadata: { approval_status: 'revise', human_revision_at: sentBack, human_revision_note: 'too long' } },
    { title: 'Old send-back', status: 'review', updated_at: NOW.getTime(), claimed_by: 'validator', metadata: { approval_status: 'revise', human_revision_at: longAgo, human_revision_note: 'old' } },
    { title: 'Someone else', status: 'review', updated_at: NOW.getTime(), claimed_by: 'keshav', metadata: {} },
    { title: 'Already done', status: 'done', updated_at: NOW.getTime(), claimed_by: 'validator', metadata: { built_by: 'validator' } },
  ];
  const report = memberReport(root, { since: 'today', now: NOW, tasks });

  assert.deepEqual(report.members.map((row) => row.member), ['builder']);
  assert.deepEqual(report.members[0].waiting, [{ title: 'Board shows last result' }]);
  assert.deepEqual(report.members[0].turned_down, [{ title: 'Report v1', reason: 'too long' }]);
  assert.match(formatReport(report), /not merged yet\s+Board shows last result/);
});

test('a busy member shows three lines per group and a count for the rest', (t) => {
  const ticks = Array.from({ length: 6 }, (_, i) => entry(`0${i + 1}:00`, 'Mission run tick 1', {
    mission: `job ${i}`, verifier: 'passed', summary: `Job ${i} works.`,
  })).join('');
  const root = workspace(t, { builder: ticks });
  const text = formatReport(memberReport(root, { since: 'today', now: NOW }));
  assert.match(text, /finished\s+Job 5 works\.\n\s+Job 4 works\.\n\s+Job 3 works\.\n\s+and 3 more/);
  assert.doesNotMatch(text, /Job 2 works/);
});

test('since reads relative times, today, yesterday, and dates on the local clock', () => {
  assert.equal(parseSince('2h', NOW).getTime(), NOW.getTime() - 2 * 3600e3);
  assert.equal(parseSince('yesterday', NOW).getTime(), new Date(2026, 9, 13).getTime());
  assert.equal(parseSince('2026-10-12', NOW).getTime(), new Date(2026, 9, 12).getTime());
  assert.equal(parseSince('soon', NOW), null);
});

test('atris member report runs for real against diaries and a task list', (t) => {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const root = workspace(t, {
    builder: entry(time, 'Task completed', {
      title: 'Ship it', action: 'merged', proof: 'merged: https://github.com/acme/repo/pull/7',
    }),
  }, now);
  const env = { ...process.env, ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_HOME: path.join(root, '.atris-home') };
  const seed = spawnSync(process.execPath, ['-e', `
    const T = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'task-db'))});
    const db = T.open();
    T.addTask(db, { title: 'Needs your yes', status: 'review', claimedBy: 'builder', workspaceRoot: T.workspaceRoot(${JSON.stringify(root)}), metadata: { approval_status: 'pending' } });
  `], { env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);

  const run = spawnSync(process.execPath, [BIN, 'member', 'report', '--since', '1h'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 merged, 0 finished, 0 turned down, 1 not merged yet/);
  assert.match(run.stdout, /merged\s+Ship it\s+https:\/\/github\.com\/acme\/repo\/pull\/7/);
  assert.match(run.stdout, /not merged yet\s+Needs your yes/);

  const json = spawnSync(process.execPath, [BIN, 'member', 'report', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).totals.merged, 1);

  const bad = spawnSync(process.execPath, [BIN, 'member', 'report', '--since', 'soon'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a time/);
});
