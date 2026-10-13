'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fleet = require('../lib/fleet');
const { createAgentWorktree, defaultMainlineBase, gitNetworkEnvironment } = require('../commands/worktree');
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

function traceNetworkGit(t, setup, failFetch = false, ssh = { GIT_SSH_COMMAND: 'ssh -i /tmp/test-key' }) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(setup.dir, 'bin');
  const trace = path.join(setup.dir, 'git-network.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (['ls-remote', 'fetch'].includes(args[0])) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, prompt: process.env.GIT_TERMINAL_PROMPT, ssh: process.env.GIT_SSH_COMMAND, program: process.env.GIT_SSH }) + '\\n');
  if (${failFetch} && args[0] === 'fetch') process.exit(1);
}
const run = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.GIT_TERMINAL_PROMPT = '1';
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  Object.assign(process.env, ssh);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

function renameRemote(setup) {
  setup.git(['update-ref', 'refs/heads/main', setup.git(['rev-parse', 'HEAD'])], setup.origin);
  setup.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], setup.origin);
  setup.git(['update-ref', '-d', 'refs/heads/master'], setup.origin);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main'], { cwd: setup.root }).status, 128);
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
console.log('Not logged in. Run: atris login');
`);
      fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
      fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
      const calls = [];
      const options = { root: setup.root, ownCli: flightCli(setup, calls), scoutAsk: async () => null, log: () => {} };
      const flight = mode === 'dispatch'
        ? await fleet.runDispatchFlight({ ...options, taskIds: [TASK.display_id], engine: 'cursor', installedEngines: ['devin'] })
        : await fleet.runFleetFlight({ ...options, slots: 1, engines: ['cursor', 'devin'], guardCliLink: () => ({ ok: true }) });
      assert.deepEqual(flight.paused, [], JSON.stringify(flight.paused));
      assert.equal(flight.landed.length, 1);
      assert.equal(flight.results[0].restaffed, undefined);
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
    ['stderr', 0, 'Refusing to run in an untrusted workspace'],
    ['stderr', 1, 'Not logged in. Please log in to continue.'],
  ]) {
    test(`${mode} preserves the exact refusal from ${stream} at exit ${status}`, async (t) => {
      const setup = room(t);
      withEngine(t, setup.dir, `console.${stream === 'stderr' ? 'error' : 'log'}(${JSON.stringify(sentence)}); process.exit(${status});`);
      fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
      fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
      const calls = [];
      const lines = [];
      const options = { root: setup.root, ownCli: flightCli(setup, calls), scoutAsk: async () => null, log: line => lines.push(line) };
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
  setup.git(['remote', 'set-url', 'origin', path.join(setup.dir, 'offline.git')]);
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

for (const mode of ['dispatch', 'fleet']) {
  test(`${mode} retains a refusal in the receipt and printed handoff when a backup lands`, async (t) => {
    const setup = room(t);
    const marker = path.join(setup.dir, 'attempted');
    const sentence = 'Not logged in. Please log in to continue.';
    withEngine(t, setup.dir, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'first');
  console.error(${JSON.stringify(sentence)});
  process.exit(1);
}
fs.writeFileSync('result.txt', 'after\\n');
for (const args of [['add', 'result.txt'], ['commit', '-qm', 'correct the result']]) {
  if (spawnSync('git', args).status !== 0) process.exit(1);
}
console.log('saved the result');
`);
    fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
    fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
    const lines = [];
    const options = { root: setup.root, ownCli: flightCli(setup, []), scoutAsk: async () => null, log: line => lines.push(line) };
    const flight = mode === 'dispatch'
      ? await fleet.runDispatchFlight({ ...options, taskIds: [TASK.display_id], engine: 'devin', installedEngines: ['cursor'] })
      : await fleet.runFleetFlight({ ...options, slots: 1, engines: ['devin', 'cursor'], guardCliLink: () => ({ ok: true }) });
    assert.deepEqual(flight.paused, []);
    assert.equal(flight.landed.length, 1);
    assert.equal(flight.results[0].restaffed.detail, sentence);
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.results[0].restaffed.detail, sentence);
    assert.equal(receipt.landed[0].restaffed.detail, sentence);
    assert.ok(lines.some(line => line.includes(sentence)), lines.join('\n'));
  });
}

test('default branch follows a remote rename even while the saved remote HEAD and master ref survive', (t) => {
  const setup = room(t, 'master');
  renameRemote(setup);
  assert.equal(setup.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']), 'origin/master');
  assert.equal(defaultMainlineBase(setup.root), 'origin/main');
  assert.equal(fleet.resolveDispatchLandTarget(setup.root), 'origin/main');
  assert.equal(collectBoard(setup.root).base, 'origin/main');
});

test('a known live default branch never falls back when fetching its missing ref fails', (t) => {
  const setup = room(t, 'master');
  renameRemote(setup);
  traceNetworkGit(t, setup, true);
  assert.throws(() => defaultMainlineBase(setup.root), /could not fetch the remote default branch/);
  assert.throws(() => fleet.resolveDispatchLandTarget(setup.root), /could not fetch the remote default branch/);
});

test('worktree creation looks up the branch once and disables prompts on every network call', (t) => {
  const setup = room(t);
  const readTrace = traceNetworkGit(t, setup);
  const worker = createAgentWorktree({ root: setup.root, agent: 'tester', task: 'default', path: setup.worktree });
  assert.equal(setup.git(['config', '--get', `branch.${worker.branch}.atris-base`]), 'origin/main');
  const calls = readTrace();
  assert.ok(calls.some(call => call.args[0] === 'fetch'));
  for (const call of calls) {
    assert.equal(call.prompt, '0', JSON.stringify(call));
    assert.equal(call.ssh, 'ssh -i /tmp/test-key');
  }
  assert.equal(calls.filter(call => call.args.includes('--symref')).length, 1);
});

test('checking a build that landed itself also disables network prompts', (t) => {
  const setup = room(t);
  const startCommit = setup.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(setup.root, 'result.txt'), 'after\n');
  setup.git(['add', 'result.txt']);
  setup.git(['commit', '-qm', 'correct result']);
  setup.git(['push', '-q', 'origin', 'main']);
  const readTrace = traceNetworkGit(t, setup);
  assert.equal(fleet.defaultSelfLandCheck({ worktreePath: setup.root, targetRef: 'origin/main', startCommit }).ok, true);
  const calls = readTrace();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'fetch');
  assert.equal(calls[0].prompt, '0');
  assert.equal(calls[0].ssh, 'ssh -i /tmp/test-key');
});

test('network git keeps the repo ssh command and leaves a GIT_SSH program alone', (t) => {
  const setup = room(t);
  setup.git(['config', 'core.sshCommand', 'ssh -i ~/.ssh/work_key -F ~/.ssh/work_config']);
  let readTrace = traceNetworkGit(t, setup, false, {});
  assert.equal(fleet.landArrival({ worktreePath: setup.root, targetRef: 'origin/main' }).ok, true);
  assert.equal(defaultMainlineBase(setup.root), 'origin/main');
  let calls = readTrace();
  assert.deepEqual(calls.map(call => call.args[0]), ['fetch', 'ls-remote']);
  for (const call of calls) {
    assert.equal(call.prompt, '0', JSON.stringify(call));
    assert.equal(call.ssh, undefined);
  }
  fs.rmSync(path.join(setup.dir, 'bin'), { recursive: true });
  fs.rmSync(path.join(setup.dir, 'git-network.jsonl'));
  readTrace = traceNetworkGit(t, setup, false, { GIT_SSH: '/usr/local/bin/plink' });
  assert.equal(fleet.landArrival({ worktreePath: setup.root, targetRef: 'origin/main' }).ok, true);
  calls = readTrace();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ssh, undefined);
  assert.equal(calls[0].program, '/usr/local/bin/plink');
  assert.equal(calls[0].prompt, '0');
});

for (const mode of ['dispatch', 'fleet']) {
  test(`${mode} pins the renamed remote branch once for the whole flight`, async (t) => {
    const setup = room(t, 'master');
    renameRemote(setup);
    withEngine(t, setup.dir, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync('result.txt', 'after\\n');
for (const args of [['add', 'result.txt'], ['commit', '-qm', 'correct result']]) {
  if (spawnSync('git', args).status !== 0) process.exit(1);
}
console.log('saved the result');
`);
    fs.mkdirSync(path.join(setup.root, '.atris/state'), { recursive: true });
    fs.writeFileSync(path.join(setup.root, '.atris/state/tasks.projection.json'), JSON.stringify({ tasks: [TASK] }));
    const readTrace = traceNetworkGit(t, setup);
    const calls = [];
    const options = { root: setup.root, ownCli: flightCli(setup, calls), scoutAsk: async () => null, log: () => {} };
    const flight = mode === 'dispatch'
      ? await fleet.runDispatchFlight({ ...options, taskIds: [TASK.display_id], engine: 'devin', installedEngines: [] })
      : await fleet.runFleetFlight({ ...options, slots: 1, engines: ['devin'], guardCliLink: () => ({ ok: true }) });
    assert.deepEqual(flight.paused, [], JSON.stringify(flight.paused));
    assert.equal(flight.landed.length, 1);
    assert.equal(readTrace().filter(call => call.args.includes('--symref')).length, 1);
    for (const call of readTrace()) {
      assert.equal(call.prompt, '0', JSON.stringify(call));
      assert.equal(call.ssh, 'ssh -i /tmp/test-key');
    }
    for (const [verb, flag] of [['start', '--base'], ['ship', '--target']]) {
      const call = calls.find(args => args[0] === 'worktree' && args[1] === verb);
      assert.equal(call[call.indexOf(flag) + 1], 'origin/main');
    }
    assert.equal(setup.git(['ls-remote', '--heads', 'origin', 'master']), '');
  });
}

test('failed codex tool output is not an engine refusal and credit failures take precedence', (t) => {
  const transcript = 'OpenAI Codex\n--------\nexec\natris whoami\nNot logged in. Run: atris login\n';
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 1, stderr: transcript }), { reason: 'nonzero_exit', exitCode: 1 });
  assert.equal(fleet.detectDeadEngineDispatch({ exitCode: 0, stderr: transcript }), null);
  assert.equal(fleet.detectDeadEngineDispatch({ exitCode: 1, stderr: 'Not logged in. Run: atris login\nusage limit reached' }).reason, 'usage_limit');
  const setup = room(t);
  withEngine(t, setup.dir, `console.error(${JSON.stringify(transcript)}); process.exit(1);`);
  const run = fleet.dispatchToEngine({ task: TASK, engine: 'codex', worktreePath: setup.root });
  assert.deepEqual(fleet.detectDeadEngineDispatch(run), { reason: 'nonzero_exit', exitCode: 1 });
});

test('an origin without known branch refs never invents origin/master', (t) => {
  const setup = room(t);
  setup.git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  setup.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  setup.git(['remote', 'set-url', 'origin', path.join(setup.dir, 'offline.git')]);
  assert.equal(fleet.resolveDispatchLandTarget(setup.root), 'origin/HEAD');
});

test('local landing skips fetch without origin and still rebases and checks source dirt', (t) => {
  const setup = room(t);
  const base = setup.git(['rev-parse', 'HEAD']);
  setup.git(['remote', 'remove', 'origin']);
  const calls = [];
  const git = args => {
    calls.push(args);
    return spawnSync('git', args, { cwd: setup.root, encoding: 'utf8' });
  };
  assert.deepEqual(fleet.landArrival({ worktreePath: setup.root, targetRef: base, git }), { ok: true, stage: 'rebased' });
  assert.equal(calls.some(args => args[0] === 'fetch'), false);
  assert.ok(calls.some(args => args[0] === 'rebase' && args[1] === base));
  fs.writeFileSync(path.join(setup.root, 'result.txt'), 'dirty\n');
  assert.equal(fleet.landArrival({ worktreePath: setup.root, targetRef: base, git }).stage, 'dirty_worktree');
});

test('custom SSH wrappers stay exact and default SSH is noninteractive', (t) => {
  const setup = room(t);
  const command = 'company-ssh --profile work';
  assert.equal(gitNetworkEnvironment({ GIT_SSH_COMMAND: command }, setup.root).GIT_SSH_COMMAND, command);
  setup.git(['config', 'core.sshCommand', command]);
  assert.equal(gitNetworkEnvironment({}, setup.root).GIT_SSH_COMMAND, undefined);
  setup.git(['config', '--unset', 'core.sshCommand']);
  assert.equal(gitNetworkEnvironment({}, setup.root).GIT_SSH_COMMAND,
    'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15');
});

test('a remote lookup that ignores termination cannot stall the flight', (t) => {
  const setup = room(t);
  traceNetworkGit(t, setup);
  const wrapper = path.join(setup.dir, 'bin', 'git');
  const source = fs.readFileSync(wrapper, 'utf8');
  fs.writeFileSync(wrapper, source.replace("const args = process.argv.slice(2);", `
const args = process.argv.slice(2);
if (['ls-remote', 'fetch'].includes(args[0])) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  return;
}`));
  const started = Date.now();
  assert.equal(defaultMainlineBase(setup.root), 'origin/main');
  assert.ok(Date.now() - started < 10000, 'lookup must stop at its process timeout');
  const landingStarted = Date.now();
  const landing = fleet.landArrival({ worktreePath: setup.root, targetRef: 'origin/main' });
  assert.equal(landing.ok, false);
  assert.equal(landing.stage, 'fetch');
  assert.ok(Date.now() - landingStarted < 20000, 'landing fetch must also stop at its process timeout');
});
