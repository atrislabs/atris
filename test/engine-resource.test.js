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
      leaked_ssh_agents: 0,
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
  assert.deepStrictEqual(log, [{ at: '2026-10-14T12:00:00.000Z', phase: 'sweep', stopped: [200], failed: [], skipped: [201, 202] }]);
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
    assert.deepStrictEqual(readResourceHistory(path.join(root, 'missing')), { last_sweep: null, last_kill: null, kills: 0, low_memory_kills: 0 });
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
  const file = path.join(repoRoot, RESOURCE_LOG);
  const size = () => (fs.existsSync(file) ? fs.statSync(file).size : 0);
  const before = size();
  const entry = recordEngineResource(repoRoot, { phase: 'end', engine: 'cursor', task: 'CLI-TEST-ONLY', signal: 'SIGKILL' }, { platform: 'linux', loadavg: () => [0, 0, 0] });
  assert.strictEqual(entry.cause, 'killed (cause unknown)');
  assert.strictEqual(size(), before);
});
