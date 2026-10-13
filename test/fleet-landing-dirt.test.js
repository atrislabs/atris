'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runDispatchFlight, landArrival } = require('../lib/fleet');
const { createAgentWorktree } = require('../commands/worktree');

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-dirt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args, cwd = root) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=master']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\nignored.txt\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { dir, root, git, worktree: path.join(dir, 'worker') };
}

test('dispatch waits for engine closure and leaves committed work ready with only run receipts', async (t) => {
  const { dir, root, worktree } = room(t);
  const engine = path.join(dir, 'engine.cjs');
  fs.writeFileSync(engine, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
console.log('built the change');
setTimeout(() => {
  fs.writeFileSync('source.txt', 'built\\n');
  for (const args of [['add', 'source.txt'], ['commit', '-qm', 'built']]) {
    const run = spawnSync('git', args);
    if (run.status !== 0) process.exit(1);
  }
  fs.mkdirSync('atris/runs', { recursive: true });
  fs.writeFileSync('atris/runs/task-proof-2026.json', '{}');
  fs.writeFileSync('atris/runs/dispatch-2026.live.log', 'done');
  fs.writeFileSync('ignored.txt', 'ignored');
}, 150);
`);
  const saved = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = `'${process.execPath}' '${engine}'`;
  t.after(() => {
    if (saved === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = saved;
  });
  const cli = (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify({ display_id: 'CLI-900', title: 'Build the source', status: 'open' }), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') {
      createAgentWorktree({ root, agent: 'tester', task: 'receipt build', path: worktree, base: 'HEAD' });
      return { status: 0, stdout: `next: cd ${worktree}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  let verified = false;
  const flight = await runDispatchFlight({
    root, taskIds: ['CLI-900'], engine: 'cursor', ownCli: cli, scoutAsk: false, log: () => {},
    verifier: (_check, cwd) => {
      assert.equal(fs.readFileSync(path.join(cwd, 'source.txt'), 'utf8'), 'built\n');
      assert.equal(fs.existsSync(path.join(cwd, 'atris/runs/task-proof-2026.json')), true);
      verified = true;
      return { status: 0, stdout: 'verified', stderr: '' };
    },
  });
  assert.equal(verified, true, JSON.stringify(flight.paused));
  assert.equal(flight.ready.length, 1, JSON.stringify(flight.paused));
  assert.deepEqual(flight.paused, []);
  const guard = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'guard'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stderr);
  const shipped = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'ship', '--local', '--no-pr', '--no-map-refresh', '--target', 'master', '--merge', '--verify', 'node -e "process.exit(0)"'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'built\n');
  assert.equal(fs.existsSync(path.join(root, 'atris/runs/task-proof-2026.json')), false, 'run receipts never enter the shipped commit');
});

test('real landing ignores generated files but stops for untracked, unstaged, or staged source', (t) => {
  const { dir, root, worktree, git } = room(t);
  const origin = path.join(dir, 'origin.git');
  git(['init', '--bare', '-q', '--initial-branch=master', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'master']);
  git(['worktree', 'add', '-qb', 'worker', worktree, 'HEAD']);
  fs.mkdirSync(path.join(worktree, 'atris/runs'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'atris/runs/task-proof-2026.json'), '{}');
  fs.writeFileSync(path.join(worktree, 'ignored.txt'), 'ignored');
  assert.deepEqual(landArrival({ worktreePath: worktree }), { ok: true, stage: 'rebased' });
  git(['add', 'atris/runs/task-proof-2026.json'], worktree);
  git(['commit', '-qm', 'tracked receipt'], worktree);
  fs.writeFileSync(path.join(worktree, 'atris/runs/task-proof-2026.json'), '{"changed":true}');
  assert.deepEqual(landArrival({ worktreePath: worktree }), { ok: false, stage: 'dirty_worktree', dirty: ['atris/runs/task-proof-2026.json'] });
  fs.writeFileSync(path.join(worktree, 'atris/runs/task-proof-2026.json'), '{}');
  fs.writeFileSync(path.join(worktree, 'new-source.txt'), 'real work');
  assert.deepEqual(landArrival({ worktreePath: worktree }), { ok: false, stage: 'dirty_worktree', dirty: ['new-source.txt'] });
  fs.unlinkSync(path.join(worktree, 'new-source.txt'));
  fs.writeFileSync(path.join(worktree, 'source.txt'), 'uncommitted');
  for (const staged of [false, true]) {
    if (staged) git(['add', 'source.txt'], worktree);
    assert.deepEqual(landArrival({ worktreePath: worktree }), { ok: false, stage: 'dirty_worktree', dirty: ['source.txt'] });
  }
});

test('a failed rebase with no source dirt retains the actual error', () => {
  const result = landArrival({ worktreePath: '/unused', git: (args) => ({
    status: args[0] === 'rebase' ? 1 : 0,
    stdout: args[0] === 'status' ? '?? atris/runs/task-proof-2026.json\n' : '',
    stderr: args[0] === 'rebase' ? 'invalid upstream origin/master' : '',
  }) });
  assert.equal(result.stage, 'rebase_failed');
  assert.equal(result.detail, 'invalid upstream origin/master');
});
