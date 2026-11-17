'use strict';

// atris land --prs: every open pull request lands in exactly one bucket with
// a reason. Fixtures copy the shape `gh pr list --json ...` returned for the
// three real repos on 2026-11-15 (titles and bodies replaced). The backend
// answered "UNKNOWN" for 103 of 122 open pull requests on the list call; one
// `gh pr view` later the same pull request said MERGEABLE. That lazy answer
// must be asked again and never read as clean.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sweep = require('../lib/pr-sweep');

const NOW = Date.parse('2026-11-15T07:30:00Z');
const OURS = new Set(['owner-account']);
const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function daysAgo(d) {
  return new Date(NOW - d * 24 * 3600 * 1000).toISOString();
}

function check(name, conclusion, at = '2026-11-05T09:31:50Z') {
  return { __typename: 'CheckRun', completedAt: at, conclusion, detailsUrl: 'https://example.invalid/run', name, startedAt: at, status: 'COMPLETED', workflowName: 'CI' };
}

const GREEN = [check('unit (1/8)', 'SUCCESS'), check('unit (2/8)', 'SUCCESS'), check('decks', 'SUCCESS'), check('test', 'SUCCESS')];
const RED = [check('unit (1/8)', 'SUCCESS'), check('unit (4/8)', 'FAILURE'), check('test', 'FAILURE')];

function pr(over = {}) {
  return {
    author: { id: 'MDQ6VXNlcjE=', is_bot: false, login: 'owner-account', name: 'Owner' },
    body: 'Adds a small thing.\n\nTests: test/thing.test.js',
    changedFiles: 2,
    files: [{ path: 'lib/thing.js', additions: 12, deletions: 3 }, { path: 'test/thing.test.js', additions: 30, deletions: 0 }],
    createdAt: daysAgo(12),
    headRefName: 'codex/some-builder-small-thing-20261103-101010',
    headRefOid: '2155ee6ca188dbf7e4618fb8b63836484210f2c9',
    baseRefName: 'master',
    isDraft: false,
    labels: [],
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    number: 1700,
    statusCheckRollup: GREEN,
    title: 'Tests no longer break when the calendar moves',
    updatedAt: daysAgo(10),
    url: 'https://github.com/example/repo/pull/1700',
    ...over,
  };
}

function classify(over) {
  return sweep.classifyPr(pr(over), { now: NOW, ours: OURS, defaultBranch: 'master' });
}

test('merge: ours, not a draft, green on head, merges clean, main branch', () => {
  assert.equal(classify({}).bucket, 'merge');
});

test('merge needs every rule: draft, red, conflict, other base and lazy state all keep it out', () => {
  assert.notEqual(classify({ isDraft: true }).bucket, 'merge');
  assert.notEqual(classify({ statusCheckRollup: RED }).bucket, 'merge');
  assert.notEqual(classify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).bucket, 'merge');
  assert.equal(classify({ baseRefName: 'codex/stacked-base' }).bucket, 'leave');
  assert.equal(classify({ statusCheckRollup: [] }).bucket, 'leave');
  assert.match(classify({ statusCheckRollup: [] }).reason, /no hosted checks/);
  const pending = [{ ...check('test', ''), status: 'IN_PROGRESS', conclusion: '' }];
  assert.equal(classify({ statusCheckRollup: pending }).bucket, 'leave');
});

test('unknown mergeable state is never treated as clean', () => {
  const lazy = classify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.equal(lazy.bucket, 'leave');
  assert.match(lazy.reason, /has not worked out/);
});

test('catch-up: ours, not a draft, touched within 14 days, conflicting or behind', () => {
  const conflict = classify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', updatedAt: daysAgo(10) });
  assert.equal(conflict.bucket, 'catch-up');
  assert.match(conflict.reason, /conflicts with master/);
  assert.equal(classify({ mergeStateStatus: 'BEHIND', updatedAt: daysAgo(4) }).bucket, 'catch-up');
});

test('close: untouched over 7 days and a draft, conflicting past 14 days, or failing', () => {
  const draft = classify({ isDraft: true, updatedAt: daysAgo(8) });
  assert.equal(draft.bucket, 'close');
  assert.equal(draft.why, 'it is a draft');
  const conflict = classify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', updatedAt: daysAgo(20) });
  assert.equal(conflict.bucket, 'close');
  assert.match(conflict.why, /merge conflicts/);
  const red = classify({ statusCheckRollup: RED, mergeStateStatus: 'UNSTABLE', updatedAt: daysAgo(9) });
  assert.equal(red.bucket, 'close');
  assert.match(red.why, /unit \(4\/8\) check failed/);
  // A failing check is known even when the merge state is still lazy.
  assert.equal(classify({ statusCheckRollup: RED, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', updatedAt: daysAgo(9) }).bucket, 'close');
});

test('inside the 7 day window a draft or a red run is left alone', () => {
  assert.equal(classify({ isDraft: true, updatedAt: daysAgo(5) }).bucket, 'leave');
  assert.equal(classify({ statusCheckRollup: RED, updatedAt: daysAgo(5) }).bucket, 'leave');
});

test('owner: protected lanes and outside authors are never touched', () => {
  assert.equal(classify({ author: { login: 'someone-else', is_bot: false } }).bucket, 'owner');
  assert.equal(classify({ title: 'Billing page on named statuses' }).reason, 'sits in the billing lane, a person decides');
  assert.equal(classify({ title: 'Close 7 published dependency security holes' }).bucket, 'owner');
  assert.equal(classify({ title: 'Fix Stripe Connect route precedence', isDraft: true, updatedAt: daysAgo(30) }).bucket, 'owner');
  assert.equal(classify({ title: 'Hero subhead: from $20/mo' }).bucket, 'owner');
  assert.equal(classify({ labels: [{ id: 'L1', name: 'deploy', description: '', color: 'fff' }] }).bucket, 'owner');
  assert.equal(classify({ body: 'protected lane: a human accepts this' }).bucket, 'owner');
  assert.equal(classify({ title: 'HOLD: agent monitoring and invite copying' }).bucket, 'owner');
  assert.equal(classify({ title: 'Do not merge yet: move stray values' }).bucket, 'owner');
  assert.equal(classify({ labels: [{ name: 'do-not-merge' }] }).bucket, 'owner');
});

// The hold labels the backend really carries (gh label list, 2026-11-15):
// jev-hold "Jev held this for the owner", needs-human "a person has to read it",
// plus codex-reject and needs-review. Backend 5126 and 5133 are open with jev-hold.
test('owner: the hold labels the repos really use keep a pull request for a person', () => {
  for (const name of ['jev-hold', 'needs-human', 'codex-reject', 'needs-review', 'Needs_Human', 'decision']) {
    const label = [{ id: 'LA_1', name, description: '', color: 'FBCA04' }];
    const green = classify({ labels: label, title: 'night shift 2026-11-10: replayed bounced texts now get the same formatting', headRefName: 'night/20261110-031647-0' });
    assert.equal(green.bucket, 'owner', `${name} on a green clean row`);
    assert.match(green.reason, /a person decides/);
    assert.equal(classify({ labels: label, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', updatedAt: daysAgo(20) }).bucket, 'owner', `${name} once it conflicts`);
    assert.equal(classify({ labels: label, isDraft: true, updatedAt: daysAgo(8) }).bucket, 'owner', `${name} on an idle draft`);
  }
});

// protectedLaneOf only sniffs lane words when the tag is empty, so passing the
// labels as the tag used to switch the word check off for any labeled row.
test('owner: adding any label never switches off the protected word check', () => {
  const titles = [
    'Rotate the api key for the mail sender',
    'Add bank transfer export',
    'Tax form download',
    'Fix csrf check on login',
    'Send email to every signed up user',
    'Add credit card form',
  ];
  for (const title of titles) {
    assert.equal(classify({ title }).bucket, 'owner', `${title} with no label`);
    for (const name of ['enhancement', 'bug', sweep.CATCH_UP_LABEL, 'low-risk']) {
      assert.equal(classify({ title, labels: [{ name }] }).bucket, 'owner', `${title} labeled ${name}`);
    }
  }
});

// Titles and branches shaped like real open ones (2026-11-15), money or sign-in work
// that used to be sorted into merge, catch-up or close.
test('owner: plain money and sign-in language in the title or branch is a protected lane', () => {
  const real = [
    ['Agents can quote a job and get paid, with the owner approving once', 'agent-quote-get-paid'],
    ['Group chat buys products for people through a shop partner, with a service fee', 'feat/group-shop-20260924'],
    ['Make paid Apps access atomic and safe to retry', 'codex/apps-paid-access-20260912'],
    ['Add private Apps viewer state and read-only paid access', 'codex/apps-viewer-state-20260912'],
    ['Share OAuth sign-in sessions across instances', 'codex/plugin-oauth-session-20261103'],
    ['Prepare scoped private browser sign-in release', 'codex/rqs-private-login-web-release-20261105'],
    ['Prepare private sign-in on current live web', 'codex/rqs-private-login-web-live-6427-20261105'],
    ['Let every Atris iPhone app sign in with Apple', 'codex/claude-accept-a-list-of-iphone-app-ids-for-20261106-055152'],
  ];
  for (const [title, headRefName] of real) {
    assert.equal(classify({ title, headRefName }).bucket, 'owner', `${title} green and clean`);
    assert.equal(classify({ title, headRefName, isDraft: true, updatedAt: daysAgo(30) }).bucket, 'owner', `${title} as an idle draft`);
  }
  // Ordinary work that only brushes a short word is not held.
  assert.equal(classify({ title: 'Payload trimming for the feed list', headRefName: 'codex/payload-trim' }).bucket, 'merge');
});

test('owner: changed files in a protected lane hold it, whatever the title says', () => {
  const files = (paths) => ({ files: paths.map((p) => ({ path: p, additions: 4, deletions: 1 })), changedFiles: paths.length });
  for (const paths of [
    ['backend/routers/billing.py'],
    ['app/api/stripe/webhook/route.ts'],
    ['backend/services/wallet_service.py'],
    ['app/auth/callback/route.ts'],
    ['middleware.ts'],
    ['backend/migrations/versions/20261110_add_column.py'],
    ['.github/workflows/deploy.yml'],
    ['render.yaml'],
  ]) {
    const got = classify({ title: 'Tidy the dashboard list', ...files(['lib/thing.js', ...paths]) });
    assert.equal(got.bucket, 'owner', paths[0]);
    assert.match(got.reason, /changes .* a person decides/);
  }
});

test('merge needs the full list of changed files', () => {
  // GitHub lists at most 100 files per pull request; backend 4592 changes 103.
  const many = Array.from({ length: 100 }, (_, i) => ({ path: `lib/part-${i}.js`, additions: 1, deletions: 0 }));
  const cut = classify({ files: many, changedFiles: 103 });
  assert.equal(cut.bucket, 'leave');
  assert.match(cut.reason, /changed files/);
  assert.equal(classify({ files: undefined, changedFiles: undefined }).bucket, 'leave');
});

// atrisos-web runs no hosted tests on most pull requests: the only checks are
// the Vercel status and Vercel Preview Comments (web 1009 and 562, 2026-11-15).
test('merge needs a real test check: a deploy preview or skipped checks are not green', () => {
  const vercel = [
    { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', startedAt: '2026-11-12T06:31:00Z', targetUrl: 'https://example.invalid' },
    check('Vercel Preview Comments', 'SUCCESS'),
  ];
  const preview = classify({ statusCheckRollup: vercel });
  assert.equal(preview.bucket, 'leave');
  assert.match(preview.reason, /no hosted tests/);
  const skipped = [check('fast-tests', 'SKIPPED'), check('focused', 'SKIPPED')];
  assert.equal(classify({ statusCheckRollup: skipped }).bucket, 'leave');
  assert.match(classify({ statusCheckRollup: skipped }).reason, /no hosted tests/);
  // A real test run next to the preview is green.
  assert.equal(classify({ statusCheckRollup: [...vercel, check('Test · Type-check · Build', 'SUCCESS')] }).bucket, 'merge');
  assert.equal(classify({ statusCheckRollup: [check('fast-tests', 'SKIPPED'), check('linux-container-boundary', 'SUCCESS')] }).bucket, 'merge');
});

test('leave: anything touched in the last 48 hours, even when green', () => {
  const fresh = classify({ updatedAt: new Date(NOW - 22 * 3600 * 1000).toISOString() });
  assert.equal(fresh.bucket, 'leave');
  assert.match(fresh.reason, /22 hours ago, may be live work/);
  assert.equal(classify({ isDraft: true, mergeable: 'CONFLICTING', updatedAt: new Date(NOW - 47 * 3600 * 1000).toISOString() }).bucket, 'leave');
});

test('our accounts come from merged authors with at least two merges', () => {
  const merged = [
    ...Array.from({ length: 5 }, () => ({ author: { login: 'owner-account', is_bot: false } })),
    { author: { login: 'app/helper-bot', is_bot: true } },
    { author: { login: 'app/helper-bot', is_bot: true } },
    { author: { login: 'one-time-visitor', is_bot: false } },
  ];
  const got = sweep.deriveOurs(merged);
  assert.deepEqual(got.ours.map((a) => a.login), ['owner-account', 'app/helper-bot']);
  assert.equal(got.ours[1].bot, true);
  assert.deepEqual(got.skipped.map((a) => a.login), ['one-time-visitor']);
  assert.equal(got.sampled, 8);
});

// A fake gh that answers like the real one and records every call.
function fakeGh({ open, merged = [{ author: { login: 'owner-account' } }, { author: { login: 'owner-account' } }], views = {} }) {
  const calls = [];
  const asked = {};
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const j = args.join(' ');
    const ok = (obj) => ({ status: 0, stdout: `${JSON.stringify(obj)}\n`, stderr: '' });
    if (j.startsWith('repo view')) return ok({ defaultBranchRef: { name: 'master' }, nameWithOwner: 'example/repo' });
    if (j.startsWith('pr list') && j.includes('--state merged')) return ok(merged);
    if (j.startsWith('pr list') && j.includes('--state open')) return ok(open);
    if (j.startsWith('pr view')) {
      const n = args[2];
      asked[n] = (asked[n] || 0) + 1;
      const answers = views[n] || [];
      const answer = answers[Math.min(asked[n], answers.length) - 1];
      if (j.includes('--json state')) return ok({ state: 'MERGED' });
      return ok(answer || { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', headRefOid: '2155ee6ca188dbf7e4618fb8b63836484210f2c9' });
    }
    if (j.startsWith('pr merge') || j.startsWith('pr close') || j.startsWith('pr edit') || j.startsWith('label create')) return ok({});
    return { status: 1, stdout: '', stderr: `unexpected gh call: ${j}` };
  };
  return { run, calls, asked };
}

test('a lazy unknown is asked again and sorted on the fresh answer', () => {
  const lazy = pr({ number: 5477, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  const gh = fakeGh({ open: [lazy], views: { 5477: [{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: lazy.headRefOid }] } });
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: () => {}, now: NOW });
  assert.equal(gh.asked[5477], 1);
  assert.equal(report.entries[0].bucket, 'merge');
  assert.equal(report.counts.merge, 1);
});

test('an unknown that stays unknown is asked three times, then left', () => {
  const lazy = pr({ number: 5478, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  const gh = fakeGh({ open: [lazy] });
  const waits = [];
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: (ms) => waits.push(ms), now: NOW });
  assert.equal(gh.asked[5478], 3);
  assert.equal(waits.length, 2);
  assert.equal(report.entries[0].bucket, 'leave');
});

test('a push between the list and the second ask leaves it for the next run', () => {
  const lazy = pr({ number: 5479, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  const gh = fakeGh({ open: [lazy], views: { 5479: [{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'ffffffffffffffffffffffffffffffffffffffff' }] } });
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: () => {}, now: NOW });
  assert.equal(report.entries[0].bucket, 'leave');
  assert.match(report.entries[0].reason, /new push/);
});

test('drafts and live work are not asked again, the answer cannot change their bucket', () => {
  const open = [
    pr({ number: 1, isDraft: true, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', updatedAt: daysAgo(30) }),
    pr({ number: 2, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', updatedAt: daysAgo(1) }),
  ];
  const gh = fakeGh({ open });
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: () => {}, now: NOW });
  assert.deepEqual(gh.asked, {});
  assert.deepEqual(report.entries.map((e) => e.bucket), ['close', 'leave']);
});

test('dry run changes nothing; apply merges, labels and closes, and never deletes a branch', () => {
  const open = [
    pr({ number: 10 }),
    pr({ number: 11, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', updatedAt: daysAgo(9) }),
    pr({ number: 12, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', updatedAt: daysAgo(9), labels: [{ name: sweep.CATCH_UP_LABEL }] }),
    pr({ number: 13, isDraft: true, updatedAt: daysAgo(40) }),
    pr({ number: 14, title: 'Refund credits when a run fails', updatedAt: daysAgo(40), isDraft: true }),
  ];
  const gh = fakeGh({ open });
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: () => {}, now: NOW });
  const writes = (calls) => calls.filter((c) => /^(merge|close|edit)$/.test(c[2]) || c[1] === 'label');
  assert.deepEqual(writes(gh.calls), [], 'the sort alone writes nothing');

  const done = sweep.applySweep(report, { run: gh.run, wait: () => {} });
  const w = writes(gh.calls).map((c) => c.slice(1));
  const merge = w.find((c) => c[1] === 'merge');
  assert.deepEqual(merge, ['pr', 'merge', '10', '--repo', 'example/repo', '--merge', '--match-head-commit', '2155ee6ca188dbf7e4618fb8b63836484210f2c9']);
  assert.ok(w.some((c) => c[1] === 'edit' && c[2] === '11' && c.includes('--add-label')));
  assert.ok(!w.some((c) => c[1] === 'edit' && c[2] === '12'), 'already labeled is not labeled again');
  const close = w.find((c) => c[1] === 'close');
  assert.equal(close[2], '13');
  assert.ok(!w.some((c) => c[2] === '14'), 'a protected lane is never touched');
  assert.ok(!gh.calls.some((c) => c.includes('--delete-branch')), 'never delete a branch');
  const comment = close[close.indexOf('--comment') + 1];
  assert.match(comment, /no activity for 40 days and it is a draft/);
  assert.match(comment, /the branch is kept/);
  assert.doesNotMatch(comment, /@/);
  assert.doesNotMatch(comment, new RegExp(String.fromCharCode(0x2014)));
  assert.ok(done.actions.every((a) => a.ok));
  assert.equal(done.applied, true);
});

test('the printed sort names our accounts, the counts and the oldest rows, in lowercase', () => {
  const open = [pr({ number: 20 }), pr({ number: 21, isDraft: true, updatedAt: daysAgo(30) })];
  const gh = fakeGh({ open });
  const report = sweep.sweepRepo({ repo: 'example/repo', run: gh.run, wait: () => {}, now: NOW });
  const lines = sweep.formatSweep(report);
  assert.match(lines[0], /^pull request sweep: example\/repo, dry run, nothing changes$/);
  assert.match(lines[1], /our accounts \(2 or more of the last 2 merged pull requests\): owner-account \(2\)/);
  assert.match(lines[2], /2 open: merge 1, catch-up 0, close 1, owner 0, leave 0/);
  for (const line of lines) {
    const ours = line.replace(/#\d+\s+\d+d\s+.*?\s+:/, '');
    assert.equal(ours, ours.toLowerCase());
  }
});

// The command reads the real clock, so the fixture is dated from the clock the
// child process will see. It runs once today and once with the child's clock
// a month ahead, so a fixture pinned to one calendar day fails here at once
// instead of turning the hosted run red the next morning.
test('atris land --prs runs a dry run against gh on the path, on any day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pr-sweep-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'calls.log');
    const data = path.join(dir, 'open.json');
    const shift = path.join(dir, 'shift-clock.js');
    fs.writeFileSync(shift, 'const real = Date.now; const add = Number(process.env.ATRIS_TEST_CLOCK_SHIFT_MS || 0); Date.now = () => real() + add;\n');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');
const j = a.join(' ');
if (j.startsWith('repo view')) { console.log(JSON.stringify({ nameWithOwner: 'example/repo', defaultBranchRef: { name: 'master' } })); process.exit(0); }
if (j.includes('--state merged')) { console.log(JSON.stringify([{ author: { login: 'owner-account' } }, { author: { login: 'owner-account' } }])); process.exit(0); }
if (j.includes('--state open')) { process.stdout.write(fs.readFileSync(${JSON.stringify(data)}, 'utf8')); process.exit(0); }
process.stderr.write('unexpected ' + j); process.exit(1);
`, { mode: 0o755 });
    for (const aheadMs of [0, 30 * 24 * 3600 * 1000]) {
      const childNow = Date.now() + aheadMs;
      // Three and a half days idle, so a run that crosses midnight still says 3d.
      fs.writeFileSync(data, JSON.stringify([pr({ number: 30, updatedAt: new Date(childNow - 3.5 * 24 * 3600 * 1000).toISOString() })]));
      fs.writeFileSync(log, '');
      const res = spawnSync(process.execPath, ['--require', shift, cliPath, 'land', '--prs', '--repo', 'example/repo'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ATRIS_TEST_CLOCK_SHIFT_MS: String(aheadMs), PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /1 open: merge 1/);
      assert.match(res.stdout, /#30\s+3d/, `clock ${aheadMs}ms ahead`);
      assert.match(res.stdout, /next: atris land --prs --repo example\/repo --apply/);
      const calls = fs.readFileSync(log, 'utf8');
      assert.doesNotMatch(calls, /pr (merge|close|edit)/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
