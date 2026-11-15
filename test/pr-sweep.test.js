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

test('atris land --prs runs a dry run against gh on the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pr-sweep-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'calls.log');
    const data = path.join(dir, 'open.json');
    fs.writeFileSync(data, JSON.stringify([pr({ number: 30, updatedAt: daysAgo(3) })]));
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
    const res = spawnSync(process.execPath, [cliPath, 'land', '--prs', '--repo', 'example/repo'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 open: merge 1/);
    assert.match(res.stdout, /#30\s+3d/);
    assert.match(res.stdout, /next: atris land --prs --repo example\/repo --apply/);
    const calls = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /pr (merge|close|edit)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
