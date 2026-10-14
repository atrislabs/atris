'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { githubMergeItems, memberFromBranch, memberReport } = require('../lib/member-report');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const NOW = new Date(2026, 9, 14, 12, 0);
const MEMBERS = ['builder', 'codex', 'codex-executor', 'generalist'];

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 3600e3).toISOString();
}

function pr(number, branch, mergedAt, title = `pull request ${number}`) {
  return { title, headRefName: branch, mergedAt, url: `https://github.com/acme/repo/pull/${number}` };
}

function workspace(t, diaries) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-report-gh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [member, text] of Object.entries(diaries)) {
    const logs = path.join(root, 'atris', 'team', member, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', member, 'MEMBER.md'), `# ${member}\n`);
    if (text) fs.writeFileSync(path.join(logs, '2026-10-14.md'), text);
  }
  return root;
}

test('a branch names its member, and the longest member name wins', () => {
  assert.equal(memberFromBranch('codex/builder-wake-says-jobs-20261014-143131', MEMBERS), 'builder');
  assert.equal(memberFromBranch('codex/codex-executor-second-model-20261014', MEMBERS), 'codex-executor');
  assert.equal(memberFromBranch('codex/codex-fix-thing', MEMBERS), 'codex');
  assert.equal(memberFromBranch('release/members-3.70.0', MEMBERS), null);
  assert.equal(memberFromBranch('builder-no-engine-prefix', MEMBERS), null);
  assert.equal(memberFromBranch('', MEMBERS), null);
});

test('only merges inside the window from a member branch count', () => {
  const since = NOW.getTime() - 24 * 3600e3;
  const items = githubMergeItems([
    pr(1, 'codex/builder-fast-board', hoursAgo(2)),
    pr(2, 'codex/builder-old-work', hoursAgo(30)),
    pr(3, 'release/members-3.70.0', hoursAgo(1)),
    pr(4, 'codex/generalist-cleanup', 'not a time'),
  ], since, MEMBERS);
  assert.deepEqual(items.map((item) => [item.member, item.title]), [['builder', 'pull request 1']]);
  assert.equal(items[0].group, 'merged');
  assert.equal(items[0].link, 'https://github.com/acme/repo/pull/1');
});

test('the report counts GitHub merges a member never wrote down', (t) => {
  const root = workspace(t, { builder: '', generalist: '' });
  const report = memberReport(root, {
    since: '24h',
    now: NOW,
    merges: [
      pr(10, 'codex/builder-fast-board', hoursAgo(3), 'The board opens twice as fast'),
      pr(11, 'codex/generalist-cleanup', hoursAgo(1), 'Old copies get tossed'),
    ],
  });
  assert.equal(report.totals.merged, 2);
  const builder = report.members.find((row) => row.member === 'builder');
  assert.deepEqual(builder.merged, [{ title: 'The board opens twice as fast', link: 'https://github.com/acme/repo/pull/10' }]);
});

test('a merge the diary already logged counts once, even when the titles differ', (t) => {
  const diary = [
    '## 10:00 · Task completed',
    '- title: Stop works for codex members',
    '- action: merged',
    '- proof: its change merged on GitHub: https://github.com/acme/repo/pull/42',
    '',
  ].join('\n');
  const root = workspace(t, { builder: diary });
  const report = memberReport(root, {
    since: '24h',
    now: NOW,
    merges: [pr(42, 'codex/builder-stop-works', hoursAgo(1.5), 'Stop works for codex (pr title)')],
  });
  assert.equal(report.totals.merged, 1);
});

test('atris member report reads merges from gh for real', (t) => {
  const root = workspace(t, { builder: '' });
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const merged = JSON.stringify([
    pr(77, 'codex/builder-nobody-wrote-this-down', new Date(Date.now() - 3600e3).toISOString(), 'Merged but never logged'),
  ]);
  fs.writeFileSync(path.join(fakeBin, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    `  "pr list --state merged"*) printf '%s' '${merged}' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync(process.execPath, [BIN, 'member', 'report', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.totals.merged, 1);
  assert.equal(report.members[0].member, 'builder');
  assert.equal(report.members[0].merged[0].link, 'https://github.com/acme/repo/pull/77');
});
