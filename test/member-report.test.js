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


test('report dedup rejected cross-group bridge does not reserve its link', (t) => {
  const root = workspace(t, { builder: '' });
  const link = 'https://example.test/pull/shared';
  const tasks = [{
    title: ' Alpha ', status: 'review', claimed_by: 'builder',
    updated_at: new Date(2026, 9, 14, 11, 0).getTime(),
  }];
  const merges = [
    { title: 'alpha', url: link, mergedAt: new Date(2026, 9, 14, 10, 0).toISOString(), headRefName: 'codex/builder-alpha' },
    { title: 'charlie', url: link, mergedAt: new Date(2026, 9, 14, 9, 0).toISOString(), headRefName: 'codex/builder-charlie' },
  ];
  const before = JSON.stringify({ tasks, merges });
  const report = memberReport(root, { since: 'today', now: NOW, tasks, merges });
  assert.deepEqual(report, {
    ok: true, action: 'report', since: '00:00',
    totals: { merged: 1, finished: 0, turned_down: 0, waiting: 1 },
    members: [{
      member: 'builder', total: 2,
      merged: [{ title: 'charlie', link }], finished: [], turned_down: [],
      waiting: [{ title: ' Alpha ' }],
    }],
  });
  assert.equal(JSON.stringify({ tasks, merges }), before);
});

test('report dedup keeps newest rows and stable cross-group and merge ties', (t) => {
  const root = workspace(t, { builder: entry('10:00', 'Mission run tick 1', {
    mission: 'Same job', verifier: 'passed', summary: 'Done.',
  }) });
  const at10 = new Date(2026, 9, 14, 10, 0);
  const at11 = new Date(2026, 9, 14, 11, 0);
  const newest = memberReport(root, {
    since: 'today', now: NOW,
    tasks: [{ title: ' SAME JOB ', status: 'review', claimed_by: 'builder', updated_at: at11.getTime() }],
    merges: [{ title: 'same job', headRefName: 'codex/builder-same', mergedAt: new Date(2026, 9, 14, 9, 0).toISOString() }],
  });
  assert.deepEqual(newest.members[0], {
    member: 'builder', total: 1, merged: [], finished: [], turned_down: [], waiting: [{ title: ' SAME JOB ' }],
  });
  const diaryTie = memberReport(root, {
    since: 'today', now: NOW,
    tasks: [{ title: ' SAME JOB ', status: 'review', claimed_by: 'builder', updated_at: at10.getTime() }],
    merges: [{ title: 'same job', headRefName: 'codex/builder-same', mergedAt: at10.toISOString() }],
  });
  assert.deepEqual(diaryTie.members[0], {
    member: 'builder', total: 1, merged: [], finished: [{ title: 'Same job', detail: 'Done.' }], turned_down: [], waiting: [],
  });
  const taskTie = memberReport(root, {
    since: 'today', now: NOW,
    tasks: [{ title: 'Queue tie', status: 'review', claimed_by: 'builder', updated_at: at11.getTime() }],
    merges: [{ title: 'queue tie', headRefName: 'codex/builder-queue', mergedAt: at11.toISOString() }],
  });
  assert.deepEqual(taskTie.members[0], {
    member: 'builder', total: 2, merged: [], finished: [{ title: 'Same job', detail: 'Done.' }], turned_down: [], waiting: [{ title: 'Queue tie' }],
  });
  const first = { title: 'first choice', url: 'https://example.test/tied', headRefName: 'codex/builder-first', mergedAt: at11.toISOString() };
  const second = { title: 'second choice', url: first.url, headRefName: 'codex/builder-second', mergedAt: at11.toISOString() };
  const merges = [first, second];
  const forward = memberReport(root, { since: 'today', now: NOW, merges });
  const reverse = memberReport(root, { since: 'today', now: NOW, merges: [...merges].reverse() });
  assert.deepEqual(forward.members[0].merged, [{ title: 'first choice', link: first.url }]);
  assert.deepEqual(reverse.members[0].merged, [{ title: 'second choice', link: first.url }]);
  assert.strictEqual(merges[0], first);
  assert.strictEqual(merges[1], second);
});

test('report dedup compares truthy links by strict value or object identity', (t) => {
  const root = workspace(t, { builder: '' });
  const shared = { href: 'same' };
  const distinct = { href: 'same' };
  const sharedSymbol = Symbol('same');
  const distinctSymbol = Symbol('same');
  const rows = [
    ['url first', 'https://example.test/pull/1'],
    ['url repeated', 'https://example.test/pull/1'],
    ['url case', 'https://EXAMPLE.test/pull/1'],
    ['number link', 1], ['string link', '1'],
    ['object first', shared], ['object repeated', shared], ['object distinct', distinct],
    ['symbol first', sharedSymbol], ['symbol repeated', sharedSymbol], ['symbol distinct', distinctSymbol],
    ['boolean first', true], ['boolean repeated', true],
  ];
  const merges = rows.map(([title, url]) => ({
    title, url, headRefName: 'codex/builder-links', mergedAt: new Date(2026, 9, 14, 11, 0).toISOString(),
  }));
  const report = memberReport(root, { since: 'today', now: NOW, merges });
  const merged = report.members[0].merged;
  assert.deepEqual(merged.map((item) => item.title), [
    'url first', 'url case', 'number link', 'string link', 'object first', 'object distinct', 'symbol first', 'symbol distinct', 'boolean first',
  ]);
  assert.strictEqual(merged[4].link, shared);
  assert.strictEqual(merged[5].link, distinct);
  assert.notStrictEqual(merged[4].link, merged[5].link);
  assert.strictEqual(merged[6].link, sharedSymbol);
  assert.strictEqual(merged[7].link, distinctSymbol);
  assert.deepEqual(report.totals, { merged: 9, finished: 0, turned_down: 0, waiting: 0 });
});

test('report dedup preserves non-string legacy coercions and comparison errors', (t) => {
  const root = workspace(t, { builder: '' });
  const later = new Date(2026, 9, 14, 11, 0).toISOString();
  const earlier = new Date(2026, 9, 14, 10, 0).toISOString();
  const isolated = { toString() { throw new Error('an isolated title must not be coerced'); } };
  const single = memberReport(root, { since: 'today', now: NOW, merges: [
    { title: isolated, headRefName: 'codex/builder-isolated', mergedAt: later },
  ] });
  assert.equal(single.members[0].total, 1);
  assert.strictEqual(single.members[0].merged[0].title, isolated);
  const expected = new Error('actual title comparison');
  const throwing = { toString() { throw expected; } };
  assert.throws(() => memberReport(root, { since: 'today', now: NOW, merges: [
    { title: 'first', headRefName: 'codex/builder-first', mergedAt: later },
    { title: throwing, headRefName: 'codex/builder-throw', mergedAt: earlier },
  ] }), (error) => error === expected);
  const calls = [];
  const coerced = { toString() { calls.push('title'); return 'SAME'; } };
  const stringFirst = memberReport(root, { since: 'today', now: NOW, merges: [
    { title: 'same', headRefName: 'codex/builder-string', mergedAt: later },
    { title: coerced, headRefName: 'codex/builder-object', mergedAt: earlier },
  ] });
  assert.deepEqual(stringFirst.members[0].merged, [{ title: 'same', link: null }]);
  assert.deepEqual(calls, ['title']);
  calls.length = 0;
  const objectFirst = memberReport(root, { since: 'today', now: NOW, merges: [
    { title: coerced, headRefName: 'codex/builder-object', mergedAt: later },
    { title: 'same', headRefName: 'codex/builder-string', mergedAt: earlier },
  ] });
  assert.strictEqual(objectFirst.members[0].merged[0].title, coerced);
  assert.deepEqual(calls, ['title']);
  const numbers = memberReport(root, { since: 'today', now: NOW, merges: [
    { title: 1, headRefName: 'codex/builder-number', mergedAt: later },
    { title: '1', headRefName: 'codex/builder-string', mergedAt: later },
    { title: 'other', headRefName: 'codex/builder-other', mergedAt: earlier },
  ] });
  assert.deepEqual(numbers.members[0].merged, [{ title: 1, link: null }, { title: 'other', link: null }]);
});

test('report dedup retains whitespace titles and skips only original falsy titles and links', (t) => {
  const root = workspace(t, { builder: '' });
  const rows = [
    ['   ', null], ['\t', false],
    ['zero link', 0], ['false link', false], ['empty link', ''], ['null link', null], ['nan link', NaN], ['missing link', undefined],
    [null, 'null title'], [undefined, 'undefined title'], ['', 'empty title'], [0, 'zero title'], [false, 'false title'], [NaN, 'nan title'], [0n, 'bigint zero title'],
  ];
  const merges = rows.map(([title, url]) => ({
    title, url, headRefName: 'codex/builder-falsy', mergedAt: new Date(2026, 9, 14, 11, 0).toISOString(),
  }));
  const report = memberReport(root, { since: 'today', now: NOW, merges });
  assert.deepEqual(report.members[0], {
    member: 'builder', total: 7,
    merged: [
      { title: '   ', link: null }, { title: 'zero link', link: null }, { title: 'false link', link: null },
      { title: 'empty link', link: null }, { title: 'null link', link: null }, { title: 'nan link', link: null }, { title: 'missing link', link: null },
    ],
    finished: [], turned_down: [], waiting: [],
  });
  assert.deepEqual(report.totals, { merged: 7, finished: 0, turned_down: 0, waiting: 0 });
  assert.equal(merges.at(-1).title, 0n);
});
