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
    recordEngineResource(root, { phase: 'start', engine: 'codex', task: 'CLI-1' }, deps);
    const end = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'CLI-1', signal: 'SIGKILL' }, deps);
    assert.strictEqual(end.cause, 'killed (machine memory low)');
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(lines[0], {
      at: '2026-10-14T08:00:00.000Z', phase: 'start', engine: 'codex', task: 'CLI-1',
      free_pct: 9, swap_used_mb: 512.25, swap_total_mb: 2048, load: [4, 3, 2],
    });
    assert.strictEqual(lines[1].phase, 'end');
    assert.strictEqual(lines[1].signal, 'SIGKILL');
    assert.strictEqual(lines[1].cause, 'killed (machine memory low)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { parseElapsed, findLeakedSshAgents, readSshAgents } = require('../lib/engine-resource');

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
