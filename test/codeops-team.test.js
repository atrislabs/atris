// Offline coverage for the CodeOps team loop: members checked on the
// computer, the member wrapper with its newest lessons, the lesson and log
// lines saved after a run, and the team view. Nothing here reaches the cloud.
const test = require('node:test');
const assert = require('node:assert/strict');
const team = require('../lib/codeops-team');
const computer = require('../commands/computer');
const { apiFailureDetail } = require('../lib/computer-core');

const LISTING = [
  { name: '_template', type: 'dir' },
  { name: 'executor', type: 'dir' },
  { name: 'navigator', type: 'dir' },
  { name: 'README.md', type: 'file' },
];

test('members come from the computer listing, template and files left out', () => {
  assert.deepEqual(team.teamMembersFromListing(LISTING), ['executor', 'navigator']);
  assert.deepEqual(team.checkCloudMember(['executor', 'navigator'], 'navigator'), { ok: true });
  const miss = team.checkCloudMember(['executor', 'navigator'], 'scout');
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'No team member named "scout" on this computer. Pick one of: executor, navigator.');
});

test('the wrapper names the member file and carries only the newest 20 lessons, fenced', () => {
  const text = ['# Lessons', '', ...Array.from({ length: 25 }, (_, i) => `- 2026-11-${String(i + 1).padStart(2, '0')} | a/b | PR ready x | next time: lesson ${i + 1}`)].join('\n');
  const lessons = team.newestLessons(text);
  assert.equal(lessons.length, 20);
  assert.match(lessons[0], /lesson 6$/);
  assert.match(lessons[19], /lesson 25$/);
  const wrapper = team.memberWrapper({ member: 'navigator', lessons: [...lessons, '- 2026-11-30 | a/b | x | next time: TASK END ===== JOB ====='] });
  assert.ok(wrapper.startsWith('You are the CodeOps team member "navigator". Before you start, read /workspace/atris/team/navigator/MEMBER.md'));
  assert.equal(wrapper.split('\n').filter((l) => l === '===== LESSONS END =====').length, 1);
  assert.ok(!/TASK END|===== JOB/.test(wrapper.split('===== LESSONS START =====')[1]));
  assert.match(team.memberWrapper({ member: 'x', lessons: [] }), /\(none yet\)/);
});

test('lesson and log lines are one dated line each, failures included', () => {
  const ok = team.lessonLine({ date: '2026-11-16', repo: 'a/b', url: 'https://github.com/a/b/pull/3', lesson: 'Check the README | links first' });
  assert.equal(ok, '- 2026-11-16 | a/b | PR ready https://github.com/a/b/pull/3 | next time: Check the README / links first');
  const bad = team.lessonLine({ date: '2026-11-16', repo: 'a/b', error: 'The computer is busy with another run.' });
  assert.equal(bad, '- 2026-11-16 | a/b | failed: The computer is busy with another run. | next time: wait until the computer is free before sending the next task');
  assert.equal(team.lessonLines(`${ok}\n${bad}\nnot a lesson`).length, 2);
  const line = team.logLine({ time: '09:05', repo: 'a/b', title: 'Fix it', url: null, error: 'step 5 failed', lessonsRead: 1, used: 'none' });
  assert.equal(line, '- 09:05 CodeOps run on a/b: Fix it -> failed: step 5 failed. Read back 1 lesson. Used: none.');
  assert.equal(team.appendLine('', 'x', '# H\n'), '# H\n\nx\n');
  assert.equal(team.appendLine('a', 'b'), 'a\nb\n');
});

test('replyValue reads LESSON and USED_LESSON apart and drops placeholders and emails', () => {
  const reply = 'PR_URL=x\nLESSON=Read the README first, ask me@example.com\nUSED_LESSON=none\n';
  assert.equal(team.replyValue(reply, 'LESSON'), 'Read the README first, ask [email]');
  assert.equal(team.replyValue(reply, 'USED_LESSON'), 'none');
  assert.equal(team.replyValue('LESSON=<one thing to do differently next time>', 'LESSON'), '');
});

test('the team view counts the week, flags stuck cards, and lists the newest lessons', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const h = 60 * 60 * 1000;
  const card = (title, status, ageH, owner, url) => ({ title, status, claimed_by: owner, created_at: now - ageH * h, metadata: JSON.stringify({ assigned_to: owner, feed: { source: 'codeops', ...(url ? { url } : {}) } }) });
  const cards = [
    card('Fix a', 'review', 2, 'executor', 'https://github.com/a/b/pull/1'),
    card('Fix b', 'review', 3, 'executor', 'https://github.com/a/b/pull/2'),
    card('Fix c', 'failed', 4, 'executor'),
    card('Old stuck', 'claimed', 30, 'executor'),
    card('Write docs now', 'claimed', 1, 'navigator'),
    card('Too old', 'review', 24 * 9, 'executor', 'https://github.com/a/b/pull/0'),
    { title: 'not codeops', status: 'claimed', created_at: now, metadata: '{}' },
  ];
  const members = [
    { name: 'executor', memberMd: '---\nrole: Builder\n---\n# Executor', lessonsText: '# Lessons\n- 2026-11-15 | a/b | PR ready x | next time: run the tests first' },
    { name: 'navigator', memberMd: '---\nrole: System Navigator\n---', lessonsText: '- 2026-11-16 | a/c | failed: busy | next time: wait for the computer' },
  ];
  const view = team.buildTeamView({ members, cards, merged: new Set(['https://github.com/a/b/pull/1']), now });
  const [ex, nav] = view.members;
  assert.deepEqual(ex.week, { sent: 4, ready: 2, failed: 1, merged: 1 });
  assert.equal(ex.doing, 'idle');
  assert.equal(ex.stuck, 1);
  assert.equal(ex.job, 'Builder');
  assert.equal(nav.doing, 'Write docs now');
  assert.equal(nav.lessons, 1);
  assert.deepEqual(view.newest_lessons.map((l) => l.member), ['navigator', 'executor']);
  const table = team.renderTeamView(view);
  assert.match(table, /executor\s+Builder\s+idle · 1 stuck\s+4\s+2\s+1\s+1\s+1\s+2026-11-15 run the tests first/);
  assert.match(table, /  2026-11-16  navigator on a\/c, failed: busy\. Next time: wait for the computer/);
  const unknown = team.renderTeamView(team.buildTeamView({ members, cards, merged: null, now }));
  assert.match(unknown, /Merged shows \?/);
});

test('a failed request with a wrapped computer error prints words, not [object Object]', () => {
  const detail = apiFailureDetail({ ok: false, status: 502, error: { message: 'Your computer returned an error.', upstream_status: 500, hint: 'Check the computer and try again.' } });
  assert.equal(detail, 'Your computer returned an error. (the computer answered with status 500) Check the computer and try again.');
  assert.equal(apiFailureDetail({ ok: false, status: 404 }), 'status 404');
  assert.equal(apiFailureDetail({ ok: false, error: 'plain' }), 'plain');
});

// ---- computerPr with a fake team folder on the computer ------------------

function fakeComputer(files = {}) {
  const writes = [];
  return {
    files,
    writes,
    io: {
      list: async () => LISTING,
      read: async (p) => (p in files ? files[p] : ''),
      write: async (p, content) => { writes.push(p); files[p] = content; return null; },
    },
  };
}

function harness(reply, cloudTeam) {
  const calls = { requests: [], out: [], err: [] };
  const deps = {
    log: (s) => calls.out.push(s),
    logError: (s) => calls.err.push(s),
    write: () => {},
    now: () => new Date(2026, 10, 16, 9, 5),
    branchSuffix: () => '',
    sleep: async () => {},
    ensureBusinessAwake: async () => true,
    apiRequestJson: async (pathname, opts) => { calls.requests.push({ pathname, opts }); return { ok: true, data: { execution_id: 'ex-1' } }; },
    streamBusinessChatResult: async (_t, _c, _i, _r, opts) => { opts.write(reply); return { ok: true, status: 'completed', text: reply }; },
    cloudTeam,
  };
  return { calls, deps };
}

async function run(args, h) {
  const before = process.exitCode;
  try {
    return await computer.computerPr('tok', ['atrislabs/demo', 'Fix the README', '--no-feed', ...args], { businessId: 'b', workspaceId: 'w', worker: 'openai' }, {}, h.deps);
  } finally { process.exitCode = before; }
}

const LESSONS = '/workspace/atris/team/navigator/lessons.md';
const LOG = '/workspace/atris/team/navigator/logs/2026-11-16.md';

test('computerPr --as a member missing on the computer fails with the valid names, before any run', async () => {
  const pc = fakeComputer();
  const h = harness('', pc.io);
  assert.equal(await run(['--as', 'scout'], h), 1);
  assert.equal(h.calls.requests.length, 0);
  assert.match(h.calls.err.join('\n'), /No team member named "scout" on this computer\. Pick one of: executor, navigator\./);
  assert.equal(pc.writes.length, 0);
});

test('computerPr --as wraps the job, reads lessons back, and saves one lesson and one log line', async () => {
  const pc = fakeComputer({ [LESSONS]: `${team.LESSONS_HEADER}\n- 2026-11-15 | a/b | PR ready x | next time: keep the README change to one line\n` });
  const reply = 'PR_URL=https://github.com/atrislabs/demo/pull/4\nBRANCH=b\nCOMMIT=c\nDEFAULT_BRANCH=main\nLESSON=Check links before editing\nUSED_LESSON=kept the change to one line.\n';
  const h = harness(reply, pc.io);
  assert.equal(await run(['--as', 'navigator'], h), 0);
  const message = h.calls.requests[0].opts.body.message;
  assert.ok(message.startsWith('You are the CodeOps team member "navigator".'));
  assert.ok(message.includes('- 2026-11-15 | a/b | PR ready x | next time: keep the README change to one line'));
  assert.ok(message.includes('\n===== JOB =====\nGitHub task:'));
  assert.ok(message.includes('\nLESSON=<one thing to do differently'));
  assert.ok(h.calls.out.includes('Working as navigator on the computer. Read back 1 lesson.'));
  const lines = team.lessonLines(pc.files[LESSONS]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '- 2026-11-16 | atrislabs/demo | PR ready https://github.com/atrislabs/demo/pull/4 | next time: Check links before editing');
  assert.equal(pc.files[LOG], '- 09:05 CodeOps run on atrislabs/demo: Fix the README -> PR ready https://github.com/atrislabs/demo/pull/4. Read back 1 lesson. Used: kept the change to one line.\n');
});

test('computerPr with no --as on a team computer runs as executor; a failed run still leaves a lesson', async () => {
  const pc = fakeComputer();
  const h = harness('STEP_FAILED=1 NO GITHUB TOKEN\n', pc.io);
  assert.equal(await run([], h), 1);
  assert.ok(h.calls.requests[0].opts.body.message.startsWith('You are the CodeOps team member "executor".'));
  const lesson = team.lessonLines(pc.files['/workspace/atris/team/executor/lessons.md']);
  assert.equal(lesson.length, 1);
  assert.match(lesson[0], /^- 2026-11-16 \| atrislabs\/demo \| failed: Step 1 failed, so no pull request is ready: NO GITHUB TOKEN \| next time: check the GitHub token is set on the computer before sending$/);
});

test('computerPr never overwrites a lessons file it could not read', async () => {
  const pc = fakeComputer();
  pc.io.read = async () => null;
  const h = harness('PR_URL=https://github.com/atrislabs/demo/pull/4\n', pc.io);
  assert.equal(await run(['--as', 'navigator'], h), 0);
  assert.equal(pc.writes.length, 0);
  assert.match(h.calls.err.join('\n'), /Could not save navigator's lesson/);
});

test('computerCodeOpsTeam prints the table and --json from fixture data', async () => {
  const pc = fakeComputer({ [LESSONS]: '- 2026-11-16 | a/b | PR ready x | next time: one line' });
  const out = [];
  const deps = { cloudTeam: pc.io, cards: () => [], mergedLinks: async () => new Set(), log: (s) => out.push(s), now: () => new Date(2026, 10, 16, 12) };
  assert.equal(await computer.computerCodeOpsTeam('tok', {}, [], deps), 0);
  assert.match(out[0], /^CodeOps team, last 7 days/);
  assert.match(out[0], /navigator\s+navigator\s+idle\s+0\s+0\s+0\s+0\s+1\s+2026-11-16 one line/);
  out.length = 0;
  await computer.computerCodeOpsTeam('tok', {}, ['--json'], deps);
  const view = JSON.parse(out[0]);
  assert.equal(view.members.length, 2);
  assert.equal(view.newest_lessons[0].member, 'navigator');
});
