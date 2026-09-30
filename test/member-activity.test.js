'use strict';

// Who really worked: dated member logs, commits that name a member, roster
// runs, and stream events, bucketed per member per day. Active is evidence
// in the last 7 days, quiet is 8 to 14, idle is nothing in 14.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMemberActivity,
  commitMembers,
  logFileDay,
  parseGitLog,
} = require('../lib/team-presence');
const { collectMemberActivity, teamCommand } = require('../commands/team');

const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();
const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour, 0, 0).toISOString();
const MEMBERS = ['builder', 'notes', 'scout', 'sleeper', 'old-timer'];

test('log file names give their day; a bad date gives none', () => {
  assert.equal(logFileDay('2026-09-28.md'), '2026-09-28');
  assert.equal(logFileDay('2026-09-28-free-plan-workspace-files.md'), '2026-09-28');
  assert.equal(logFileDay('2026-02-30.md'), '');
  assert.equal(logFileDay('notes.md'), '');
});

test('git log output parses into dated commits', () => {
  const text = `\x1e${at(9, 29)}\x1fbuilder: land the fix\n\nMember: builder\n\x1e${at(9, 28)}\x1fplain subject\n`;
  const commits = parseGitLog(text);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, 'builder: land the fix');
  assert.match(commits[0].body, /Member: builder/);
});

test('a commit names a member only by trailer, co-author, or subject prefix', () => {
  const known = new Set(MEMBERS);
  assert.deepEqual(commitMembers({ subject: 'builder: land it', body: '' }, known), { names: ['builder'], reverted: false });
  assert.deepEqual(commitMembers({ subject: 'scout(search): faster sweep', body: '' }, known).names, ['scout']);
  assert.deepEqual(commitMembers({ subject: 'x', body: 'Atris-Member: sleeper' }, known).names, ['sleeper']);
  assert.deepEqual(commitMembers({ subject: 'x', body: 'Co-authored-by: scout <s@x>' }, known).names, ['scout']);
  // Ordinary words and the atris-builder bot line do not count.
  assert.deepEqual(commitMembers({ subject: 'Journal: notes for the builder', body: 'Co-authored-by: Atris <1+atris-builder[bot]@users.noreply.github.com>' }, known).names, []);
  assert.deepEqual(commitMembers({ subject: 'Revert "builder: land it"', body: '' }, known), { names: ['builder'], reverted: true });
});

function fixture() {
  return {
    nowMs: NOW,
    members: MEMBERS,
    logDays: { notes: ['2026-09-28', '2026-09-28', '2026-09-20'], 'old-timer': ['2026-07-01'] },
    commits: [
      { ms: Date.parse(at(9, 29)), subject: 'builder: land the fix', body: '' },
      { ms: Date.parse(at(9, 29, 18)), subject: 'Revert "builder: land the fix"', body: '' },
    ],
    runs: [
      { at: at(9, 30, 9), member: 'builder', engine: 'codex', model: 'gpt-6.1-sol', outcome: 'landed' },
      { at: at(9, 30, 10), member: 'builder', engine: 'codex', model: 'gpt-6.1-sol', outcome: 'failed' },
      { at: at(9, 26), member: 'builder', engine: 'claude', model: 'claude-opus-5-5', outcome: 'stalled' },
    ],
    events: [
      { agent: 'scout', ts: at(9, 27), summary: 'claimed the sweep' },
      { agent: 'scout', ts: at(9, 27, 14), summary: 'claimed the sweep' },
      { agent: 'not-a-member', ts: at(9, 29), summary: 'ignored' },
    ],
  };
}

test('activity buckets every kind of evidence per member and day', () => {
  const rows = Object.fromEntries(buildMemberActivity(fixture()).map((row) => [row.name, row]));

  const builder = rows.builder;
  assert.equal(builder.status, 'active');
  assert.equal(builder.last_active, '2026-09-30');
  assert.equal(builder.days_since, 0);
  assert.equal(builder.runs_7d, 5);
  assert.equal(builder.landed, 2, 'one landed run and one commit');
  assert.equal(builder.failed, 2, 'one failed run and one stalled run');
  assert.equal(builder.reverted, 1);
  assert.equal(builder.engine, 'codex');
  assert.equal(builder.model, 'gpt-6.1-sol');
  assert.deepEqual(builder.evidence, { logs: 0, commits: 2, runs: 3, events: 0 });
  assert.deepEqual(builder.days['2026-09-30'], { runs: 2, engine: 'codex', model: 'gpt-6.1-sol', landed: 1, failed: 1, reverted: 0 });
  assert.deepEqual(builder.days['2026-09-29'], { runs: 2, engine: null, model: null, landed: 1, failed: 0, reverted: 1 });

  // Two log files on one day are two runs; the 09-20 file is quiet-window only.
  assert.equal(rows.notes.runs_7d, 2);
  assert.equal(rows.notes.status, 'active');
  assert.ok(rows.notes.days['2026-09-20']);

  // The same stream summary twice on one day counts once.
  assert.equal(rows.scout.runs_7d, 1);
  assert.equal(rows.scout.last_active, '2026-09-27');
});

test('no evidence in 14 days is idle, 8 to 14 days is quiet', () => {
  const input = fixture();
  input.logDays.sleeper = ['2026-09-19'];
  const rows = Object.fromEntries(buildMemberActivity(input).map((row) => [row.name, row]));
  assert.equal(rows.sleeper.status, 'quiet');
  assert.equal(rows.sleeper.runs_7d, 0);
  assert.equal(rows['old-timer'].status, 'idle');
  assert.equal(rows['old-timer'].last_active, '2026-07-01');
  assert.deepEqual(rows['old-timer'].days, {});
});

test('collecting reads each log folder and runs git once for the whole team', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-collect-'));
  try {
    const members = ['builder', 'notes', 'scout'].map((name) => ({ name, dir: path.join(root, 'atris', 'team', name) }));
    fs.mkdirSync(path.join(members[1].dir, 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(members[1].dir, 'logs', '2026-09-28.md'), '# log');
    fs.writeFileSync(path.join(members[1].dir, 'logs', '2026', '2026-09-29-tick.md'), '# log');
    let gitCalls = 0;
    const activity = collectMemberActivity(root, members, {
      nowMs: NOW,
      streamEvents: [],
      runs: [],
      runGit: (args) => {
        gitCalls += 1;
        assert.equal(args[0], 'log');
        return { status: 0, stdout: `\x1e${at(9, 29)}\x1fscout: sweep\n` };
      },
    });
    assert.equal(gitCalls, 1);
    const by = Object.fromEntries(activity.map((row) => [row.name, row]));
    assert.equal(by.notes.runs_7d, 2);
    assert.equal(by.scout.runs_7d, 1);
    assert.equal(by.builder.status, 'idle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris team shows each active member on one line and idle members on one line', () => {
  const activity = buildMemberActivity(fixture());
  let out = '';
  const code = teamCommand([], {
    root: '/fake/root',
    now: () => NOW,
    members: MEMBERS.map((name) => ({ name, role: '' })),
    missions: [],
    presence: { members: [] },
    activity,
    lineup: { ok: true, jobs: [], team: [] },
    write: (s) => { out += s; },
  });
  assert.equal(code, 0);
  assert.match(out, /^builder +last active today, 5 runs in 7 days, on codex gpt-6\.1-sol, 2 landed, 2 failed, 1 reverted$/m);
  assert.match(out, /^idle, nothing in 14 days \(2\): old-timer, sleeper$/m);
});
