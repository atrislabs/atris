'use strict';

// The member report says how long each finished job took (first pickup to
// finish) and how many tries it needed (every run, including ones that failed
// or timed out). Times come from the member diaries, on the local clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { formatReport, memberReport } = require('../lib/member-report');

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

function workspace(t, member, days) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-report-time-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'atris', 'team', member, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const [day, text] of days) fs.writeFileSync(path.join(logs, dayName(day)), text);
  return root;
}

const RETRY = 'Adding a job that already exists reuses it';
const MERGED = 'Stop works for codex';
const YESTERDAY_JOB = 'Board opens faster';

const YESTERDAY = [
  entry('22:00', 'Task claimed', { title: YESTERDAY_JOB }),
  entry('22:00', 'Mission started', { mission: YESTERDAY_JOB }),
  entry('23:00', 'Mission run tick 1', { mission: YESTERDAY_JOB, verifier: 'failed', summary: 'half done' }),
].join('');

const TODAY = [
  // Finished across midnight: picked up yesterday at 22:00, passed today at 01:30.
  entry('01:30', 'Mission run tick 1', { mission: YESTERDAY_JOB, verifier: 'passed', summary: 'The board opens in half the time.' }),
  // Timed out once, picked up again, then passed: two tries, 40 minutes.
  entry('05:44', 'Task claimed', { title: RETRY }),
  entry('05:44', 'Mission started', { mission: RETRY }),
  entry('05:54', 'Mission run tick 1', { mission: RETRY, tick_status: 'errored', reason: 'claude-timeout', verifier: 'not_run', summary: 'error' }),
  entry('05:55', 'Task claimed', { title: RETRY }),
  entry('05:55', 'Mission started', { mission: RETRY }),
  entry('06:24', 'Mission run tick 1', { mission: RETRY, verifier: 'passed', summary: 'Adding a copy of a job now reuses the old one.' }),
  // Passed then merged: the merge line carries the time up to the merge.
  entry('07:00', 'Task claimed', { title: MERGED }),
  entry('07:01', 'Mission started', { mission: MERGED }),
  entry('09:30', 'Mission run tick 1', { mission: MERGED, verifier: 'passed', summary: 'Stop works.' }),
  entry('10:00', 'Task completed', { title: MERGED, action: 'merged', proof: 'merged: https://github.com/acme/repo/pull/42' }),
  // Picked up again after it finished: a new job, timed from the new pickup.
  entry('10:30', 'Task claimed', { title: RETRY }),
  entry('10:30', 'Mission started', { mission: RETRY }),
  entry('10:35', 'Mission run tick 1', { mission: RETRY, verifier: 'passed', summary: 'Copies reuse the old job again.' }),
].join('');

test('finished and merged jobs carry how long they took and how many tries', (t) => {
  const yesterday = new Date(2026, 9, 13, 12, 0);
  const root = workspace(t, 'builder', [[yesterday, YESTERDAY], [NOW, TODAY]]);
  const report = memberReport(root, { since: 'today', now: NOW });
  const builder = report.members[0];

  assert.deepEqual(builder.merged, [
    { title: MERGED, link: 'https://github.com/acme/repo/pull/42', took_minutes: 180, tries: 1 },
  ]);
  const finished = Object.fromEntries(builder.finished.map((item) => [item.detail, item]));
  assert.equal(finished['Copies reuse the old job again.'].took_minutes, 5);
  assert.equal(finished['Copies reuse the old job again.'].tries, 1);
  // The newest word on a title wins, so the 06:24 pass folds into the 10:35 one.
  assert.equal(finished['Adding a copy of a job now reuses the old one.'], undefined);
  assert.equal(finished['The board opens in half the time.'].took_minutes, 210);
  assert.equal(finished['The board opens in half the time.'].tries, 2);

  const text = formatReport(report);
  assert.match(text, /merged\s+Stop works for codex\s+https:\/\/github\.com\/acme\/repo\/pull\/42\s+took 3h, 1 try\n/);
  assert.match(text, /Copies reuse the old job again\.\s+took 5m, 1 try\n/);
  assert.match(text, /The board opens in half the time\.\s+took 3h 30m, 2 tries\n/);
});

test('a retried job counts the failed run as a try and times from the first pickup', (t) => {
  const retryOnly = TODAY.split('## ').filter((part) => part.includes(RETRY) && part < '06:30').map((part) => `## ${part}`).join('');
  const root = workspace(t, 'builder', [[NOW, retryOnly]]);
  // The window opens after the first pickup; the pickup still sets the start.
  const report = memberReport(root, { since: new Date(2026, 9, 14, 6, 0).toISOString(), now: new Date(2026, 9, 14, 6, 30) });
  const [item] = report.members[0].finished;
  assert.equal(item.detail, 'Adding a copy of a job now reuses the old one.');
  assert.equal(item.took_minutes, 40);
  assert.equal(item.tries, 2);
  assert.match(formatReport(report), /reuses the old one\.\s+took 40m, 2 tries\n/);
});

test('a finish with no pickup in the diary prints no made-up time', (t) => {
  const root = workspace(t, 'builder', [[NOW, entry('09:00', 'Task completed', { title: 'Lonely', action: 'merged', proof: 'merged' })]]);
  const report = memberReport(root, { since: 'today', now: NOW });
  assert.deepEqual(report.members[0].merged, [{ title: 'Lonely', link: null }]);
  assert.doesNotMatch(formatReport(report), /took/);
});

test('atris member report prints time and tries for real', (t) => {
  const now = new Date();
  const at = (minutesAgo) => {
    const d = new Date(now.getTime() - minutesAgo * 60e3);
    return { day: d, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  };
  const start = at(50);
  const fail = at(40);
  const pass = at(0);
  const days = new Map();
  const add = (stamp, text) => {
    const key = dayName(stamp.day);
    days.set(key, { day: stamp.day, text: (days.get(key)?.text || '') + text });
  };
  add(start, entry(start.time, 'Task claimed', { title: 'Ship it' }) + entry(start.time, 'Mission started', { mission: 'Ship it' }));
  add(fail, entry(fail.time, 'Mission run tick 1', { mission: 'Ship it', verifier: 'failed', summary: 'not yet' }));
  add(pass, entry(pass.time, 'Mission run tick 1', { mission: 'Ship it', verifier: 'passed', summary: 'It ships now.' }));
  const root = workspace(t, 'builder', [...days.values()].map(({ day, text }) => [day, text]));
  const env = { ...process.env, ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_HOME: path.join(root, '.atris-home') };

  const run = spawnSync(process.execPath, [BIN, 'member', 'report', '--since', '2h'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /finished\s+It ships now\.\s+took 50m, 2 tries/);

  const json = spawnSync(process.execPath, [BIN, 'member', 'report', '--since', '2h', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const [item] = JSON.parse(json.stdout).members[0].finished;
  assert.equal(item.took_minutes, 50);
  assert.equal(item.tries, 2);
});
