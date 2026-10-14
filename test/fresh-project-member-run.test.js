'use strict';

// A brand new project, set up with `atris init --yes`, runs one member job
// start to finish: the job gets its own checkout, the engine does and commits
// the work, the check passes, a receipt lands, and the member diary reads clean.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function freshProject(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fresh-member-run-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  // Stand-in engines: claude does the work and commits it like a real builder; codex reviews.
  fs.writeFileSync(path.join(binDir, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'echo "done" > work.txt',
    'git add work.txt >/dev/null 2>&1 && git commit -qm "write work.txt" >/dev/null 2>&1',
    'echo \'{"type":"result","is_error":false,"result":"wrote work.txt"}\'',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\necho "VERDICT: PASS"\n', 'utf8');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);
  const env = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  };
  const git = (args, cwd = root) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const atris = (args, timeout = 60000) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root, encoding: 'utf8', timeout, env,
  });
  git(['init', '-q', '-b', 'master']);
  return { root, git, atris };
}

test('a brand new project runs a member job from start to finish', (t) => {
  const { root, git, atris } = freshProject(t);

  const init = atris(['init', '--yes'], 30000);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md')), 'init should seed an executor member');
  git(['add', '-A']);
  git(['commit', '-qm', 'atris init']);

  const run = atris([
    'member', 'run', 'executor', 'Write work.txt',
    '--engine', 'claude', '--referee-engine', 'codex',
    '--verify', 'test -s work.txt', '--json',
  ]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'ready');
  const tick = payload.ticks[0];
  assert.equal(tick.status, 'ran');
  assert.equal(tick.verifier_passed, true);

  // The work happened in the job's own checkout and was saved on its branch.
  const wt = payload.worktree;
  assert.ok(wt && wt.path && wt.branch, 'the job should run in its own checkout');
  assert.ok(!fs.existsSync(path.join(root, 'work.txt')), 'the main checkout stays untouched');
  assert.equal(git(['show', `${wt.branch}:work.txt`]), 'done');

  // A receipt was written for the run.
  const receipt = payload.work_step && payload.work_step.receipt_path;
  assert.ok(receipt, 'the run should name its receipt');
  assert.ok(fs.existsSync(path.join(wt.path, receipt)) || fs.existsSync(path.join(root, receipt)), `receipt missing: ${receipt}`);

  // The member diary reads clean: every entry starts on its own line.
  const logsDir = path.join(root, 'atris', 'team', 'executor', 'logs');
  const diary = fs.readdirSync(logsDir).map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8')).join('\n');
  assert.match(diary, /^## \d\d:\d\d · Mission started$/m);
  assert.match(diary, /^## \d\d:\d\d · Mission run tick 1$/m);
  assert.doesNotMatch(diary, /[^\n]## \d\d:\d\d · /, 'a diary entry got glued onto the previous line');
});
