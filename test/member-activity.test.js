'use strict';

// Who really worked: dated member logs, commits that name a member, roster
// runs, and stream events, bucketed per member per day. Active is evidence
// in the last 7 days, quiet is 8 to 14, idle is nothing in 14.

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMemberActivity,
  commitMembers,
  logFileDay,
  memberActivityRows,
  parseGitLog,
} = require('../lib/team-presence');
const { collectMemberActivity, recordMemberActivity, teamCommand } = require('../commands/team');
const { collectStreamEvents } = require('../commands/stream');

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

test('the feed has one row per member per day in the last 7 days', () => {
  const rows = memberActivityRows(buildMemberActivity(fixture()), NOW);
  assert.deepEqual(rows.map((row) => `${row.day} ${row.member}`), [
    '2026-09-26 builder',
    '2026-09-27 scout',
    '2026-09-28 notes',
    '2026-09-29 builder',
    '2026-09-30 builder',
  ]);
  assert.deepEqual(rows[4], { member: 'builder', day: '2026-09-30', runs: 2, engine: 'codex', model: 'gpt-6.1-sol', landed: 1, failed: 1, reverted: 0 });
});

test('recording rewrites only the last 7 days and keeps older rows and unreadable lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-'));
  try {
    const file = path.join(root, '.atris', 'state', 'member_activity.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ member: 'builder', day: '2026-09-01', runs: 4 }),
      JSON.stringify({ member: 'builder', day: '2026-09-30', runs: 99 }),
      'not json',
      '',
    ].join('\n'));
    const activity = buildMemberActivity(fixture());
    const roster = activity.map((row) => ({ name: row.name, activity: row }));
    const first = recordMemberActivity(root, roster, NOW);
    assert.equal(first.rows, 5);
    assert.equal(first.members, 3);
    recordMemberActivity(root, roster, NOW);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 7, 'old row, bad line, and five fresh rows, even after two records');
    assert.equal(lines[0], JSON.stringify({ member: 'builder', day: '2026-09-01', runs: 4 }));
    assert.equal(lines[1], 'not json');
    assert.ok(!lines.some((line) => line.includes('"runs":99')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('atris team shows each member as one row: this week with its record, quiet with days since', () => {
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
    liveRuns: [],
    termWidth: 200,
    write: (s) => { out += s; },
  });
  assert.equal(code, 0);
  assert.match(out, /^builder +- +- +this week +5 runs this week, 2 landed, 2 failed, 1 reverted +today$/m);
  assert.match(out, /^sleeper +- +- +quiet +- +-$/m);
  assert.match(out, /^old-timer +- +- +quiet +- +91d$/m);
});

test('atris team --record writes the feed and says where; --json stays parseable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-cmd-'));
  try {
    const activity = buildMemberActivity(fixture());
    const deps = {
      root,
      now: () => NOW,
      members: MEMBERS.map((name) => ({ name, role: '' })),
      missions: [],
      presence: { members: [] },
      activity,
      lineup: { ok: true, jobs: [], team: [] },
      liveRuns: [],
      termWidth: 200,
    };
    let out = '';
    assert.equal(teamCommand(['--record'], { ...deps, write: (s) => { out += s; } }), 0);
    assert.match(out, /^builder +- +- +this week +5 runs this week, 2 landed, 2 failed, 1 reverted +today$/m);
    assert.match(out, /^old-timer +- +- +quiet +- +91d$/m);
    assert.match(out, /recorded 5 days of work for 3 members to .*member_activity\.jsonl/);
    const file = path.join(root, '.atris', 'state', 'member_activity.jsonl');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5);

    let json = '';
    let err = '';
    assert.equal(teamCommand(['--json', '--record'], { ...deps, write: (s) => { json += s; }, error: (s) => { err += s; } }), 0);
    const parsed = JSON.parse(json);
    assert.equal(parsed.find((entry) => entry.name === 'builder').activity.runs_7d, 5);
    assert.match(err, /recorded 5 days/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a day on three engine and model pairs reports one pair that really ran', () => {
  const rows = buildMemberActivity({
    nowMs: NOW,
    members: ['builder'],
    runs: [
      { at: at(9, 30, 9), member: 'builder', engine: 'codex', model: 'gpt-A', outcome: 'landed' },
      { at: at(9, 30, 10), member: 'builder', engine: 'claude', model: 'opus-B', outcome: 'landed' },
      { at: at(9, 30, 11), member: 'builder', engine: 'claude', model: 'sonnet-C', outcome: 'landed' },
    ],
  });
  const ran = new Set(['codex gpt-A', 'claude opus-B', 'claude sonnet-C']);
  const day = rows[0].days['2026-09-30'];
  assert.ok(ran.has(`${day.engine} ${day.model}`), `day pair ${day.engine} ${day.model} never ran`);
  assert.equal(day.engine, 'claude');
  assert.ok(ran.has(`${rows[0].engine} ${rows[0].model}`));
  const [feed] = memberActivityRows(rows, NOW);
  assert.ok(ran.has(`${feed.engine} ${feed.model}`), `feed pair ${feed.engine} ${feed.model} never ran`);
});

test('recording from a checkout without a member keeps that member\'s rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-keep-'));
  try {
    const file = path.join(root, '.atris', 'state', 'member_activity.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const scoutRow = JSON.stringify({ member: 'scout', day: '2026-09-30', runs: 3 });
    fs.writeFileSync(file, `${scoutRow}\n${JSON.stringify({ member: 'builder', day: '2026-09-30', runs: 99 })}\n`);
    // This checkout only knows builder.
    const activity = buildMemberActivity({ ...fixture(), members: ['builder'] });
    recordMemberActivity(root, activity.map((row) => ({ name: row.name, activity: row })), NOW);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.includes(scoutRow), 'scout was not seen here, so its row stays');
    assert.ok(!lines.some((line) => line.includes('"runs":99')), 'builder was seen here, so its row is replaced');
    assert.equal(lines.filter((line) => JSON.parse(line).member === 'builder').length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh side copy cut from someone else\'s commit shows no work for its owner', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'member-activity-wt-'));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'someone', GIT_AUTHOR_EMAIL: 's@x', GIT_COMMITTER_NAME: 'someone', GIT_COMMITTER_EMAIL: 's@x' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    const main = path.join(base, 'main');
    const copy = path.join(base, 'scout-copy');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'master');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'unrelated change from someone else');
    git(main, 'worktree', 'add', '-q', '-b', 'scout-sweep', copy);
    git(main, 'config', 'branch.scout-sweep.atris-owner', 'scout');
    const nowMs = Date.now();
    const scoutCommits = () => collectStreamEvents({ root: copy, nowMs, skipLanding: true })
      .filter((event) => event.event === 'worktree_commit' && event.agent === 'scout');

    assert.deepEqual(scoutCommits(), [], 'the inherited commit is not scout\'s work');
    const idle = buildMemberActivity({ nowMs, members: ['scout'], events: collectStreamEvents({ root: copy, nowMs, skipLanding: true }) });
    assert.equal(idle[0].runs_7d, 0);

    git(copy, 'commit', '-q', '--allow-empty', '-m', 'scout: first real sweep');
    const own = scoutCommits();
    assert.equal(own.length, 1);
    assert.match(own[0].summary, /scout: first real sweep/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
