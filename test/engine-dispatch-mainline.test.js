'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fleet = require('../lib/fleet');
const { createAgentWorktree, defaultMainlineBase } = require('../commands/worktree');
const { collectBoard } = require('../commands/land');
const { dispatchCodexFlight } = require('../lib/codex-flight');
const cliPath = path.resolve(__dirname, '../bin/atris.js');

function room(t, branch = 'main') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mainline-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args, cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=' + branch]);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\natris/runs/\n');
  fs.writeFileSync(path.join(root, 'result.txt'), 'before\n');
  fs.writeFileSync(path.join(root, 'check.test.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt', 'utf8'), 'after\\n');\n");
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const origin = path.join(dir, 'origin.git');
  git(['init', '--bare', '-q', '--initial-branch=' + branch, origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', branch]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + branch]);
  return { dir, root, origin, git, branch, worktree: path.join(dir, 'worker') };
}

function withEngine(t, dir, source) {
  const engine = path.join(dir, 'engine.cjs');
  fs.writeFileSync(engine, source);
  const saved = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = `'${process.execPath}' '${engine}'`;
  t.after(() => {
    if (saved === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = saved;
  });
}

const TASK = { display_id: 'CLI-900', status: 'open', tag: 'code', title: 'Correct result.txt. Done: result is after. Check: node --test check.test.cjs.' };

function flightCli(setup, calls) {
  return (args, cwd = setup.root) => {
    calls.push(args);
    if (args[0] === 'task') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') {
      createAgentWorktree({ root: setup.root, agent: 'tester', task: 'result', path: setup.worktree, base: args[args.indexOf('--base') + 1] });
      return { status: 0, stdout: `next: cd ${setup.worktree}\n`, stderr: '' };
    }
    // Exercise the real ship gate and real merge, with a disposable local remote.
    return spawnSync(process.execPath, [cliPath, ...args, '--local', '--no-pr', '--no-map-refresh'], {
      cwd, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ATRIS_TASKS_DB: path.join(setup.dir, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
  };
}

for (const mode of ['dispatch', 'fleet']) {
  for (const branch of ['main', 'trunk']) {
    test(`${mode} builds, rebases, verifies and ships on ${branch}`, async (t) => {
      const setup = room(t, branch);
      withEngine(t, setup.dir, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync('result.txt', 'after\\n');
for (const args of [['add', 'result.txt'], ['commit', '-qm', 'correct the result']]) {
  const run = spawnSync('git', args);
  if (run.status !== 0) process.exit(1);
}
console.log('saved the result');
`);
      fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
      fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
      const calls = [];
      const options = { root: setup.root, ownCli: flightCli(setup, calls), scoutAsk: false, log: () => {} };
      const flight = mode === 'dispatch'
        ? await fleet.runDispatchFlight({ ...options, taskIds: [TASK.display_id], engine: 'cursor', installedEngines: [] })
        : await fleet.runFleetFlight({ ...options, engines: ['cursor'], guardCliLink: () => ({ ok: true }) });
      assert.deepEqual(flight.paused, [], JSON.stringify(flight.paused));
      assert.equal(flight.landed.length, 1);
      assert.equal(fs.readFileSync(path.join(setup.root, 'result.txt'), 'utf8'), 'after\n');
      for (const [verb, flag] of [['start', '--base'], ['ship', '--target']]) {
        const call = calls.find(args => args[0] === 'worktree' && args[1] === verb);
        assert.equal(call[call.indexOf(flag) + 1], 'origin/' + branch);
      }
      assert.equal(collectBoard(setup.root).base, 'origin/' + branch);
    });
  }
}

for (const mode of ['dispatch', 'fleet']) {
  for (const [stream, status, sentence] of [
    ['stdout', 0, 'Refusing to run in an untrusted workspace'],
    ['stderr', 1, 'Not logged in. Please log in to continue.'],
  ]) {
    test(`${mode} preserves the exact refusal from ${stream} at exit ${status}`, async (t) => {
      const setup = room(t);
      withEngine(t, setup.dir, `console.${stream === 'stderr' ? 'error' : 'log'}(${JSON.stringify(sentence)}); process.exit(${status});`);
      fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
      fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
      const calls = [];
      const lines = [];
      const options = { root: setup.root, ownCli: flightCli(setup, calls), scoutAsk: false, log: line => lines.push(line) };
      const flight = mode === 'dispatch'
        ? await fleet.runDispatchFlight({ ...options, taskIds: [TASK.display_id], engine: 'devin', installedEngines: [] })
        : await fleet.runFleetFlight({ ...options, engines: ['devin'], guardCliLink: () => ({ ok: true }) });
      assert.equal(flight.paused.length, 1);
      assert.equal(flight.paused[0].stage, 'build');
      assert.equal(flight.paused[0].reason, 'engine_refused');
      assert.equal(flight.paused[0].detail, sentence);
      assert.ok(lines.some(line => line.includes(sentence)), lines.join('\n'));
      const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
      assert.equal(receipt.paused[0].detail, sentence);
      assert.equal(calls.some(args => args[0] === 'worktree' && args[1] === 'ship'), false);
      assert.equal(fs.readFileSync(path.join(setup.root, 'result.txt'), 'utf8'), 'before\n');
    });
  }
}

test('remote HEAD wins over main and master; absent HEAD prefers main; worktree defaults and codex preview agree', async (t) => {
  const setup = room(t, 'trunk');
  setup.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  setup.git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  assert.equal(defaultMainlineBase(setup.root), 'origin/trunk');
  const worker = createAgentWorktree({ root: setup.root, agent: 'tester', task: 'default', path: setup.worktree });
  assert.equal(setup.git(['config', '--get', `branch.${worker.branch}.atris-base`]), 'origin/trunk');
  const lines = [];
  const savedLog = console.log;
  console.log = line => lines.push(line);
  try { await dispatchCodexFlight({ repoPath: setup.root, slug: 'preview', brief: 'build', dryRun: true }); }
  finally { console.log = savedLog; }
  assert.match(lines[0], /origin\/trunk$/);
  setup.git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  assert.equal(defaultMainlineBase(setup.root), 'origin/main');
  assert.equal(collectBoard(setup.root).base, 'origin/main');
  setup.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.equal(defaultMainlineBase(setup.root), 'origin/master');
});


test('claim cleanup without a known base preserves committed local work', (t) => {
  const setup = room(t);
  setup.git(['remote', 'remove', 'origin']);
  fs.writeFileSync(path.join(setup.root, 'result.txt'), 'after\n');
  setup.git(['add', 'result.txt']);
  setup.git(['commit', '-qm', 'local work']);
  const calls = [];
  fleet.releasePausedClaimsWithoutWork(args => { calls.push(args); return { status: 0 }; }, {
    paused: [{ task: TASK.display_id, stage: 'build', worktree: setup.root }],
    worktreeByTask: new Map(), actorByTask: new Map([[TASK.display_id, 'fleet-devin']]),
  });
  assert.deepEqual(calls, []);
});
