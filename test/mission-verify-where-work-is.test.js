'use strict';

// Live 2026-10-22, mission #266 "launch try page": the builder merged its
// work to master from its own branch (PR #1479), but the mission had no
// worktree, so its check `node --test test/try-repo.test.js` ran in the main
// folder. That folder sat on an old branch without the test file, the check
// failed twice ("Could not find 'test/try-repo.test.js'"), and the mission
// paused on consecutive-verifier-fails although the work was merged.
//
// The mission's check has to run where the work is. When the run left
// nothing in the shared folder, the work is not there, so the check runs in
// a throwaway copy of the merged main line. When the run did change the
// shared folder, the work is there, and the check stays there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
const VERIFY = 'node --test test/try-repo.test.js';
const CALLER_ENV = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

// origin holds master with the merged try page test. The main folder is a
// clone parked on an older branch that never had it, and it has not fetched
// since the merge, the same as the live checkout.
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-where-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const builder = path.join(base, 'builder');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const dir of [root, home, bin]) fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);

  const memberDir = path.join(root, 'atris', 'team', 'builder');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n\n# builder\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 'test@atris.dev']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', 'origin', 'master']);
  git(root, ['fetch', '-q', 'origin']);
  git(root, ['checkout', '-q', '-b', 'member/orb-bench-engines']);

  // The builder's own copy: it adds the try page test and merges it to master.
  spawnSync('git', ['clone', '-q', origin, builder]);
  git(builder, ['config', 'user.email', 'test@atris.dev']);
  git(builder, ['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(builder, 'test'), { recursive: true });
  fs.writeFileSync(path.join(builder, 'test', 'try-repo.test.js'),
    "const test = require('node:test');\ntest('try page maps a repo', () => {});\n");
  git(builder, ['add', '.']);
  git(builder, ['commit', '-qm', 'try page']);
  git(builder, ['push', '-q', 'origin', 'HEAD:master']);

  fs.writeFileSync(path.join(home, 'roster.md'), '# roster\n\n## build\n- claude code, model: opus 5.5\n');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages --model"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
    'if [ -n "$ATRIS_TEST_WORK" ]; then sh -c "$ATRIS_TEST_WORK"; fi',
    'echo \'{"type":"result","is_error":false,"result":"The try page is merged into the main line."}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return { base, root, home, bin, origin };
}

function runCli(ctx, args, env = {}) {
  const clean = scrubAgentEnv(process.env);
  for (const name of CALLER_ENV) delete clean[name];
  // A nested `node --test` under the test runner skips its files and exits 0;
  // the check under test must really run.
  delete clean.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...clean,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      HOME: ctx.home,
      ATRIS_TASKS_DB: path.join(ctx.base, 'tasks.db'),
      ATRIS_MACHINE_ROSTER_PATH: path.join(ctx.home, 'roster.json'),
      ATRIS_MACHINE_ROSTER_MD_PATH: path.join(ctx.home, 'roster.md'),
      ATRIS_ROSTER_SESSIONS_DIR: path.join(ctx.home, 'roster-sessions'),
      PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(ctx) {
  const started = runCli(ctx, ['mission', 'start', 'launch try page', '--owner', 'builder',
    '--runner', 'claude', '--verify', VERIFY, '--json']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  assert.ok(!mission.worktree && !mission.worktree_root, 'the live mission had no worktree of its own');
  return mission;
}

function lastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines.slice(i).join('\n')); } catch {}
  }
  return null;
}

test('a merged job is checked on the merged main line, not on the stale main folder', (t) => {
  const ctx = setup(t);
  assert.equal(fs.existsSync(path.join(ctx.root, 'test', 'try-repo.test.js')), false, 'the main folder lacks the test, like the live checkout');
  const mission = startMission(ctx);

  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  const tick = payload.ticks[0];
  assert.equal(tick.verifier_passed, true, JSON.stringify(payload.mission.verifier_result || tick, null, 2));
  const result = payload.mission.verifier_result;
  assert.equal(result.passed, true);
  assert.equal(result.code_source, 'origin/master');
  assert.equal(result.code_sha, git(ctx.origin, ['rev-parse', 'master']));
  assert.match(result.ran_in, /throwaway copy of origin\/master/);
  assert.equal(result.shared_checkout.passed, false, 'the main folder run is kept as evidence');
  assert.notEqual(payload.mission.stop_reason, 'consecutive-verifier-fails');
  // The main folder is left as it was: same branch, no stray copy.
  assert.equal(git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'member/orb-bench-engines');
  assert.equal(fs.existsSync(path.join(ctx.root, 'test', 'try-repo.test.js')), false);
  assert.equal(git(ctx.root, ['worktree', 'list']).split('\n').length, 1, 'the throwaway copy is removed');
});

test('when the run changed the main folder, the check stays where that work is', (t) => {
  const ctx = setup(t);
  const mission = startMission(ctx);
  // The worker writes in the shared folder, so the work is here, and a green
  // main line must not stand in for it.
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json'],
    { ATRIS_TEST_WORK: 'printf "draft\\n" > try-notes.md' });
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, false);
  const result = payload.mission.verifier_result;
  assert.equal(result.passed, false);
  assert.equal(result.code_source, undefined);
  assert.match(result.stderr, /Could not find/);
});

// Codex review of #1483, P1: a file already dirty when the mission started
// can be broken again without a new dirty path. Any change to it means the
// work is here, so the check stays here.
test('a file dirty at the start and changed again keeps the check here', (t) => {
  const ctx = setup(t);
  fs.appendFileSync(path.join(ctx.root, 'README.md'), 'local note\n');
  const mission = startMission(ctx);
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json'],
    { ATRIS_TEST_WORK: 'printf "broken\\n" >> README.md' });
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, false);
  assert.equal(payload.mission.verifier_result.code_source, undefined);
});

test('a file dirty at the start and left alone still lets the merged main line judge', (t) => {
  const ctx = setup(t);
  fs.appendFileSync(path.join(ctx.root, 'README.md'), 'local note\n');
  const mission = startMission(ctx);
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, true, JSON.stringify(payload.mission.verifier_result));
  assert.equal(payload.mission.verifier_result.code_source, 'origin/master');
});

// Codex review of #1483, P2: when the fetch fails, the cached origin/master
// may be old, so it must not stand in; the local result stands.
test('a failed fetch keeps the local result', (t) => {
  const ctx = setup(t);
  // The main folder saw the merge once, so its cached origin/master has the test.
  git(ctx.root, ['fetch', '-q', 'origin']);
  fs.renameSync(ctx.origin, `${ctx.origin}.gone`);
  t.after(() => { try { fs.renameSync(`${ctx.origin}.gone`, ctx.origin); } catch {} });
  const mission = startMission(ctx);
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, false);
  assert.equal(payload.mission.verifier_result.code_source, undefined);
  assert.match(payload.mission.verifier_result.stderr, /Could not find/);
});

// Codex review round 2 on #1483, P2: making a dirty file executable is a
// change too.
test('a file dirty at the start made executable keeps the check here', (t) => {
  const ctx = setup(t);
  fs.appendFileSync(path.join(ctx.root, 'README.md'), 'local note\n');
  const mission = startMission(ctx);
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json'],
    { ATRIS_TEST_WORK: 'chmod +x README.md' });
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, false);
  assert.equal(payload.mission.verifier_result.code_source, undefined);
});

// Codex review round 2 on #1483, P2: with a narrow fetch refspec a fetch
// succeeds but only FETCH_HEAD moves; the cached origin/master stays old.
// The check must run on what the fetch actually brought.
test('a narrow fetch refspec still checks the fresh main line, not the cached one', (t) => {
  const ctx = setup(t);
  git(ctx.root, ['config', 'remote.origin.fetch', '+refs/heads/nothing:refs/remotes/origin/nothing']);
  const cachedBefore = git(ctx.root, ['rev-parse', 'refs/remotes/origin/master']);
  assert.notEqual(cachedBefore, git(ctx.origin, ['rev-parse', 'master']), 'the cache is behind the merge');
  const mission = startMission(ctx);
  const res = runCli(ctx, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
  const payload = lastJson(res.stdout);
  assert.ok(payload, res.stderr || res.stdout);
  assert.equal(payload.ticks[0].verifier_passed, true, JSON.stringify(payload.mission.verifier_result));
  assert.equal(payload.mission.verifier_result.code_sha, git(ctx.origin, ['rev-parse', 'master']));
});
