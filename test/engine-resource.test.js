const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RESOURCE_LOG,
  readMachineResources,
  memoryWasLow,
  killedCauseText,
  recordEngineResource,
} = require('../lib/engine-resource');

const PRESSURE_OK = 'The system has 38654705664 (2359296 pages with a page size of 16384).\nSystem-wide memory free percentage: 81%\n';
const PRESSURE_LOW = 'System-wide memory free percentage: 9%\n';
const SWAP_OK = 'vm.swapusage: total = 2048.00M  used = 512.25M  free = 1535.75M  (encrypted)\n';
const SWAP_FULL = 'vm.swapusage: total = 4096.00M  used = 3900.00M  free = 196.00M  (encrypted)\n';

function fakeRun(pressure, swap) {
  return (cmd) => {
    if (cmd === 'memory_pressure') return { status: 0, stdout: pressure };
    if (cmd === 'sysctl') return { status: 0, stdout: swap };
    return { status: 1, stdout: '' };
  };
}

test('mac snapshot reads free memory, swap, and load', () => {
  const snap = readMachineResources({ platform: 'darwin', run: fakeRun(PRESSURE_OK, SWAP_OK), loadavg: () => [3.5, 2.25, 1] });
  assert.deepStrictEqual(snap, { free_pct: 81, swap_used_mb: 512.25, swap_total_mb: 2048, load: [3.5, 2.25, 1] });
});

test('off mac, memory fields stay empty instead of guessing', () => {
  const snap = readMachineResources({ platform: 'linux', run: () => { throw new Error('must not run'); }, loadavg: () => [1, 1, 1] });
  assert.deepStrictEqual(snap, { free_pct: null, swap_used_mb: null, swap_total_mb: null, load: [1, 1, 1] });
});

test('a failed tool leaves its field empty', () => {
  const snap = readMachineResources({ platform: 'darwin', run: () => ({ status: 1, stdout: '' }), loadavg: () => [0, 0, 0] });
  assert.strictEqual(snap.free_pct, null);
  assert.strictEqual(snap.swap_used_mb, null);
});

test('a SIGKILL names low memory only when pressure or swap was high', () => {
  const ok = readMachineResources({ platform: 'darwin', run: fakeRun(PRESSURE_OK, SWAP_OK), loadavg: () => [0, 0, 0] });
  const lowFree = readMachineResources({ platform: 'darwin', run: fakeRun(PRESSURE_LOW, SWAP_OK), loadavg: () => [0, 0, 0] });
  const fullSwap = readMachineResources({ platform: 'darwin', run: fakeRun(PRESSURE_OK, SWAP_FULL), loadavg: () => [0, 0, 0] });
  assert.strictEqual(memoryWasLow(ok), false);
  assert.strictEqual(memoryWasLow(lowFree), true);
  assert.strictEqual(memoryWasLow(fullSwap), true);
  assert.strictEqual(killedCauseText(ok), 'killed (cause unknown)');
  assert.strictEqual(killedCauseText(lowFree), 'killed (machine memory low)');
  assert.strictEqual(killedCauseText(fullSwap), 'killed (machine memory low)');
  assert.strictEqual(killedCauseText(null), 'killed (cause unknown)');
});

test('start and end lines append to the durable resource log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-'));
  try {
    const deps = { platform: 'darwin', run: fakeRun(PRESSURE_LOW, SWAP_OK), loadavg: () => [4, 3, 2], now: () => '2026-10-14T08:00:00.000Z' };
    recordEngineResource(root, { phase: 'start', engine: 'codex', task: 'CLI-1', run_id: 'run-one' }, deps);
    const end = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'CLI-1', run_id: 'run-one', signal: 'SIGKILL' }, deps);
    assert.strictEqual(end.cause, 'killed (machine memory low)');
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((line) => line.run_id), ['run-one', 'run-one']);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0], {
      at: '2026-10-14T08:00:00.000Z', phase: 'start', engine: 'codex', task: 'CLI-1',
      run_id: 'run-one',
      free_pct: 9, swap_used_mb: 512.25, swap_total_mb: 2048, load: [4, 3, 2],
      pid: process.pid, leaked_ssh_agents: 0,
    });
    assert.strictEqual(lines[1].phase, 'end');
    assert.strictEqual(lines[1].signal, 'SIGKILL');
    assert.strictEqual(lines[1].cause, 'killed (machine memory low)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { parseElapsed, findLeakedSshAgents, readSshAgents } = require('../lib/engine-resource');

test('elapsed milliseconds belong only to end resources and must be finite and nonnegative', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-duration-'));
  const deps = { platform: 'linux', loadavg: () => [0, 0, 0], readSshAgents: () => ({ agents: [], referenced: new Set() }) };
  try {
    for (const duration_ms of [0, 125]) {
      const end = recordEngineResource(root, { phase: 'end', duration_ms }, deps);
      assert.strictEqual(end.duration_ms, duration_ms);
    }
    for (const duration_ms of [undefined, -1, NaN, Infinity, '125']) {
      assert.strictEqual(recordEngineResource(root, { phase: 'end', duration_ms }, deps).duration_ms, undefined);
    }
    assert.strictEqual(recordEngineResource(root, { phase: 'start', duration_ms: 125 }, deps).duration_ms, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start records the sweep leak count without stopping agents or reading again at end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-agents-'));
  let reads = 0;
  const agent = (pid, over = {}) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s', ...over });
  const deps = {
    platform: 'linux', loadavg: () => [0, 0, 0], uid: 501,
    readSshAgents: () => {
      reads += 1;
      return { agents: [agent(200), agent(201), agent(202, { age_sec: 120 }), agent(203, { uid: 0 })], referenced: new Set([201]) };
    },
  };
  try {
    recordEngineResource(root, { phase: 'start', engine: 'codex' }, deps);
    recordEngineResource(root, { phase: 'end', engine: 'codex' }, deps);
    const [start, end] = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(start.leaked_ssh_agents, 1);
    assert.strictEqual(end.leaked_ssh_agents, undefined);
    assert.strictEqual(reads, 1);
    const unknown = recordEngineResource(root, { engine: 'codex' }, {
      ...deps, readSshAgents: () => { throw new Error('process read failed'); },
    });
    assert.strictEqual(unknown.leaked_ssh_agents, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('elapsed time reads minutes, hours, and days', () => {
  assert.strictEqual(parseElapsed('11:09'), 669);
  assert.strictEqual(parseElapsed('14:50:14'), 53414);
  assert.strictEqual(parseElapsed('2-01:00:00'), 176400);
  assert.strictEqual(parseElapsed('junk'), null);
});

test('only orphaned, old, unreferenced shell agents count as leaked', () => {
  const agent = (pid, over = {}) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s', ...over });
  const agents = [
    agent(100),
    agent(101),
    agent(102, { age_sec: 120 }),
    agent(103, { args: '/usr/bin/ssh-agent -l' }),
    agent(104, { uid: 0 }),
    agent(105, { ppid: 4242 }),
    agent(106, { args: '/usr/bin/ssh-agent -c' }),
    agent(107, { args: 'ssh-agent -a /Users/me/.ssh/agent.sock' }),
  ];
  const leaked = findLeakedSshAgents(agents, { referenced: new Set([101]), uid: 501 });
  assert.deepStrictEqual(leaked.map((a) => a.pid), [100, 106]);
});

test('reading agents matches the program name and collects live references', () => {
  const run = (cmd, args) => {
    if (args.includes('-E')) {
      return { status: 0, stdout: [
        '  300 -zsh HOME=/Users/me SSH_AGENT_PID=201 TERM=xterm',
        '  301 claude -p fix ssh-agent leaks PATH=/bin',
        '  302 git fetch SSH_AUTH_SOCK=/tmp/ssh-c/agent.202 HOME=/Users/me',
      ].join('\n') };
    }
    if (cmd === 'lsof') {
      return { status: 0, stdout: ['p200', 'f3', 'n/tmp/ssh-a/agent.199', 'p201', 'f3', 'n/tmp/ssh-b/agent.200', 'p202', 'f3', 'n/tmp/ssh-c/agent.202'].join('\n') };
    }
    return { status: 0, stdout: [
      '  200     1   501    14:50:14 ssh-agent -s',
      '  201     1   501       11:09 /usr/bin/ssh-agent -s',
      '  202     1   501       30:00 ssh-agent -s',
      '  203     1   501       30:00 ssh-agent -s',
      '  301   300   501       00:05 claude -p fix ssh-agent leaks',
    ].join('\n') };
  };
  const { agents, referenced } = readSshAgents({ run });
  assert.deepStrictEqual(agents.slice(0, 2), [
    { pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' },
    { pid: 201, ppid: 1, uid: 501, age_sec: 669, args: '/usr/bin/ssh-agent -s' },
  ]);
  assert.ok(!referenced.has(200));
  assert.ok(referenced.has(201), 'named by SSH_AGENT_PID');
  assert.ok(referenced.has(202), 'named by SSH_AUTH_SOCK');
  assert.ok(referenced.has(203), 'socket unreadable, so treated as in use');
});

test('when the socket list cannot be read, every agent counts as in use', () => {
  const run = (cmd, args) => {
    if (cmd === 'lsof') return { status: 1, stdout: '' };
    if (args.includes('-E')) return { status: 0, stdout: '' };
    return { status: 0, stdout: '  200     1   501    14:50:14 ssh-agent -s' };
  };
  const { referenced } = readSshAgents({ run });
  assert.ok(referenced.has(200));
});

function sweepWithReads(reads, { args = ['sweep', '--apply'], kill } = {}) {
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-'));
  const out = [];
  const original = console.log;
  console.log = (line) => out.push(String(line));
  let code;
  try {
    code = engineCommand(args, {
      root,
      engineSweep: { read: () => reads.shift(), uid: 501, kill, now: () => '2026-10-14T12:00:00.000Z' },
    });
  } finally {
    console.log = original;
  }
  const logFile = path.join(root, RESOURCE_LOG);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  fs.rmSync(root, { recursive: true, force: true });
  return { code, text: out.join('\n'), log };
}

test('sweep apply rechecks right before stopping, and logs what it stopped', () => {
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const first = { agents: [agent(200), agent(201), agent(202)], referenced: new Set() };
  const second = { agents: [agent(200), agent(201)], referenced: new Set([201]) };
  const signals = [];
  const { code, text, log } = sweepWithReads([first, second], {
    kill: (pid, signal) => signals.push([pid, signal]),
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(signals, [[200, 'SIGTERM']]);
  assert.match(text, /stopped 1 leaked ssh-agent/);
  assert.match(text, /2 skipped because they were in use or gone on the recheck/);
  assert.deepStrictEqual(log, [{ at: '2026-10-14T12:00:00.000Z', phase: 'sweep', stopped: [200], failed: [], skipped: [201, 202], leaked_ssh_agents: 0 }]);
});

test('sweep apply reports an agent it could not stop', () => {
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const read = { agents: [agent(200), agent(201)], referenced: new Set() };
  const { code, text, log } = sweepWithReads([read, read], {
    kill: (pid) => { if (pid === 201) throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
  });
  assert.strictEqual(code, 1);
  assert.match(text, /stopped 1 leaked ssh-agent/);
  assert.match(text, /could not stop pid 201: ESRCH/);
  assert.deepStrictEqual(log[0].failed, [201]);
});

test('atris engine sweep lists leaked agents and stops nothing', () => {
  const { engineCommand } = require('../commands/engine');
  const signals = [];
  const deps = {
    engineSweep: {
      read: () => ({
        agents: [
          { pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' },
          { pid: 201, ppid: 1, uid: 501, age_sec: 669, args: 'ssh-agent -s' },
        ],
        referenced: new Set([201]),
      }),
      uid: 501,
      kill: (pid, signal) => signals.push([pid, signal]),
    },
  };
  const out = [];
  const original = console.log;
  console.log = (line) => out.push(String(line));
  let code;
  try {
    code = engineCommand(['sweep'], deps);
  } finally {
    console.log = original;
  }
  assert.strictEqual(code, 0);
  const text = out.join('\n');
  assert.match(text, /2 ssh-agents running, 1 looks leaked/);
  assert.match(text, /pid 200 +14h 50m/);
  assert.match(text, /nothing was stopped/);
  assert.deepStrictEqual(signals, []);
});

test('when process environments cannot be read, every agent counts as in use', () => {
  const run = (cmd, args) => {
    if (cmd === 'lsof') return { status: 0, stdout: 'p200\nf3\nn/tmp/ssh-a/agent.199' };
    if (args.includes('-E')) return { status: 1, stdout: '' };
    return { status: 0, stdout: '  200     1   501    14:50:14 ssh-agent -s' };
  };
  const { referenced } = readSshAgents({ run });
  assert.ok(referenced.has(200));
});

test('the hourly landing pass stops agents still leaked on the recheck and names the count', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-sweep-'));
  try {
    const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
    const reads = [
      { agents: [agent(200), agent(201)], referenced: new Set() },
      { agents: [agent(200), agent(201)], referenced: new Set([201]) },
    ];
    const signals = [];
    const receipt = {};
    runSshAgentSweep(root, receipt, { read: () => reads.shift(), uid: 501, kill: (pid, signal) => signals.push([pid, signal]) });
    assert.deepStrictEqual(signals, [[200, 'SIGTERM']]);
    assert.deepStrictEqual(receipt.ssh_agent_sweep, { stopped: [200], failed: [], skipped: [201] });
    assert.strictEqual(sshAgentSweepNote(receipt), ', stopped 1 leaked ssh-agent');

    const quiet = {};
    runSshAgentSweep(root, quiet, {
      read: () => ({ agents: [agent(300)], referenced: new Set([300]) }),
      uid: 501,
      kill: () => assert.fail('nothing leaked, nothing stopped'),
    });
    assert.deepStrictEqual(quiet.ssh_agent_sweep, { stopped: [], failed: [], skipped: [] });
    assert.strictEqual(sshAgentSweepNote(quiet), '');
    const log = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n');
    assert.strictEqual(log.length, 1, 'a pass with nothing leaked writes no sweep line');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing read never breaks the hourly landing pass', () => {
  const { runSshAgentSweep } = require('../commands/autoland');
  const receipt = {};
  runSshAgentSweep(os.tmpdir(), receipt, { read: () => { throw new Error('ps missing'); }, uid: 501 });
  assert.match(receipt.ssh_agent_sweep_error, /ps missing/);
});

const { readResourceHistory } = require('../lib/engine-resource');

test('history reads back the latest sweep and the latest SIGKILL, skipping bad lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-history-'));
  try {
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ at: '2026-10-14T10:00:00.000Z', phase: 'end', engine: 'codex', task: 'CLI-1', free_pct: 9, signal: 'SIGKILL', cause: 'killed (machine memory low)' }),
      JSON.stringify({ at: '2026-10-14T11:00:00.000Z', phase: 'sweep', stopped: [1, 2], failed: [], skipped: [] }),
      'not json',
      JSON.stringify({ at: '2026-10-14T11:30:00.000Z', phase: 'end', engine: 'claude', task: 'CLI-2', free_pct: 70, signal: 'SIGKILL', cause: 'killed (cause unknown)' }),
      JSON.stringify({ at: '2026-10-14T11:40:00.000Z', phase: 'end', engine: 'claude', task: 'CLI-3', free_pct: 70 }),
      JSON.stringify({ at: '2026-10-14T12:00:00.000Z', phase: 'sweep', stopped: [3], failed: [], skipped: [4] }),
      '',
    ].join('\n'));
    const history = readResourceHistory(root);
    assert.strictEqual(history.last_sweep.at, '2026-10-14T12:00:00.000Z');
    assert.strictEqual(history.last_kill.task, 'CLI-2');
    assert.strictEqual(history.kills, 2);
    assert.strictEqual(history.low_memory_kills, 1);
    assert.deepStrictEqual(readResourceHistory(path.join(root, 'missing')), { last_sweep: null, last_kill: null, kills: 0, low_memory_kills: 0, time_limit_kills: 0, last_other_kill: null, kills_day: 0, low_memory_kills_day: 0, time_limit_kills_day: 0, last_day_other_kill: null, open_runs: 0, parent_gone: 0, still_running: 0, last_open: null, lost_closed: 0, lost_closed_day: 0, last_lost_closed: null, first_day_leak_reading: null, last_error: null, errors_day: 0, last_day_error: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris engine sweep shows the last sweep and the last SIGKILL', () => {
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-history-'));
  const file = path.join(root, RESOURCE_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ at: '2026-10-14T11:30:00.000Z', phase: 'end', engine: 'claude', task: 'CLI-2', free_pct: 9, signal: 'SIGKILL', cause: 'killed (machine memory low)' }),
    JSON.stringify({ at: '2026-10-14T12:00:00.000Z', phase: 'sweep', stopped: [3, 5], failed: [], skipped: [] }),
  ].join('\n'));
  const run = (deps) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501, ...deps } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    const text = run();
    assert.match(text, /last sweep: 2026-10-14 12:00 UTC, stopped 2/);
    assert.match(text, /last SIGKILL: claude on CLI-2 at 2026-10-14 11:30 UTC, killed \(machine memory low\), 9% memory free/);
    assert.match(text, /1 of 1 SIGKILL ended with machine memory low/);
    fs.rmSync(file);
    const empty = run();
    assert.match(empty, /no sweep recorded yet/);
    assert.match(empty, /no engine run has ended in SIGKILL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a test run never writes into this checkout\'s own resource log', () => {
  const repoRoot = path.join(__dirname, '..');
  const { mainCheckoutRoot } = require('../lib/engine-registry');
  const file = path.join(mainCheckoutRoot(repoRoot) || repoRoot, RESOURCE_LOG);
  const size = () => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  const before = size();
  const entry = recordEngineResource(repoRoot, { phase: 'end', engine: 'cursor', task: 'CLI-TEST-ONLY', signal: 'SIGKILL' }, { platform: 'linux', loadavg: () => [0, 0, 0] });
  assert.strictEqual(entry.cause, 'killed (cause unknown)');
  assert.strictEqual(size(), before);
});


test('resource history survives removal of a real linked checkout', () => {
  const { spawnSync } = require('node:child_process');
  const { stopLeakedSshAgents } = require('../lib/engine-resource');
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-linked-'));
  const root = path.join(room, 'main');
  const linked = path.join(room, 'linked');
  fs.mkdirSync(root);
  const git = (args) => {
    const result = spawnSync('git', ['-c', 'user.name=resource test', '-c', 'user.email=resource@example.com', ...args], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  };
  try {
    git(['init', '-q']);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    git(['worktree', 'add', '-q', '--detach', linked]);
    const deps = { platform: 'linux', loadavg: () => [0, 0, 0], readSshAgents: () => ({ agents: [], referenced: new Set() }) };
    recordEngineResource(linked, { phase: 'start', run_id: 'linked-run' }, deps);
    recordEngineResource(linked, { phase: 'end', run_id: 'linked-run', signal: 'SIGKILL' }, deps);
    stopLeakedSshAgents(linked, [], { read: () => ({ agents: [], referenced: new Set() }), uid: 501 });
    assert.strictEqual(fs.existsSync(path.join(linked, RESOURCE_LOG)), false);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(lines.map((line) => line.phase), ['start', 'end', 'sweep']);
    const history = readResourceHistory(root);
    assert.strictEqual(history.kills, 1);
    assert.ok(history.last_sweep);
    assert.deepStrictEqual(readResourceHistory(linked), history);
    git(['worktree', 'remove', linked]);
    assert.deepStrictEqual(readResourceHistory(root), history);
  } finally {
    fs.rmSync(room, { recursive: true, force: true });
  }
});

test('a full resource log is cut back to its newest lines but keeps starts still waiting for an end', () => {
  const { MAX_LOG_BYTES } = require('../lib/engine-resource');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-cap-'));
  try {
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = (run_id, phase) => JSON.stringify({ at: '2026-10-01T00:00:00.000Z', phase, engine: 'cursor', task: 'OLD', run_id, pad: 'x'.repeat(200) });
    const lines = [old('long-run', 'start'), old('done-run', 'start'), old('done-run', 'end')];
    while (lines.join('\n').length < MAX_LOG_BYTES) lines.push(old(`filler-${lines.length}`, 'start'), old(`filler-${lines.length}`, 'end'));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const deps = { platform: 'linux', loadavg: () => [0, 0, 0], now: () => '2026-10-14T12:00:00.000Z' };
    recordEngineResource(root, { phase: 'end', engine: 'cursor', task: 'LONG', run_id: 'long-run', signal: 'SIGKILL' }, deps);
    assert.ok(fs.statSync(file).size < MAX_LOG_BYTES, 'log was not cut back');
    const kept = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const ids = (phase) => kept.filter((line) => line.phase === phase).map((line) => line.run_id);
    assert.ok(ids('start').includes('long-run'), 'the start of a run with no end was dropped');
    assert.ok(!ids('start').includes('done-run'), 'an old finished run was kept');
    assert.strictEqual(kept.at(-1).run_id, 'long-run');
    assert.strictEqual(kept.at(-1).phase, 'end');
    assert.strictEqual(readResourceHistory(root).last_kill.run_id, 'long-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris engine sweep names runs that started and never wrote an end', () => {
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-open-'));
  const file = path.join(root, RESOURCE_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ at: '2026-10-14T09:00:00.000Z', phase: 'start', engine: 'codex', task: 'OLD' }),
    JSON.stringify({ at: '2026-10-14T10:00:00.000Z', phase: 'start', engine: 'codex', task: 'CLI-7', run_id: 'a' }),
    JSON.stringify({ at: '2026-10-14T10:05:00.000Z', phase: 'start', engine: 'claude', task: 'CLI-8', run_id: 'b' }),
    JSON.stringify({ at: '2026-10-14T10:30:00.000Z', phase: 'end', engine: 'claude', task: 'CLI-8', run_id: 'b' }),
    JSON.stringify({ at: '2026-10-14T11:00:00.000Z', phase: 'start', engine: 'cursor', task: 'CLI-9', run_id: 'c' }),
    '',
  ].join('\n'));
  const out = [];
  const original = console.log;
  console.log = (line) => out.push(String(line));
  try {
    const history = readResourceHistory(root);
    assert.strictEqual(history.open_runs, 2);
    assert.strictEqual(history.last_open.run_id, 'c');
    engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
  } finally {
    console.log = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.match(out.join('\n'), /2 runs started with no end recorded: 2 from before parents were recorded; newest: cursor on CLI-9 at 2026-10-14 11:00 UTC/);
});

test('an unfinished run whose start sits more than a megabyte back is still counted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-deep-open-'));
  try {
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (run_id, phase) => JSON.stringify({ at: '2026-10-14T09:00:00.000Z', phase, engine: 'cursor', task: run_id, run_id, pad: 'x'.repeat(200) });
    const lines = [line('deep-open', 'start')];
    while (lines.join('\n').length < 1.2 * 1024 * 1024) lines.push(line(`done-${lines.length}`, 'start'), line(`done-${lines.length}`, 'end'));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const history = readResourceHistory(root);
    assert.strictEqual(history.open_runs, 1);
    assert.strictEqual(history.last_open.run_id, 'deep-open');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start lines name the process that will write the end, and sweep splits unfinished runs by whether it is alive', () => {
  const { spawnSync } = require('node:child_process');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-parent-'));
  const deps = { platform: 'linux', loadavg: () => [0, 0, 0], readSshAgents: () => ({ agents: [], referenced: new Set() }) };
  const goneParent = spawnSync(process.execPath, ['-e', '']).pid;
  const out = [];
  const original = console.log;
  try {
    const start = recordEngineResource(root, { phase: 'start', engine: 'codex', task: 'LIVE', run_id: 'live' }, deps);
    assert.strictEqual(start.pid, process.pid);
    assert.strictEqual(recordEngineResource(root, { phase: 'end', run_id: 'live-done' }, deps).pid, undefined);
    const file = path.join(root, RESOURCE_LOG);
    fs.appendFileSync(file, [
      JSON.stringify({ at: '2026-10-14T09:00:00.000Z', phase: 'start', engine: 'claude', task: 'OLD', run_id: 'no-pid' }),
      JSON.stringify({ at: '2026-10-14T10:00:00.000Z', phase: 'start', engine: 'cursor', task: 'LOST', run_id: 'gone', pid: goneParent }),
      '',
    ].join('\n'));
    const history = readResourceHistory(root);
    assert.strictEqual(history.open_runs, 3);
    assert.strictEqual(history.parent_gone, 1);
    assert.strictEqual(history.still_running, 1);
    console.log = (line) => out.push(String(line));
    engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
  } finally {
    console.log = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.match(out.join('\n'), /3 runs started with no end recorded: 1 whose parent is gone, 1 still running, 1 from before parents were recorded; newest: cursor on LOST at 2026-10-14 10:00 UTC/);
});

test('sweep apply writes a parent gone end for lost runs only, and a plain sweep writes nothing', () => {
  const { spawnSync } = require('node:child_process');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-close-'));
  const file = path.join(root, RESOURCE_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const goneParent = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, [
    JSON.stringify({ at: '2026-10-14T09:00:00.000Z', phase: 'start', engine: 'claude', task: 'OLD', run_id: 'no-pid' }),
    JSON.stringify({ at: '2026-10-14T10:00:00.000Z', phase: 'start', engine: 'cursor', task: 'LOST', run_id: 'gone', pid: goneParent }),
    JSON.stringify({ at: '2026-10-14T10:05:00.000Z', phase: 'start', engine: 'codex', task: 'LIVE', run_id: 'live', pid: process.pid }),
    '',
  ].join('\n'));
  const sweep = (args) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep', ...args], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501, now: () => '2026-10-14T12:00:00.000Z' } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  const lineCount = () => fs.readFileSync(file, 'utf8').trim().split('\n').length;
  try {
    sweep([]);
    assert.strictEqual(lineCount(), 3);
    assert.match(sweep(['--apply']), /closed 1 run whose parent is gone/);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const ends = lines.filter((line) => line.phase === 'end');
    assert.deepStrictEqual(ends, [{ at: '2026-10-14T12:00:00.000Z', phase: 'end', engine: 'cursor', task: 'LOST', run_id: 'gone', cause: 'parent gone', closed_by: 'sweep' }]);
    const history = readResourceHistory(root);
    assert.strictEqual(history.open_runs, 2);
    assert.strictEqual(history.parent_gone, 0);
    assert.match(sweep(['--apply']), /closed 0 runs whose parent is gone/);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line.includes('"parent gone"')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly landing pass closes runs whose parent is gone and names the count', () => {
  const { spawnSync } = require('node:child_process');
  const { runLostRunSweep, lostRunSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-lost-runs-'));
  const file = path.join(root, RESOURCE_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const goneParent = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, [
    JSON.stringify({ at: '2026-10-14T10:00:00.000Z', phase: 'start', engine: 'cursor', task: 'LOST', run_id: 'gone', pid: goneParent }),
    JSON.stringify({ at: '2026-10-14T10:05:00.000Z', phase: 'start', engine: 'codex', task: 'LIVE', run_id: 'live', pid: process.pid }),
    '',
  ].join('\n'));
  try {
    const receipt = {};
    runLostRunSweep(root, receipt, { now: () => '2026-10-14T13:00:00.000Z' });
    assert.deepStrictEqual(receipt.lost_run_sweep, { closed: ['gone'] });
    assert.strictEqual(lostRunSweepNote(receipt), ', closed 1 lost engine run');
    const ends = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter((line) => line.phase === 'end');
    assert.deepStrictEqual(ends.map((line) => [line.run_id, line.cause, line.at]), [['gone', 'parent gone', '2026-10-14T13:00:00.000Z']]);

    const again = {};
    runLostRunSweep(root, again);
    assert.deepStrictEqual(again.lost_run_sweep, { closed: [] });
    assert.strictEqual(lostRunSweepNote(again), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lost run close that throws never breaks the hourly landing pass', () => {
  const { runLostRunSweep } = require('../commands/autoland');
  const receipt = {};
  runLostRunSweep(os.tmpdir(), receipt, { close: () => { throw new Error('log unreadable'); } });
  assert.match(receipt.lost_run_sweep_error, /log unreadable/);
  assert.strictEqual(receipt.lost_run_sweep, undefined);
});

test('the landing status names runs closed after their parent died in the last day, and stays quiet with none', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-lost-'));
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const status = () => spawnSync(process.execPath, [cli, 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const closed = (at, engine, task, runId) => JSON.stringify({ at, phase: 'end', engine, task, run_id: runId, cause: 'parent gone', closed_by: 'sweep' });
  const file = path.join(root, RESOURCE_LOG);
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const quiet = status();
    assert.strictEqual(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /parent died/);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [closed(hoursAgo(72), 'claude', 'OLD', 'old'), closed(hoursAgo(30), 'codex', 'OLDER', 'older'), ''].join('\n'));
    const old = status();
    assert.strictEqual(old.status, 0, old.stderr);
    assert.doesNotMatch(old.stdout, /parent died/, 'closes older than a day do not read as current');

    const recent = hoursAgo(2);
    fs.appendFileSync(file, [
      closed(hoursAgo(5), 'claude', 'A', 'a'),
      JSON.stringify({ at: hoursAgo(3), phase: 'end', engine: 'codex', task: 'B', run_id: 'b', signal: 'SIGKILL', cause: 'unknown' }),
      closed(recent, 'cursor', 'LOST', 'c'),
      '',
    ].join('\n'));
    const loud = status();
    assert.strictEqual(loud.status, 0, loud.stderr);
    const when = `${recent.slice(0, 16).replace('T', ' ')} UTC`;
    assert.ok(loud.stdout.includes(`engine runs closed after their parent died in the last day: 2, newest cursor on LOST at ${when}`), loud.stdout);
    const history = readResourceHistory(root);
    assert.strictEqual(history.lost_closed, 4);
    assert.strictEqual(history.lost_closed_day, 2);
    assert.strictEqual(readResourceHistory(root, { now: Date.now() + 48 * 3600 * 1000 }).lost_closed_day, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status names the last day of killed runs with the low memory count and the newest cause', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-kills-'));
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const status = () => spawnSync(process.execPath, [cli, 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const killed = (at, engine, task, runId, cause, free) => JSON.stringify({ at, phase: 'end', engine, task, run_id: runId, signal: 'SIGKILL', cause, free_pct: free });
  const file = path.join(root, RESOURCE_LOG);
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [killed(hoursAgo(30), 'claude', 'OLD', 'old', 'killed (machine memory low)', 4), ''].join('\n'));
    const old = status();
    assert.strictEqual(old.status, 0, old.stderr);
    assert.doesNotMatch(old.stdout, /killed/, 'a kill older than a day does not read as current');

    const recent = hoursAgo(1);
    fs.appendFileSync(file, [
      killed(hoursAgo(3), 'codex', 'B', 'b', 'killed (cause unknown)', 70),
      JSON.stringify({ at: hoursAgo(2), phase: 'end', engine: 'cursor', task: 'C', run_id: 'c', code: 0 }),
      killed(recent, 'claude', 'HEAVY', 'h', 'killed (machine memory low)', 6),
      '',
    ].join('\n'));
    const loud = status();
    assert.strictEqual(loud.status, 0, loud.stderr);
    const when = `${recent.slice(0, 16).replace('T', ' ')} UTC`;
    assert.ok(loud.stdout.includes(`engine runs force-killed in the last day: 2, 1 with machine memory low; newest claude on HEAVY at ${when}, killed (machine memory low), 6% memory free`), loud.stdout);
    const history = readResourceHistory(root);
    assert.deepStrictEqual([history.kills, history.kills_day, history.low_memory_kills, history.low_memory_kills_day], [3, 2, 2, 1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status names the last day of engine errors with the newest reason, apart from kills', () => {
  const { spawnSync } = require('node:child_process');
  const fleet = require('../lib/fleet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-errors-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-errors-wt-'));
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const status = () => spawnSync(process.execPath, [cli, 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const file = path.join(root, RESOURCE_LOG);
  const old = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ at: old, phase: 'end', engine: 'codex', task: 'OLD', run_id: 'old', error: 'spawn codex ENOENT' })}\n`);
    const quiet = status();
    assert.strictEqual(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /ended in an error/, 'an error older than a day does not read as current');

    let failure;
    fleet.dispatchToEngine({
      task: { id: 'CLI-77', display_id: 'CLI-77', title: 'start a missing engine' },
      engine: 'cursor', worktreePath: worktree, root, skipBriefCapture: true,
      runner: () => {
        const run = spawnSync(missing, [], { encoding: 'utf8' });
        failure = run.error;
        return run;
      },
    });
    assert.equal(failure && failure.code, 'ENOENT');
    // A kill with an error is reported as a kill, not counted again here.
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), phase: 'end', engine: 'claude', task: 'CLI-78', run_id: 'k', signal: 'SIGKILL', cause: 'killed (cause unknown)', error: 'Command failed' })}\n`);
    const loud = status();
    assert.strictEqual(loud.status, 0, loud.stderr);
    const failedEnd = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find((entry) => entry.task === 'CLI-77' && entry.phase === 'end');
    const when = `${failedEnd.at.slice(0, 16).replace('T', ' ')} UTC`;
    assert.ok(loud.stdout.includes(`engine runs that ended in an error in the last day: 1, newest cursor on CLI-77 at ${when}: ${failure.message}`), loud.stdout);
    assert.doesNotMatch(loud.stdout, /Command failed/);
    assert.ok(loud.stdout.includes('engine runs force-killed in the last day: 1'), loud.stdout);
    console.log(`real landing status after a failed start:\n${loud.stdout.split('\n').filter((line) => /engine runs/.test(line)).join('\n')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('autopilot phases record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync } = require('node:child_process');
  const { executePhaseDetailed } = require('../commands/autopilot');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-phase-resource-')));
  const before = process.cwd();
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const phase = (cmdOverride) => {
    try {
      return { result: executePhaseDetailed('do', { task: 'fixture', kind: 'endgame' }, { verbose: false, timeout: 5000, cmdOverride }) };
    } catch (error) {
      return { error };
    }
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    process.chdir(root);
    const ok = phase('echo done');
    const killed = phase('sh -c "kill -KILL $$"');
    const failed = phase(missing);
    process.chdir(before);
    assert.equal(ok.result.output.trim(), 'done');
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'autopilot do');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    const killEnd = lines[3];
    assert.equal(killEnd.signal, 'SIGKILL');
    assert.match(killEnd.cause, /^killed \((machine memory low|cause unknown)\)$/);
    assert.match(killed.error.message, /^do phase killed by SIGKILL/);
    assert.ok(killed.error.message.includes(killEnd.cause), killed.error.message);
    const failEnd = lines[5];
    assert.equal(failEnd.signal, undefined);
    assert.match(failEnd.error, /not found|No such file/i);
    assert.ok(failed.result || failed.error, 'the failed start must return or throw');
    console.log(`autopilot phase readings: ${JSON.stringify([killEnd, failEnd])}`);
    console.log(`autopilot kill message: ${killed.error.message}`);
  } finally {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a kill sent by the run time limit names the time limit even with memory low', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-timeout-'));
  try {
    const lowMemory = { platform: 'darwin', run: fakeRun(PRESSURE_LOW, SWAP_FULL), loadavg: () => [9, 8, 7] };
    const timed = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'T', run_id: 'r1', signal: 'SIGKILL', timed_out: true }, lowMemory);
    assert.strictEqual(timed.cause, 'killed (time limit reached)');
    assert.strictEqual(timed.timed_out, true);
    const plain = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'T', run_id: 'r2', signal: 'SIGKILL' }, lowMemory);
    assert.strictEqual(plain.cause, 'killed (machine memory low)');
    assert.strictEqual(plain.timed_out, undefined);
    const term = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'T', run_id: 'r3', signal: 'SIGTERM', timed_out: true }, lowMemory);
    assert.strictEqual(term.timed_out, true);
    assert.strictEqual(term.cause, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status counts time limit kills apart and names the newest kill that was not a time limit', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-time-limit-'));
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const status = () => spawnSync(process.execPath, [cli, 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const killed = (at, task, cause, free, extra = {}) => JSON.stringify({ at, phase: 'end', engine: 'codex', task, run_id: task, signal: 'SIGKILL', cause, free_pct: free, ...extra });
  const timeLimit = (at, task) => killed(at, task, 'killed (time limit reached)', 70, { timed_out: true });
  const file = path.join(root, RESOURCE_LOG);
  const minute = (at) => `${at.slice(0, 16).replace('T', ' ')} UTC`;
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const firstTimeout = hoursAgo(4);
    fs.writeFileSync(file, [timeLimit(hoursAgo(5), 'SLOW1'), timeLimit(firstTimeout, 'SLOW2'), ''].join('\n'));
    const onlyTimeouts = status();
    assert.strictEqual(onlyTimeouts.status, 0, onlyTimeouts.stderr);
    assert.ok(onlyTimeouts.stdout.includes(`engine runs force-killed in the last day: 2, all at their time limit; newest codex on SLOW2 at ${minute(firstTimeout)}, killed (time limit reached), 70% memory free`), onlyTimeouts.stdout);

    const crash = hoursAgo(3);
    fs.appendFileSync(file, [killed(crash, 'HEAVY', 'killed (machine memory low)', 5), timeLimit(hoursAgo(1), 'SLOW3'), ''].join('\n'));
    const mixed = status();
    assert.strictEqual(mixed.status, 0, mixed.stderr);
    assert.ok(mixed.stdout.includes(`engine runs force-killed in the last day: 4, 3 at their time limit, 1 with machine memory low; newest not at a time limit: codex on HEAVY at ${minute(crash)}, killed (machine memory low), 5% memory free`), mixed.stdout);
    const history = readResourceHistory(root);
    assert.strictEqual(history.time_limit_kills_day, 3);
    assert.strictEqual(history.last_day_other_kill.task, 'HEAVY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris engine sweep names the newest engine error from a real failed start, apart from kills', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const { engineCommand } = require('../commands/engine');
  const fleet = require('../lib/fleet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-error-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-error-wt-'));
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const sweep = () => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    assert.doesNotMatch(sweep(), /last engine error/);
    let failure;
    fleet.dispatchToEngine({
      task: { id: 'CLI-77', display_id: 'CLI-77', title: 'start a missing engine' },
      engine: 'cursor', worktreePath: worktree, root, skipBriefCapture: true,
      runner: () => {
        const run = spawnSync(missing, [], { encoding: 'utf8' });
        failure = run.error;
        return run;
      },
    });
    assert.equal(failure && failure.code, 'ENOENT');
    // A later kill also carries an error, but it is already named as a kill.
    fs.appendFileSync(path.join(root, RESOURCE_LOG), `${JSON.stringify({ at: new Date().toISOString(), phase: 'end', engine: 'claude', task: 'CLI-78', signal: 'SIGKILL', cause: 'killed (cause unknown)', error: 'Command failed' })}\n`);
    const text = sweep();
    assert.match(text, new RegExp(`last engine error: cursor on CLI-77 at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC: ${failure.message.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.doesNotMatch(text, /Command failed/);
    console.log(`real sweep after a failed start:\n${text}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('atris engine sweep counts time limit kills apart and still names the newest kill that was not one', () => {
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-time-limit-'));
  const file = path.join(root, RESOURCE_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const timeLimit = (at, task) => JSON.stringify({ at, phase: 'end', engine: 'codex', task, run_id: task, free_pct: 70, signal: 'SIGKILL', timed_out: true, cause: 'killed (time limit reached)' });
  fs.writeFileSync(file, [
    JSON.stringify({ at: '2026-10-14T11:30:00.000Z', phase: 'end', engine: 'claude', task: 'CLI-2', run_id: 'crash', free_pct: 9, signal: 'SIGKILL', cause: 'killed (machine memory low)' }),
    timeLimit('2026-10-14T12:10:00.000Z', 'SLOW1'),
    timeLimit('2026-10-14T12:20:00.000Z', 'SLOW2'),
    '',
  ].join('\n'));
  const out = [];
  const original = console.log;
  console.log = (line) => out.push(String(line));
  try {
    engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
  } finally {
    console.log = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const text = out.join('\n');
  assert.match(text, /last SIGKILL: codex on SLOW2 at 2026-10-14 12:20 UTC, killed \(time limit reached\), 70% memory free/);
  assert.match(text, /last SIGKILL not at a time limit: claude on CLI-2 at 2026-10-14 11:30 UTC, killed \(machine memory low\), 9% memory free/);
  assert.match(text, /1 of 3 SIGKILLs ended with machine memory low, 2 at their time limit/);
});

test('the landing status counts leaked ssh-agents, says how they get stopped, and stays quiet with none or a failed read', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agents-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const status = (deps) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], deps);
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const leaked = status({ readSshAgents: () => ({ agents: [agent(200), agent(201), agent(202)], referenced: new Set([202]) }), uid: 501 });
    assert.match(leaked, /leaked ssh-agents on this machine: 2; stop them now: atris engine sweep --apply/);
    const none = status({ readSshAgents: () => ({ agents: [agent(300)], referenced: new Set([300]) }), uid: 501 });
    assert.doesNotMatch(none, /ssh-agents/);
    const broken = status({ readSshAgents: () => { throw new Error('ps missing'); }, uid: 501 });
    assert.doesNotMatch(broken, /ssh-agents/);
    assert.doesNotMatch(status(), /ssh-agents/, 'a test run never reads the real machine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status says how fast leaked ssh-agents grew since the oldest reading in the last day', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agent-growth-'));
  const file = path.join(root, RESOURCE_LOG);
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const agents = (n) => ({ readSshAgents: () => ({ agents: Array.from({ length: n }, (_, i) => agent(200 + i)), referenced: new Set() }), uid: 501 });
  const start = (msAgo, count, run) => JSON.stringify({ at: new Date(Date.now() - msAgo).toISOString(), phase: 'start', engine: 'claude', task: run, run_id: run, leaked_ssh_agents: count });
  const end = (run) => JSON.stringify({ at: new Date().toISOString(), phase: 'end', engine: 'claude', task: run, run_id: run });
  const status = (deps) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], deps);
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  const hour = 3600 * 1000;
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = new Date(Date.now() - 2 * hour).toISOString().slice(0, 16).replace('T', ' ');
    fs.writeFileSync(file, [
      start(30 * hour, 0, 'OLD'), end('OLD'),
      start(2 * hour, 1, 'A'), end('A'),
      start(hour, 3, 'B'), end('B'),
      JSON.stringify({ at: new Date(Date.now() - hour / 2).toISOString(), phase: 'start', engine: 'codex', task: 'C', run_id: 'C', leaked_ssh_agents: null }), end('C'),
      '',
    ].join('\n'));
    const growing = status(agents(5));
    assert.match(growing, new RegExp(`leaked ssh-agents on this machine: 5, up from 1 at ${first} UTC, about 2 more an hour; stop them now`));
    const flat = status(agents(1));
    assert.match(flat, /leaked ssh-agents on this machine: 1; stop them now/, 'no growth, no growth note');
    fs.writeFileSync(file, `${start(30 * hour, 0, 'OLD')}\n`);
    assert.match(status(agents(4)), /leaked ssh-agents on this machine: 4; stop them now/, 'a reading older than a day is not used');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris engine sweep says how fast leaked ssh-agents grew, the same way the landing status does', () => {
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-agent-growth-'));
  const file = path.join(root, RESOURCE_LOG);
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const hour = 3600 * 1000;
  const sweep = (n) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: Array.from({ length: n }, (_, i) => agent(200 + i)), referenced: new Set() }), uid: 501 } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date(Date.now() - 2 * hour).toISOString();
    fs.writeFileSync(file, [
      JSON.stringify({ at, phase: 'start', engine: 'claude', task: 'A', run_id: 'A', leaked_ssh_agents: 1 }),
      JSON.stringify({ at: new Date().toISOString(), phase: 'end', engine: 'claude', task: 'A', run_id: 'A' }),
      '',
    ].join('\n'));
    const first = at.slice(0, 16).replace('T', ' ');
    assert.match(sweep(5), new RegExp(`5 ssh-agents running, 5 look leaked, up from 1 at ${first} UTC, about 2 more an hour \\(no parent`));
    assert.match(sweep(1), /1 ssh-agent running, 1 looks leaked \(no parent/, 'no growth, no growth note');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('after a sweep stops agents, the growth note counts from what that sweep left', () => {
  const { leakGrowthNote } = require('../lib/engine-resource');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-sweep-baseline-'));
  const file = path.join(root, RESOURCE_LOG);
  const hour = 3600 * 1000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sweepAt = ago(2 * hour);
    fs.writeFileSync(file, [
      JSON.stringify({ at: ago(5 * hour), phase: 'start', engine: 'claude', task: 'A', run_id: 'A', leaked_ssh_agents: 300 }),
      JSON.stringify({ at: sweepAt, phase: 'sweep', stopped: [1, 2, 3], failed: [], skipped: [], leaked_ssh_agents: 10 }),
      JSON.stringify({ at: ago(hour), phase: 'sweep', stopped: [], failed: [], skipped: [], leaked_ssh_agents: 40 }),
      JSON.stringify({ at: ago(hour / 2), phase: 'start', engine: 'claude', task: 'B', run_id: 'B', leaked_ssh_agents: 70 }),
      '',
    ].join('\n'));
    const reading = readResourceHistory(root).first_day_leak_reading;
    assert.strictEqual(reading.at, sweepAt, 'the newest sweep that stopped agents is the baseline, not an older start or an idle sweep');
    const when = sweepAt.slice(0, 16).replace('T', ' ');
    assert.strictEqual(leakGrowthNote(reading, 90), `, up from 10 left by the sweep at ${when} UTC, about 40 more an hour`);
    assert.strictEqual(leakGrowthNote(reading, 10), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only ask run writes a start and an end reading, and a run past its time limit says so', async () => {
  const { runEngineAskJobs } = require('../lib/engine-ask');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-ask-'));
  const bin = path.join(root, 'bin');
  const savedPath = process.env.PATH;
  try {
    fs.mkdirSync(bin);
    // A stand-in engine: answers at once unless the prompt asks it to hang.
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'case "$*" in *hang*) sleep 5 ;; esac',
      'echo "the answer is 42"',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    const answers = await runEngineAskJobs([
      { engine: 'claude', model: '', prompt: 'what is six times seven', label: 'quick' },
      { engine: 'claude', model: '', prompt: 'hang here', label: 'slow' },
    ], { root, timeoutMs: 1000, concurrency: 1 });
    assert.strictEqual(answers[0].ok, true, answers[0].stderr);
    assert.strictEqual(answers[1].timed_out, true);
    const log = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(log.map((e) => [e.phase, e.engine, e.task]), [
      ['start', 'claude', 'ask quick'], ['end', 'claude', 'ask quick'],
      ['start', 'claude', 'ask slow'], ['end', 'claude', 'ask slow'],
    ]);
    assert.strictEqual(log[0].run_id, log[1].run_id);
    assert.notStrictEqual(log[0].run_id, log[2].run_id);
    assert.ok(Array.isArray(log[0].load) && Number.isFinite(log[1].duration_ms));
    assert.strictEqual(log[1].timed_out, undefined);
    assert.strictEqual(log[3].timed_out, true, 'the end line says the run passed its time limit');
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mission runners record paired readings on success, SIGKILL and startup failure', () => {
  const { spawnSync } = require('node:child_process');
  const { withMissionFullJson } = require('./helpers/mission-json');
  const { scrubAgentEnv } = require('./helpers/agent-env');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-mission-tick-'));
  const runnerEnv = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_DISPATCH_DEPTH', 'ATRIS_DISPATCH_MAX_DEPTH'];
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const run = (args) => {
    const clean = scrubAgentEnv(process.env);
    for (const name of runnerEnv) delete clean[name];
    return spawnSync(process.execPath, [cli, ...withMissionFullJson(args)], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...clean,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        HOME: home,
        ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db'),
        CODEX_HOME: path.join(home, '.codex'),
        ATRIS_MACHINE_ROSTER_PATH: path.join(home, 'roster.json'),
        ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, 'roster.md'),
        ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'roster-sessions'),
        PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      },
    });
  };
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['codex', 'claude']) {
      // The claude runner reads --help for the flags it needs before a tick.
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nif [ "$1" = --help ]; then echo '--output-format --permission-mode --resume --session-id --include-partial-messages --verbose --model --effort'; exit 0; fi\necho ${name} tick\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    const ids = [];
    for (const runner of ['codex', 'claude']) {
      const started = run(['mission', 'start', `${runner} reading tick`, '--owner', 'mission-lead', '--runner', runner, '--no-verify', '--json']);
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);
      const mission = JSON.parse(started.stdout).mission;
      ids.push(mission.id);
      const ran = run(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json']);
      assert.strictEqual(ran.status, 0, ran.stderr || ran.stdout);
    }
    const log = fs.readFileSync(path.join(dir, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(log.map((e) => [e.phase, e.engine, e.task]), [
      ['start', 'codex', ids[0]], ['end', 'codex', ids[0]],
      ['start', 'claude', ids[1]], ['end', 'claude', ids[1]],
    ]);
    assert.strictEqual(log[0].run_id, log[1].run_id);
    assert.strictEqual(log[2].run_id, log[3].run_id);
    assert.notStrictEqual(log[0].run_id, log[2].run_id);
    assert.ok(log.filter((entry) => entry.phase === 'end').every((entry) => entry.duration_ms >= 0));
    assert.ok(Array.isArray(log[0].load) && Number.isFinite(log[1].duration_ms) && Number.isFinite(log[3].duration_ms));
    for (const runner of ['codex', 'claude']) {
      fs.writeFileSync(path.join(bin, runner), `#!/bin/sh\nif [ "$1" = --help ]; then echo '--output-format --permission-mode --resume --session-id --include-partial-messages --verbose --model --effort'; exit 0; fi\nkill -9 $$\n`);
      const started = run(['mission', 'start', `${runner} killed reading`, '--owner', 'mission-lead', '--runner', runner, '--no-verify', '--json']);
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);
      const mission = JSON.parse(started.stdout).mission;
      const ran = run(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json']);
      assert.strictEqual(ran.error, undefined, ran.stderr || ran.stdout);
      const killed = fs.readFileSync(path.join(dir, RESOURCE_LOG), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).filter((entry) => entry.task === mission.id);
      assert.deepStrictEqual(killed.map((entry) => entry.phase), ['start', 'end']);
      assert.strictEqual(killed[0].run_id, killed[1].run_id);
      assert.strictEqual(killed[1].signal, 'SIGKILL', `${runner}: ${ran.stdout}`);
      assert.strictEqual(killed[1].cause, killedCauseText(killed[1]));
      assert.strictEqual(killed[1].timed_out, undefined);
      assert.ok(Number.isFinite(killed[1].duration_ms) && killed[1].duration_ms >= 0);
      console.log(`${runner} force-kill CLI exit ${ran.status}: ${JSON.stringify(killed[1])}`);
    }
    for (const runner of ['codex', 'claude']) {
      // Claude must pass its help probe, then disappear before the actual spawn.
      // The generic runner starts through a shell, which reports the missing interpreter.
      fs.writeFileSync(path.join(bin, runner), runner === 'claude'
        ? '#!/bin/sh\nif [ "$1" = --help ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; rm -- "$0"; exit 0; fi\nexit 99\n'
        : `#!${path.join(dir, 'missing-interpreter')}\n`);
      const started = run(['mission', 'start', `${runner} startup failure reading`, '--owner', 'mission-lead', '--runner', runner, '--no-verify', '--json']);
      assert.strictEqual(started.status, 0, started.stderr || started.stdout);
      const mission = JSON.parse(started.stdout).mission;
      const ran = run(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json']);
      assert.strictEqual(ran.error, undefined, ran.stderr || ran.stdout);
      assert.ok(ran.stdout.trim(), `${runner}: exit ${ran.status}, stderr ${ran.stderr}`);
      const result = JSON.parse(ran.stdout);
      if (runner === 'claude') {
        assert.strictEqual(result.ticks[0].status, 'errored');
        assert.strictEqual(result.ticks[0].claude.ok, false);
      } else {
        assert.match(JSON.stringify(result), /not found|No such file/i, `${runner}: startup must fail`);
      }
      assert.strictEqual(fs.existsSync(path.join(bin, 'claude')), runner !== 'claude');
      const failed = fs.readFileSync(path.join(dir, RESOURCE_LOG), 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line)).filter((entry) => entry.task === mission.id);
      assert.deepStrictEqual(failed.map((entry) => entry.phase), ['start', 'end']);
      assert.strictEqual(failed[0].run_id, failed[1].run_id);
      assert.ok(Array.isArray(failed[0].load) && Array.isArray(failed[1].load));
      assert.ok(Number.isInteger(failed[1].duration_ms) && failed[1].duration_ms >= 0);
      assert.strictEqual(failed[1].signal, undefined);
      assert.strictEqual(failed[1].cause, undefined);
      assert.strictEqual(failed[1].timed_out, undefined);
      const startupError = result.ticks[0].claude.error || result.ticks[0].claude.stderr;
      assert.ok(startupError, `${runner}: the runner result must retain its startup error`);
      assert.strictEqual(failed[1].error, startupError, `${runner}: the end reading must retain the original startup error`);
      console.log(`${runner} startup failure CLI exit ${ran.status}: ${JSON.stringify(failed[1])}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
