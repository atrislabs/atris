'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  defaultGit,
  guardMissionLanding,
  inspectMissionProtectedDiff,
  matchProtectedMissionDiff,
  prepareMissionGitGuard,
} = require('../lib/mission-protected-lane');
const { runLocalTerminal } = require('../commands/probe');
const { withMissionFullJson } = require('./helpers/mission-json');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function diffFor(file, changedLine) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old value',
    `+${changedLine}`,
    '',
  ].join('\n');
}

test('a clean mission diff reaches the landing callback', () => {
  let landed = false;
  const result = guardMissionLanding({
    readDiff: () => ({ ok: true, diff: diffFor('docs/mission.md', 'plain documentation') }),
    land: () => {
      landed = true;
      return { ok: true, landed: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.landed, true);
  assert.equal(landed, true);
  assert.equal(result.protected_lane_guard.status, 'clear');
});

test('a CSP diff pauses before landing and names the surface', () => {
  let landed = false;
  const result = guardMissionLanding({
    readDiff: () => ({
      ok: true,
      diff: diffFor('app/public/page.tsx', "headers.set('Content-Security-Policy', policy)"),
    }),
    land: () => {
      landed = true;
      return { ok: true, landed: true };
    },
  });

  assert.equal(result.status, 'paused-for-review');
  assert.equal(result.allowed, false);
  assert.equal(landed, false);
  assert.deepEqual(result.surfaces, ['csp']);
  assert.match(result.reason, /csp/);
});

test('an auth-header diff pauses from changed content even on a neutral path', () => {
  const diff = diffFor('lib/request.js', "headers.Authorization = `Bearer ${token}`;");
  const matched = matchProtectedMissionDiff(diff);
  const result = guardMissionLanding({
    readDiff: () => ({ ok: true, diff }),
    land: () => assert.fail('protected auth-header diff must not land'),
  });

  assert.equal(matched.protected, true);
  assert.ok(matched.matches.some((match) => match.surface === 'auth header' && match.signal === 'content'));
  assert.equal(result.status, 'paused-for-review');
  assert.deepEqual(result.surfaces, ['auth header']);
});

test('an unreadable diff fails closed and pauses before landing', () => {
  let landed = false;
  const result = guardMissionLanding({
    readDiff: () => ({ ok: false, detail: 'permission denied' }),
    land: () => {
      landed = true;
      return { ok: true, landed: true };
    },
  });

  assert.equal(result.status, 'paused-for-retry');
  assert.equal(result.allowed, false);
  assert.equal(result.unreadable, true);
  assert.equal(landed, false);
  assert.deepEqual(result.surfaces, ['unreadable diff']);
  assert.match(result.reason, /tooling failure and rerun/);
  assert.match(result.detail, /permission denied/);
});

test('default Git reads fake diff output larger than one megabyte', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-large-diff-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeGit = path.join(root, 'fake-git');
  fs.writeFileSync(
    fakeGit,
    "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024));\n",
    { mode: 0o755 },
  );

  const spawned = defaultGit(fakeGit)(['diff'], root);

  assert.equal(spawned.status, 0, spawned.error?.message);
  assert.equal(spawned.error, undefined);
  assert.ok(Buffer.byteLength(spawned.stdout) > 1024 * 1024);
});

test('a spawn failure pauses for retry while a protected path pauses for review', () => {
  const spawnError = new Error('spawn git EACCES');
  spawnError.code = 'EACCES';
  const unreadable = inspectMissionProtectedDiff({
    includeUnstaged: false,
    git: () => ({ status: null, error: spawnError }),
  });
  const protectedPath = inspectMissionProtectedDiff({
    includeUnstaged: false,
    git: () => ({
      status: 0,
      stdout: diffFor('config/permissions/policy.txt', 'plain value'),
    }),
  });

  assert.equal(unreadable.allowed, false);
  assert.equal(unreadable.unreadable, true);
  assert.equal(unreadable.status, 'paused-for-retry');
  assert.match(unreadable.reason, /tooling failure and rerun/);
  assert.match(unreadable.detail, /spawn git EACCES/);
  assert.equal(protectedPath.allowed, false);
  assert.equal(protectedPath.unreadable, false);
  assert.equal(protectedPath.status, 'paused-for-review');
  assert.match(protectedPath.reason, /human review: permission/);
});

test('a denied task tag pauses even when the changed text looks neutral', () => {
  const result = guardMissionLanding({
    tags: ['security'],
    readDiff: () => ({ ok: true, diff: diffFor('lib/request.js', 'plain value') }),
    land: () => assert.fail('denied mission tag must not land'),
  });

  assert.equal(result.status, 'paused-for-review');
  assert.deepEqual(result.surfaces, ['security']);
  assert.equal(result.matches[0].signal, 'tag');
});

test('the mission Git wrapper lands a clean change and leaves a protected change staged', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-guard-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args, options = {}) => spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['config', 'user.email', 'guard@example.test']).status, 0);
  assert.equal(git(['config', 'user.name', 'Mission Guard Test']).status, 0);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  assert.equal(git(['add', 'README.md']).status, 0);
  assert.equal(git(['commit', '-qm', 'base']).status, 0);
  const guard = prepareMissionGitGuard({ root });
  t.after(() => guard.cleanup());
  const guardedCommit = (message) => {
    const command = `PATH='${guard.pathPrefix}':$PATH; export PATH; git commit -m "${message}"`;
    return spawnSync('sh', ['-lc', command], {
      cwd: root,
      encoding: 'utf8',
      env: guard.env,
    });
  };

  fs.writeFileSync(path.join(root, 'notes.md'), 'clean mission work\n');
  assert.equal(git(['add', 'notes.md']).status, 0);
  const cleanCommit = guardedCommit('clean change');
  assert.equal(cleanCommit.status, 0, cleanCommit.stderr);
  assert.equal(git(['rev-list', '--count', 'HEAD']).stdout.trim(), '2');

  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'csp.js'), "module.exports = 'policy';\n");
  assert.equal(git(['add', 'app/csp.js']).status, 0);
  const committed = guardedCommit('protected change');

  assert.equal(committed.status, 78);
  assert.match(committed.stderr, /protected mission surface requires human review: csp/);
  assert.equal(git(['diff', '--cached', '--quiet']).status, 1);
  assert.equal(git(['rev-list', '--count', 'HEAD']).stdout.trim(), '2');
});

test('a protected mission tick pauses and writes the matched surface to its receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-receipt-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'mission-lead'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Atris\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'mission-lead', 'MEMBER.md'), '# Mission Lead\n');
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(root, '.atris', 'state', 'tasks.db'),
  };
  const run = (args) => spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['config', 'user.email', 'guard@example.test']).status, 0);
  assert.equal(git(['config', 'user.name', 'Mission Guard Test']).status, 0);
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '-qm', 'base']).status, 0);

  const started = run([
    'mission', 'start', 'prove protected mission review',
    '--owner', 'mission-lead',
    '--runner', 'manual',
    '--verify', 'node -e "process.exit(0)"',
    '--json',
  ]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  fs.mkdirSync(path.join(root, 'app', 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', 'public', 'page.js'),
    "headers.set('Content-Security-Policy', policy);\n",
  );
  assert.equal(git(['add', 'app/public/page.js']).status, 0);

  const ticked = run([
    'mission', 'tick', mission.id,
    '--verify',
    '--summary', 'The public page now has a browser policy, pending human review.',
    '--json',
  ]);
  assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
  const payload = JSON.parse(ticked.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, payload.receipt_path), 'utf8'));

  assert.equal(payload.mission.status, 'paused');
  assert.equal(payload.tick.status, 'paused-for-review');
  assert.equal(payload.tick.reason, 'protected-lane-review');
  assert.equal(payload.verifier_result, null);
  assert.deepEqual(receipt.result.tick.protected_lane_guard.surfaces, ['csp']);
  assert.match(receipt.result.tick.protected_lane_guard.reason, /human review: csp/);
  assert.equal(git(['diff', '--cached', '--quiet']).status, 1);
});

test('the Atris2 local relay keeps the mission Git wrapper first on PATH', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-relay-guard-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, '#!/bin/sh\nprintf protected-wrapper\n', { mode: 0o755 });

  const result = await runLocalTerminal('git --version', dir, process.env, dir);

  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(result.stdout, 'protected-wrapper');
});

// Regression: prose that merely *describes* a protected surface must not pause a
// mission. Replaying the guard over 60 real atrisos-web commits, 5 of 6 hits were
// markdown — judge cards, wiki pages, CLAUDE.md — that mentioned "force-dynamic"
// or "nonce" without changing behaviour. A mission writes a judge card every
// tick, so that noise would have made operators switch the guard off.
test('markdown that only mentions a protected surface does not trip the guard', () => {
  const docDiff = [
    'diff --git a/atris/status/for-you.md b/atris/status/for-you.md',
    '--- a/atris/status/for-you.md',
    '+++ b/atris/status/for-you.md',
    '@@ -1,0 +1,3 @@',
    '+- shipped: force-dynamic on /hvac so the page ships with the CSP nonce',
    '+  Content-Security-Policy notes: strict-dynamic blocks nonce-less scripts',
    '+  also mentions Set-Cookie and Access-Control-Allow-Origin in passing',
  ].join('\n');

  const result = matchProtectedMissionDiff(docDiff, { tags: [] });
  assert.equal(result.protected, false);
  assert.deepEqual(result.surfaces, []);
});

test('the same words in a real code file still pause the mission', () => {
  const codeDiff = [
    'diff --git a/app/hvac/page.tsx b/app/hvac/page.tsx',
    '--- a/app/hvac/page.tsx',
    '+++ b/app/hvac/page.tsx',
    '@@ -1,0 +1,1 @@',
    "+export const dynamic = 'force-dynamic';",
  ].join('\n');

  const result = matchProtectedMissionDiff(codeDiff, { tags: [] });
  assert.equal(result.protected, true);
  assert.ok(result.surfaces.includes('public dynamic rendering'));
});

test('a path signal still fires even on a non-code file', () => {
  const pathDiff = [
    'diff --git a/config/csp/report-only.conf b/config/csp/report-only.conf',
    '--- a/config/csp/report-only.conf',
    '+++ b/config/csp/report-only.conf',
    '@@ -1,0 +1,1 @@',
    '+something harmless',
  ].join('\n');

  const result = matchProtectedMissionDiff(pathDiff, { tags: [] });
  assert.equal(result.protected, true);
  assert.ok(result.surfaces.includes('csp'));
});

// The tick-time hold: a mission sitting in a protected lane never fires
// unattended. The worker lands its own diffs, so the only safe stop is
// before the tick starts (CLI-1189).
const { missionProtectedLaneHold } = require('../commands/mission');

test('a mission in a denied lane is held before any tick fires', () => {
  const hold = missionProtectedLaneHold({ lane: 'billing', objective: 'rotate invoices' });
  assert.ok(hold);
  assert.equal(hold.pause_reason, 'protected-lane-billing');
});

test('protected-lane text in the objective holds the mission even in a safe lane', () => {
  const hold = missionProtectedLaneHold({
    lane: 'workspace',
    objective: 'mint a scoped payment authorization and settle the checkout url flow',
  });
  assert.ok(hold, 'sniffed billing terms hold the tick');
});

test('an ordinary workspace mission is not held', () => {
  assert.equal(
    missionProtectedLaneHold({ lane: 'workspace', objective: 'clean stale wiki pages and pin a check' }),
    null,
  );
});

test('an explicit human ack releases the hold', () => {
  const hold = missionProtectedLaneHold({
    lane: 'billing',
    objective: 'rotate invoices',
    metadata: { protected_lane_ack: 'keshav 2026-07-26' },
  });
  assert.equal(hold, null);
});
