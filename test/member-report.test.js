'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  memberReport,
  parseDiary,
  parseReportArgs,
  parseSince,
} = require('../lib/member-report');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function writeFileAt(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Two members with diary entries on both sides of 09:00 on 10-14, one quiet member,
// and the template folder that is not a member.
function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-report-')));
  const team = path.join(root, 'atris', 'team');
  writeFileAt(path.join(team, 'builder', 'logs', '2026-10-13.md'), [
    '## 22:10 · Tick 1: old work',
    '- did: something from the night before',
    '',
  ].join('\n'));
  writeFileAt(path.join(team, 'builder', 'logs', '2026-10-14.md'), [
    '## 08:59 · Task claimed',
    '- title: just before the window',
    '## 09:00 · Task claimed',
    '- task: CLI-1',
    '- title: login test stops flaking',
    '## 11:30 · Tick 1: login test stops flaking',
    '- did: the login test now waits for the page instead of sleeping',
    '- proof: node --test test/login.test.js, exit 0',
    '',
  ].join('\n'));
  writeFileAt(path.join(team, 'validator', 'logs', '2026-10-14.md'), [
    '## 12:15 · Mission run tick 1',
    '- member: validator',
    '- summary: reviewed the login change and kept it',
    '',
  ].join('\n'));
  writeFileAt(path.join(team, 'validator', 'logs', 'notes.txt'), '## 13:00 · not a diary\n');
  fs.mkdirSync(path.join(team, 'navigator', 'logs'), { recursive: true });
  writeFileAt(path.join(team, '_template', 'logs', '2026-10-14.md'), '## 10:00 · template\n');
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, 'member', 'report', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', NO_COLOR: '1', ATRIS_NO_UPDATE_CHECK: '1' },
  });
}

test('since accepts relative spans, today, yesterday, a date, and iso; rejects junk', () => {
  const now = new Date(2026, 9, 14, 15, 30);
  assert.equal(parseSince('2h', now).getTime(), new Date(2026, 9, 14, 13, 30).getTime());
  assert.equal(parseSince('30m', now).getTime(), new Date(2026, 9, 14, 15, 0).getTime());
  assert.equal(parseSince('3d', now).getTime(), new Date(2026, 9, 11, 15, 30).getTime());
  assert.equal(parseSince('today', now).getTime(), new Date(2026, 9, 14).getTime());
  assert.equal(parseSince('yesterday', now).getTime(), new Date(2026, 9, 13).getTime());
  assert.equal(parseSince('2026-10-12', now).getTime(), new Date(2026, 9, 12).getTime());
  assert.equal(parseSince('2026-10-14T09:00:00Z', now).toISOString(), '2026-10-14T09:00:00.000Z');
  assert.equal(parseSince('last tuesday-ish', now), null);
  assert.equal(parseSince('', now), null);
});

test('args: default since is 24h, --since and --since= both work, unknown flags fail', () => {
  assert.deepEqual(parseReportArgs([]), { help: false, since: '24h', json: false });
  assert.deepEqual(parseReportArgs(['--since', '2h', '--json']), { help: false, since: '2h', json: true });
  assert.deepEqual(parseReportArgs(['--since=today']), { help: false, since: 'today', json: false });
  assert.throws(() => parseReportArgs(['--since']), /needs a time/);
  assert.throws(() => parseReportArgs(['--loud']), /unknown option/);
});

test('diary parser reads heading time, title, and the first value of each field', () => {
  const entries = parseDiary('## 09:05 · Tick 2: x\n- did: first\n- did: second\nloose text\n## 9:07 Other\n', 2026, 10, 14);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].at.getTime(), new Date(2026, 9, 14, 9, 5).getTime());
  assert.equal(entries[0].title, 'Tick 2: x');
  assert.deepEqual(entries[0].fields, { did: 'first' });
  assert.equal(entries[1].title, 'Other');
});

test('report keeps only entries at or after since, groups by member, newest activity first', () => {
  const root = workspace();
  const since = new Date(2026, 9, 14, 9, 0).toISOString();
  const report = memberReport(root, { since, now: new Date(2026, 9, 14, 15, 0) });
  assert.equal(report.members_active, 2);
  assert.equal(report.members_quiet, 1, 'navigator wrote nothing; _template is not a member');
  assert.equal(report.entries, 3);
  assert.deepEqual(report.members.map((row) => row.member), ['validator', 'builder']);
  const builder = report.members[1];
  assert.deepEqual(builder.entries.map((entry) => entry.title), ['Task claimed', 'Tick 1: login test stops flaking']);
  assert.equal(builder.entries[0].detail, 'login test stops flaking');
  assert.equal(builder.entries[1].detail, 'the login test now waits for the page instead of sleeping');
  assert.equal(report.members[0].entries[0].detail, 'reviewed the login change and kept it');
});

test('report with a wide window reaches back into older diary days', () => {
  const root = workspace();
  const report = memberReport(root, { since: '2026-10-13', now: new Date(2026, 9, 14, 15, 0) });
  const builder = report.members.find((row) => row.member === 'builder');
  assert.equal(builder.count, 4);
  assert.equal(builder.entries[0].detail, 'something from the night before');
});

test('cli: atris member report --since prints what each member did, in plain text and json', () => {
  const root = workspace();
  const text = runCli(root, ['--since', '2026-10-14T09:00:00Z']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /what the team did since/);
  assert.match(text.stdout, /2 members worked, 3 entries, 1 quiet/);
  assert.match(text.stdout, /validator {2}1 entry/);
  assert.match(text.stdout, /builder {2}2 entries/);
  assert.match(text.stdout, /11:30 +Tick 1: login test stops flaking/);
  assert.match(text.stdout, /the login test now waits for the page instead of sleeping/);
  assert.doesNotMatch(text.stdout, /just before the window|night before|template/);

  const json = runCli(root, ['--since', '2026-10-14T09:00:00Z', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.since, '2026-10-14T09:00:00.000Z');
  assert.equal(report.entries, 3);
  assert.equal(report.members[1].entries[0].at, '2026-10-14T09:00:00.000Z');
});

test('cli: quiet window says so, bad time and missing team folder fail with exit 1', () => {
  const root = workspace();
  const quiet = runCli(root, ['--since', '2026-10-15T00:00:00Z']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /nothing written in any member diary since then/);

  const bad = runCli(root, ['--since', 'whenever']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not a time/);

  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-report-empty-')));
  const none = runCli(empty, ['--since', '2h']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no atris\/team folder/);
});
