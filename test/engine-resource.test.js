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
  parseBusiest,
  killLoadText,
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

test('mac readings and the agent scan still find their system tools when the search path is narrow', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('node:child_process');
  // A launch from cron or launchd can carry a path without the system tools
  // folders. Every tool call the readings make must still start.
  const probe = `
    const cp = require('child_process');
    const real = cp.spawnSync;
    const calls = [];
    cp.spawnSync = (cmd, args, opts) => {
      const result = real(cmd, args, opts);
      calls.push({ cmd: require('path').basename(cmd), missing: Boolean(result.error && result.error.code === 'ENOENT') });
      return result;
    };
    const { readMachineResources, readSshAgents } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'engine-resource'))});
    const snap = readMachineResources();
    readSshAgents();
    process.stdout.write(JSON.stringify({ snap, calls }));
  `;
  const ran = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { HOME: os.homedir(), PATH: '/nonexistent' } });
  assert.equal(ran.status, 0, ran.stderr);
  const { snap, calls } = JSON.parse(ran.stdout);
  assert.deepEqual(calls.map((call) => call.cmd).sort(), ['lsof', 'memory_pressure', 'ps', 'ps', 'sysctl']);
  assert.deepEqual(calls.filter((call) => call.missing), []);
  assert.equal(typeof snap.free_pct, 'number');
  assert.equal(typeof snap.swap_total_mb, 'number');
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
      pid: process.pid, leaked_ssh_agents: null,
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
  assert.match(text, /^0 leaked ssh-agents still left on this machine$/m);
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
  assert.match(text, /^1 leaked ssh-agent still left on this machine$/m, 'the agent it could not stop is still counted');
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

test('atris engine sweep names the shell startup line that starts an agent per shell', () => {
  const { engineCommand } = require('../commands/engine');
  const { findAgentStartLines } = require('../lib/engine-resource');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-home-'));
  try {
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"  # Start SSH agent\n# eval "$(ssh-agent -s)"\nexport PATH\n');
    fs.writeFileSync(path.join(home, '.bashrc'), 'echo ssh-agent is handy\n');
    assert.deepStrictEqual(findAgentStartLines({ home }), [{ file: '~/.zshrc', line: 1, fix: '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"' }]);
    assert.deepStrictEqual(findAgentStartLines({ home: path.join(home, 'missing') }), []);

    const sweep = (agents, json) => {
      const out = [];
      const original = console.log;
      console.log = (line) => out.push(String(line));
      try {
        engineCommand(['sweep', ...(json ? ['--json'] : [])], { engineSweep: { read: () => ({ agents, referenced: new Set() }), uid: 501, home } });
      } finally {
        console.log = original;
      }
      return out.join('\n');
    };
    const leaked = [{ pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' }];
    assert.match(sweep(leaked), /likely source: ~\/\.zshrc line 1 starts a new ssh-agent in every shell that reads it/);
    assert.deepStrictEqual(JSON.parse(sweep(leaked, true)).agent_start_lines.map(({ file, line }) => ({ file, line })), [{ file: '~/.zshrc', line: 1 }]);
    assert.doesNotMatch(sweep([]), /likely source/, 'no leak, no source line');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the sweep offers a guarded line only for a lone unguarded agent start', () => {
  const { engineCommand } = require('../commands/engine');
  const { findAgentStartLines, agentStartLineText } = require('../lib/engine-resource');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-fix-'));
  try {
    fs.writeFileSync(path.join(home, '.zshrc'), [
      'eval "$(ssh-agent -s)"  # Start SSH agent',
      '[ -n "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"',
      'if true; then eval `ssh-agent -s`; fi',
    ].join('\n'));
    assert.deepStrictEqual(findAgentStartLines({ home }), [
      { file: '~/.zshrc', line: 1, fix: '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"' },
      { file: '~/.zshrc', line: 3 },
    ]);
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep'], { engineSweep: { read: () => ({ agents: [{ pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' }], referenced: new Set() }), uid: 501, home } });
    } finally {
      console.log = original;
    }
    const text = out.join('\n');
    assert.match(text, /likely source: ~\/\.zshrc line 1 starts a new ssh-agent in every shell that reads it, including the shells Claude and Codex start in each session that runs a command; to start one only when none is reachable, change it to: \[ -S "\$SSH_AUTH_SOCK" \] \|\| eval "\$\(ssh-agent -s\)"/);
    assert.match(text, /likely source: ~\/\.zshrc line 3 starts a new ssh-agent in every shell that reads it, including the shells Claude and Codex start in each session that runs a command\n/);
    assert.strictEqual(agentStartLineText({ file: '~/.profile', line: 2 }), 'likely source: ~/.profile line 2 starts a new ssh-agent in every shell that reads it', 'a file neither engine was seen reading is not tied to engine sessions');
    assert.match(agentStartLineText({ file: '~/.zprofile', line: 4 }), /line 4 starts a new ssh-agent in every shell that reads it, including the shells Claude and Codex start in each session that runs a command$/, 'the login files both engines read are named too');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the sweep guards a lone agent start in the startup files only when asked, keeping the old file', async () => {
  const { engineCommand } = require('../commands/engine');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fix-startup-'));
  const run = (args) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    let code;
    try {
      code = engineCommand(['sweep', ...args], { engineSweep: { read: () => ({ agents: [{ pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' }], referenced: new Set() }), uid: 501, home, atrisCommand: 'atris' } });
    } finally {
      console.log = original;
    }
    return { code, text: out.join('\n') };
  };
  try {
    const before = ['export A=1', '  eval "$(ssh-agent -s)"  # Start SSH agent', 'if true; then eval `ssh-agent -s`; fi', ''].join('\n');
    fs.writeFileSync(path.join(home, '.zshrc'), before);
    fs.writeFileSync(path.join(home, '.zprofile'), 'eval $(ssh-agent -c)\n');
    const listing = run([]);
    assert.match(listing.text, /to make that change, run atris engine sweep --fix-startup; it saves the old file beside it first/);
    assert.strictEqual(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before, 'the listing alone changes nothing');
    const fixed = run(['--fix-startup']);
    assert.strictEqual(fixed.code, 0);
    const backups = fs.readdirSync(home).filter((name) => /^\.zshrc\.atris-\d{14}\.bak$/.test(name));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(home, backups[0]), 'utf8'), before, 'the old file is kept as it was');
    const guarded = '  [ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"  # Start SSH agent';
    assert.strictEqual(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ['export A=1', guarded, 'if true; then eval `ssh-agent -s`; fi', ''].join('\n'));
    assert.strictEqual(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), '[ -S "$SSH_AUTH_SOCK" ] || eval $(ssh-agent -c)\n');
    assert.ok(fixed.text.includes(`changed ~/.zshrc line 2 to: [ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)" (old file saved as ~/${backups[0]})`), fixed.text);
    assert.match(fixed.text, /left ~\/\.zshrc line 3 as is: it does more than start an agent, so change it by hand/);
    assert.match(fixed.text, /run atris engine sweep --apply to stop the ones already leaked/);
    const again = run(['--fix-startup']);
    assert.strictEqual(again.text, 'left ~/.zshrc line 3 as is: it does more than start an agent, so change it by hand', 'a second run changes nothing');
    // The guarded line skips a new agent while a socket is reachable and
    // starts one when none is, in the shell that reads it.
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh-agent'), '#!/bin/sh\necho started >> "$HOME/agent-starts"\necho "SSH_AGENT_PID=1; export SSH_AGENT_PID;"\n', { mode: 0o755 });
    const shell = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
    const runLine = (socket) => require('node:child_process').spawnSync(shell, ['-c', guarded], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...(socket ? { SSH_AUTH_SOCK: socket } : {}) } });
    const socket = path.join(home, 'agent.sock');
    const server = require('node:net').createServer();
    await new Promise((resolve) => server.listen(socket, resolve));
    try {
      assert.strictEqual(runLine(socket).status, 0);
      assert.ok(!fs.existsSync(path.join(home, 'agent-starts')), 'a reachable socket starts no agent');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.strictEqual(runLine(null).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(home, 'agent-starts'), 'utf8'), 'started\n', 'no socket starts one agent');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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

test('the agent scan names a reader it could not run, so an empty leak list is not read as clean', () => {
  const agentLine = '  200     1   501    14:50:14 ssh-agent -s';
  const scan = ({ env = true, sockets = true, agents = true } = {}) => readSshAgents({ run: (cmd, args) => {
    if (cmd === 'lsof') return sockets ? { status: 0, stdout: 'p200\nf3\nn/tmp/ssh-a/agent.199' } : { status: 1, stdout: '' };
    if (args.includes('-E')) return env ? { status: 0, stdout: '  300 SHELL=/bin/zsh' } : { status: 1, stdout: '' };
    return { status: 0, stdout: agents ? agentLine : '' };
  } });
  assert.deepStrictEqual(scan().unread, []);
  assert.deepStrictEqual(scan({ env: false }).unread, ['process environments']);
  assert.deepStrictEqual(scan({ sockets: false }).unread, ['agent sockets']);
  // With no agents running, lsof finds no sockets, and that is a clean answer.
  assert.deepStrictEqual(scan({ sockets: false, agents: false }).unread, []);
});

test('partial socket scans keep unreadable agents safe and name the missing reading', () => {
  const scan = readSshAgents({ run: (cmd, args) => {
    if (cmd === 'lsof') return { status: 0, stdout: 'p200\nn/tmp/ssh-a/agent.199' };
    if (args.includes('-E')) return { status: 0, stdout: '300 SHELL=/bin/zsh' };
    return { status: 0, stdout: '200 1 501 01:00:00 ssh-agent -s\n201 1 501 01:00:00 ssh-agent -s' };
  } });
  assert.deepStrictEqual(scan.unread, ['agent sockets']);
  assert.ok(scan.referenced.has(201));
  assert.ok(!scan.referenced.has(200));
  assert.deepStrictEqual(findLeakedSshAgents(scan.agents, { referenced: scan.referenced, uid: 501 }).map((agent) => agent.pid), [200]);
});

test('the real sweep warns when one live agent socket reading is withheld', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-partial-sockets-'));
  const pids = [];
  try {
    for (const name of ['visible', 'hidden']) {
      const started = spawnSync('/usr/bin/ssh-agent', ['-s', '-a', path.join(root, name)], { encoding: 'utf8', timeout: 10000 });
      const pid = Number((/SSH_AGENT_PID=(\d+)/.exec(started.stdout) || [])[1]);
      if (pid) pids.push(pid);
      assert.equal(started.status, 0, started.stderr);
      assert.ok(pid);
    }
    // Use real process and socket scans, withholding only the second agent's
    // socket block to reproduce a partially unreadable process on this host.
    const preload = path.join(root, 'withhold-socket.cjs');
    fs.writeFileSync(preload, `
      const cp = require('node:child_process');
      const real = cp.spawnSync;
      cp.spawnSync = (cmd, args, opts) => {
        const reading = real(cmd, args, opts);
        if (require('node:path').basename(cmd) === 'lsof') {
          let hidden = false;
          reading.stdout = String(reading.stdout || '').split('\\n').filter(line => {
            if (line.startsWith('p')) hidden = line === 'p${pids[1]}';
            return !hidden;
          }).join('\\n');
        }
        return reading;
      };
    `);
    const env = { ...process.env };
    delete env.SSH_AGENT_PID;
    delete env.SSH_AUTH_SOCK;
    const cli = path.join(__dirname, '..', 'bin', 'atris.js');
    const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /could not read the agent sockets for every process/);
    assert.match(ran.stdout, /the leak count may be incomplete/);
    const json = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.ok(report.running >= 2);
    assert.deepStrictEqual(report.unread, ['agent sockets']);
    assert.ok(!report.leaked.some(agent => agent.pid === pids[1]));
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
    console.log('partial live socket scan exit ' + ran.status + ': ' + ran.stdout.trim());
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris engine sweep says when a reader could not run, in text and json', () => {
  const { engineCommand } = require('../commands/engine');
  const read = () => ({
    agents: [{ pid: 200, ppid: 1, uid: 501, age_sec: 53414, args: 'ssh-agent -s' }],
    referenced: new Set([200]),
    unread: ['agent sockets'],
  });
  const run = (args) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep', ...args], { root: os.tmpdir(), engineSweep: { read, uid: 501 } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  const text = run([]);
  assert.match(text, /1 ssh-agent running, leak count unknown \(no parent/);
  assert.match(text, /^could not read the agent sockets for every process, so some ssh-agents could not be checked; the leak count may be incomplete$/m);
  assert.deepStrictEqual(JSON.parse(run(['--json'])).unread, ['agent sockets']);
  const clean = (() => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep'], { root: os.tmpdir(), engineSweep: { read: () => ({ agents: [], referenced: new Set(), unread: [] }), uid: 501 } });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  })();
  assert.doesNotMatch(clean, /could not read/);
});

for (const [unread, referenced, sweepCount, landingCount] of [
  [['agent sockets'], [], /^1 ssh-agent running, at least 1 looks leaked \(no parent/m, /leaked ssh-agents on this machine: at least 1;/],
  [['process environments'], [200], /^1 ssh-agent running, leak count unknown \(no parent/m, /leaked ssh-agents on this machine: unknown, /],
  [['process list'], null, /^running ssh-agents could not be counted, leak count unknown \(no parent/m, /leaked ssh-agents on this machine: unknown, /],
]) {
test(`sweep and landing status give the same qualified count when the ${unread[0]} could not be read`, () => {
  const { engineCommand } = require('../commands/engine');
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-landing-unread-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-landing-home-'));
  const agents = referenced ? [{ pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' }] : [];
  const read = () => ({ agents, referenced: new Set(referenced || []), unread });
  const capture = (fn) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try { fn(); } finally { console.log = original; }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const sweep = capture(() => engineCommand(['sweep'], { root, engineSweep: { read, uid: 501, home } }));
    const landing = capture(() => showStatus(root, [], { readSshAgents: read, uid: 501, home, atrisCommand: 'atris', pathAtrisRecordsRuns: true }));
    assert.match(sweep, sweepCount);
    assert.match(landing, landingCount);
    assert.ok(sweep.includes(`could not read the ${unread[0]}`));
    assert.ok(landing.includes(`could not read the ${unread[0]}, so some ssh-agents went unchecked`));
    assert.doesNotMatch(sweep, /^\d+ ssh-agents? running, 0 look leaked/m, 'a partial scan never reads as a clean zero');
    console.log(`partial ${unread[0]}: sweep "${sweep.split('\n')[0].replace(/ \(no parent.*/, '')}" / landing "${landing.split('\n').find((line) => /leaked ssh-agents on this machine/.test(line)).trim()}"`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
}

test('atris engine sweep json comes through a pipe whole when it is larger than the pipe buffer', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-pipe-')));
  try {
    // One engine error long enough to push the json past 64 KB.
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const error = `pipe proof ${'x'.repeat(96 * 1024)}`;
    fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), phase: 'end', engine: 'codex', task: 'pipe', run_id: 'pipe-1', error })}\n`);
    const ran = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'engine', 'sweep', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(ran.stdout.length > 64 * 1024, `json must exceed a pipe buffer, got ${ran.stdout.length} bytes`);
    const out = JSON.parse(ran.stdout);
    assert.equal(out.history.last_error.error, error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    assert.deepStrictEqual(receipt.ssh_agent_sweep, { stopped: [200], failed: [], skipped: [201], left: 0 });
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

test('the hourly landing pass stops at most its cap, oldest first, and names the rest', () => {
  const { runSshAgentSweep, sshAgentSweepNote, HOURLY_SSH_AGENT_STOP_LIMIT } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-cap-'));
  try {
    const agent = (pid, age_sec) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
    const agents = [agent(200, 3600), agent(201, 7200), agent(202, 5400), agent(203, 1800)];
    const signals = [];
    const receipt = {};
    runSshAgentSweep(root, receipt, { read: () => ({ agents, referenced: new Set() }), uid: 501, limit: 2, kill: (pid, signal) => signals.push([pid, signal]) });
    assert.deepStrictEqual(signals, [[201, 'SIGTERM'], [202, 'SIGTERM']]);
    assert.deepStrictEqual(receipt.ssh_agent_sweep, { stopped: [201, 202], failed: [], skipped: [], deferred: [200, 203], left: 2 });
    assert.strictEqual(sshAgentSweepNote(receipt), ', stopped 2 leaked ssh-agents, left 2 more leaked ssh-agents for the next pass');
    const saved = JSON.parse(fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8'));
    assert.deepStrictEqual(saved.deferred, [200, 203]);
    assert.strictEqual(saved.leaked_ssh_agents, 2, 'the growth note counts from what the capped pass left');

    const many = Array.from({ length: HOURLY_SSH_AGENT_STOP_LIMIT + 3 }, (_, i) => agent(1000 + i, 3600));
    const full = {};
    let calls = 0;
    runSshAgentSweep(root, full, { read: () => ({ agents: many, referenced: new Set() }), uid: 501, kill: () => { calls += 1; } });
    assert.strictEqual(calls, HOURLY_SSH_AGENT_STOP_LIMIT);
    assert.strictEqual(full.ssh_agent_sweep.deferred.length, 3);
    assert.strictEqual(sshAgentSweepNote({ ssh_agent_sweep: { deferred: [200] } }), ', left 1 more leaked ssh-agent for the next pass');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly landing pass names unreadable agent scans instead of staying quiet', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-unread-'));
  try {
    const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
    const blind = {};
    runSshAgentSweep(root, blind, {
      read: () => ({ agents: [], referenced: new Set(), unread: ['process list'] }),
      uid: 501,
      kill: () => assert.fail('an unread machine stops nothing'),
    });
    assert.deepStrictEqual(blind.ssh_agent_sweep, { stopped: [], failed: [], skipped: [], unread: ['process list'] });
    assert.strictEqual(sshAgentSweepNote(blind), ', could not read the process list, so some ssh-agents went unchecked');

    const reads = [
      { agents: [agent(200), agent(201)], referenced: new Set([201]), unread: ['agent sockets'] },
      { agents: [agent(200)], referenced: new Set([200]), unread: ['process environments'] },
    ];
    const partial = {};
    runSshAgentSweep(root, partial, { read: () => reads.shift(), uid: 501, kill: () => assert.fail('an unread recheck stops nothing') });
    assert.deepStrictEqual(partial.ssh_agent_sweep, { stopped: [], failed: [], skipped: [200], unread: ['agent sockets', 'process environments'] });
    assert.strictEqual(sshAgentSweepNote(partial),
      ', could not read the agent sockets or the process environments, so some ssh-agents went unchecked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly cleanup summary names younger replacements alongside stops and unread scans', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-replaced-'));
  try {
    const agent = (pid, age_sec = 3600) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
    const reads = [
      { agents: [agent(200), agent(201)], referenced: new Set() },
      { agents: [agent(200, 900), agent(201, 3601)], referenced: new Set(), unread: ['agent sockets'] },
    ];
    const signals = [];
    const receipt = {};
    runSshAgentSweep(root, receipt, { read: () => reads.shift(), uid: 501, kill: (pid, signal) => signals.push([pid, signal]) });
    assert.deepStrictEqual(signals, [[201, 'SIGTERM']]);
    assert.deepStrictEqual(receipt.ssh_agent_sweep.replaced, [200]);
    assert.strictEqual(sshAgentSweepNote(receipt), ', stopped 1 leaked ssh-agent, left 1 younger replacement ssh-agent alone, could not read the agent sockets, so some ssh-agents went unchecked');
    assert.strictEqual(sshAgentSweepNote({ ssh_agent_sweep: { replaced: [200, 201] } }), ', left 2 younger replacement ssh-agents alone');
    assert.strictEqual(sshAgentSweepNote({ ssh_agent_sweep: { skipped: [200] } }), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly cleanup summary reports failed stops alongside other outcomes', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-failed-'));
  try {
    // An exited child reproduces an agent disappearing after the final scan.
    // Probe with signal 0 so a reused pid cannot stop an unrelated process.
    const exited = require('node:child_process').spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
    assert.equal(exited.status, 0);
    assert.ok(exited.pid);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const receipt = {};
    runSshAgentSweep(root, receipt, {
      uid,
      read: () => ({ agents: [{ pid: exited.pid, ppid: 1, uid, age_sec: 3600, args: 'ssh-agent -s' }], referenced: new Set() }),
      kill: (pid, signal) => {
        assert.equal(signal, 'SIGTERM');
        process.kill(pid, 0);
      },
    });
    assert.deepStrictEqual(receipt.ssh_agent_sweep.failed, [{ pid: exited.pid, code: 'ESRCH' }]);
    assert.deepStrictEqual(receipt.ssh_agent_sweep.stopped, []);
    assert.strictEqual(sshAgentSweepNote(receipt), ', could not stop 1 leaked ssh-agent');
    const saved = JSON.parse(fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8'));
    assert.deepStrictEqual(saved.failed, [exited.pid]);
    assert.strictEqual(saved.leaked_ssh_agents, 1);
    assert.strictEqual(sshAgentSweepNote({ ssh_agent_sweep: {
      stopped: [200], failed: [{ pid: 201, code: 'EPERM' }, { pid: 202, code: 'ESRCH' }],
      replaced: [203], unread: ['agent sockets'],
    } }), ', stopped 1 leaked ssh-agent, could not stop 2 leaked ssh-agents, left 1 younger replacement ssh-agent alone, could not read the agent sockets, so some ssh-agents went unchecked');
    console.log('real stop failure: ' + sshAgentSweepNote(receipt).slice(2));
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

test('the hourly cleanup summary reports thrown scans and rechecks', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-scan-error-'));
  try {
    // A real missing executable exercises the same child-process failure as ps.
    const readFailure = () => require('node:child_process').execFileSync(path.join(root, 'missing-ps'));
    for (const failOnRecheck of [false, true]) {
      let reads = 0;
      const receipt = {};
      runSshAgentSweep(root, receipt, {
        uid: 501,
        read: () => {
          if (!failOnRecheck || reads++) return readFailure();
          return { agents: [{ pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' }], referenced: new Set() };
        },
        kill: () => assert.fail('a failed scan must stop nothing'),
      });
      assert.match(receipt.ssh_agent_sweep_error, /ENOENT/);
      assert.equal(sshAgentSweepNote(receipt), ', could not scan ssh-agents, so leaked agents may remain');
      assert.equal(fs.existsSync(path.join(root, RESOURCE_LOG)), false);
      console.log('real scan failure: ' + sshAgentSweepNote(receipt).slice(2));
    }
    assert.equal(sshAgentSweepNote({}), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    assert.deepStrictEqual(readResourceHistory(path.join(root, 'missing')), { last_sweep: null, last_kill: null, kills: 0, low_memory_kills: 0, time_limit_kills: 0, last_other_kill: null, kills_day: 0, low_memory_kills_day: 0, time_limit_kills_day: 0, crowded_time_limit_kills_day: 0, crowded_peak_open_runs: 0, crowded_top_busiest: null, last_day_other_kill: null, open_runs: 0, parent_gone: 0, still_running: 0, last_open: null, lost_closed: 0, lost_closed_day: 0, last_lost_closed: null, first_day_leak_reading: null, start_lines_guarded: null, last_error: null, errors_day: 0, last_day_error: null, read_error: null });
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
    // A running length, since joining every line on each pass took seconds.
    let size = lines.join('\n').length;
    while (size < MAX_LOG_BYTES) {
      const added = [old(`filler-${lines.length}`, 'start'), old(`filler-${lines.length}`, 'end')];
      lines.push(...added);
      size += added.reduce((sum, line) => sum + line.length + 1, 0);
    }
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
    // A running length, as in the full log test; joining on each pass is quadratic.
    let size = lines.join('\n').length;
    while (size < 1.2 * 1024 * 1024) {
      const added = [line(`done-${lines.length}`, 'start'), line(`done-${lines.length}`, 'end')];
      lines.push(...added);
      size += added.reduce((sum, entry) => sum + entry.length + 1, 0);
    }
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

test('the hourly cleanup summary reports lost run close failures', () => {
  const { spawnSync } = require('node:child_process');
  const { runLostRunSweep, lostRunSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-lost-error-'));
  try {
    const exited = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
    assert.equal(exited.status, 0);
    assert.ok(exited.pid);
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const start = JSON.stringify({ phase: 'start', run_id: 'lost', pid: exited.pid });
    fs.writeFileSync(file, `${start}\n`);
    const receipt = {};
    runLostRunSweep(root, receipt, {
      now: () => fs.readFileSync(path.join(root, 'missing-clock'), 'utf8'),
    });
    assert.match(receipt.lost_run_sweep_error, /ENOENT/);
    assert.equal(receipt.lost_run_sweep, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), `${start}\n`);
    assert.equal(lostRunSweepNote(receipt), ', could not close lost engine runs, so unfinished records may remain');
    assert.equal(lostRunSweepNote({}), '');
    assert.equal(lostRunSweepNote({ lost_run_sweep: { closed: ['one', 'two'] } }), ', closed 2 lost engine runs');
    assert.equal(lostRunSweepNote({ lost_run_sweep: { closed: ['one'] }, lost_run_sweep_error: 'failed' }),
      ', closed 1 lost engine run, could not close lost engine runs, so unfinished records may remain');
    console.log('real lost-run close failure: ' + lostRunSweepNote(receipt).slice(2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly cleanup summary reports an unreadable run log instead of finding no lost runs', () => {
  const { runLostRunSweep, lostRunSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-lost-unread-'));
  try {
    const missing = {};
    runLostRunSweep(root, missing);
    assert.deepEqual(missing.lost_run_sweep, { closed: [] });
    assert.equal(lostRunSweepNote(missing), '');
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(file, { recursive: true });
    const receipt = {};
    runLostRunSweep(root, receipt);
    assert.match(receipt.lost_run_sweep_error, /could not read the engine run log: EISDIR/);
    assert.equal(receipt.lost_run_sweep, undefined);
    assert.equal(lostRunSweepNote(receipt), ', could not close lost engine runs, so unfinished records may remain');
    console.log('real unreadable run log: ' + receipt.lost_run_sweep_error);
    const { engineCommand } = require('../commands/engine');
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    let code;
    try {
      code = engineCommand(['sweep', '--apply'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
    } finally {
      console.log = original;
    }
    assert.equal(code, 1);
    assert.match(out.join('\n'), /^stopped 0 leaked ssh-agents\n0 leaked ssh-agents still left on this machine\ncould not close lost runs, so unfinished records may remain: could not read the engine run log: EISDIR$/);
    console.log('real sweep with unreadable run log: ' + out.join(' / '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the sweep listing and the landing status name an unreadable run log instead of showing no history', () => {
  const { spawnSync } = require('node:child_process');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-history-unread-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    assert.strictEqual(readResourceHistory(root).read_error, null, 'no log yet is no history, not a failure');
    fs.mkdirSync(path.join(root, RESOURCE_LOG), { recursive: true });
    assert.equal(readResourceHistory(root).read_error, 'EISDIR');
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    let code;
    try {
      code = engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
    } finally {
      console.log = original;
    }
    const listing = out.join('\n');
    assert.equal(code, 0);
    assert.match(listing, /\ncould not read the engine run log: EISDIR, so past sweeps, kills, and errors are unknown$/);
    assert.doesNotMatch(listing, /no sweep recorded yet|no engine run has ended in SIGKILL/);
    console.log('real sweep listing with unreadable run log: ' + out.join(' / '));
    const cli = path.join(__dirname, '..', 'bin', 'atris.js');
    const status = spawnSync(process.execPath, [cli, 'autoland', 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.strictEqual(status.status, 0, status.stderr);
    const line = status.stdout.split('\n').find((text) => /engine run log/.test(text));
    assert.equal(line, '  engine run log: could not read it (EISDIR), so lost, killed, and failed runs in the last day are unknown');
    console.log('real landing status with unreadable run log: ' + line.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris scout records each engine run with a time limit kill and a crash told apart', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-resource-'));
  const bin = path.join(root, 'fake-bin');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const fake = (body) => {
    fs.writeFileSync(path.join(bin, 'cursor-agent'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const scout = (timeoutSec) => spawnSync(process.execPath, [cli, 'scout', '--yes', '--engine', 'cursor', '--timeout', String(timeoutSec), 'where is it?'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const ends = () => fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.phase === 'end');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(bin);
    fake('echo "it is in lib/fleet.js:1"');
    const answered = scout(30);
    assert.strictEqual(answered.status, 0, answered.stderr);
    // The slow engine starts its own child, which the time limit must stop too.
    const helperPid = path.join(root, 'helper.pid');
    fake(`sleep 30 &\necho $! > "${helperPid}"\nwait`);
    const slowStarted = Date.now();
    const slow = scout(1);
    const slowMs = Date.now() - slowStarted;
    assert.strictEqual(slow.status, 1);
    assert.match(slow.stdout, /timed out after 1s/);
    // A surviving child holds the output pipe, so the scout would hang until it ends.
    assert.ok(slowMs < 15000, `a 1s scout time limit returned in ${slowMs} ms, not after the engine's child finished`);
    const helper = Number(fs.readFileSync(helperPid, 'utf8').trim());
    assert.ok(helper > 0, 'the fake engine recorded the process it started');
    const helperAlive = () => { try { process.kill(helper, 0); return true; } catch { return false; } };
    const stopBy = Date.now() + 3000;
    while (helperAlive() && Date.now() < stopBy) spawnSync('sleep', ['0.05']);
    const leftBehind = helperAlive();
    if (leftBehind) process.kill(helper, 'SIGKILL');
    assert.strictEqual(leftBehind, false, 'a timed out scout leaves no process the engine started');
    console.log(`real scout time limit also stopped the engine's own child (pid ${helper})`);
    fake('kill -9 $$');
    const crashed = scout(30);
    assert.strictEqual(crashed.status, 1);
    assert.match(crashed.stdout, /stopped by SIGKILL; killed \((machine memory low|cause unknown)/, 'the operator sees the cause, not a bare exit');
    const log = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(log.map((entry) => entry.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    const [ok, timedOut, killed] = ends();
    assert.deepStrictEqual([ok.engine, ok.task, ok.signal || null, ok.error || ''], ['cursor', 'scout', null, '']);
    assert.deepStrictEqual([timedOut.signal, timedOut.timed_out, timedOut.cause], ['SIGKILL', true, 'killed (time limit reached)']);
    assert.strictEqual(killed.signal, 'SIGKILL');
    assert.notStrictEqual(killed.timed_out, true);
    assert.match(killed.cause, /^killed \((machine memory low|cause unknown)/);
    for (const entry of [ok, timedOut, killed]) assert.ok(Number.isFinite(entry.duration_ms), JSON.stringify(entry));
    console.log('real scout run records: ' + [ok, timedOut, killed].map((entry) => `${entry.signal || 'exit'} ${entry.cause || 'no cause'}`).join(' / '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the voice judge records its claude run, and a killed judge names the likely cause', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-judge-resource-'));
  const bin = path.join(root, 'fake-bin');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const fake = (body) => {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const judge = () => spawnSync(process.execPath, [cli, 'voice', 'judge'], {
    cwd: root,
    input: 'The reply is ready.',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}/usr/bin:/bin`, ATRIS_VOICE_JUDGE_CMD: '', ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'atris.md'), '## voice\n\nUse plain words.\n');
    fs.mkdirSync(bin);
    fake('/bin/cat >/dev/null\nprintf \'%s\\n\' \'{"pass":true,"reasons":[]}\'');
    const passed = judge();
    assert.strictEqual(passed.status, 0, passed.stderr);
    fake('kill -9 $$');
    const killed = judge();
    assert.match(killed.stderr, /^voice judge unavailable: the judge command failed/);
    const log = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(log.map((entry) => `${entry.phase} ${entry.engine} ${entry.task}`), [
      'start claude voice judge', 'end claude voice judge', 'start claude voice judge', 'end claude voice judge',
    ]);
    const [, ok, , dead] = log;
    assert.deepStrictEqual([ok.signal || null, ok.error || ''], [null, '']);
    assert.strictEqual(dead.signal, 'SIGKILL');
    assert.match(dead.cause, /^killed \((machine memory low|cause unknown)/);
    for (const entry of [ok, dead]) assert.ok(Number.isFinite(entry.duration_ms), JSON.stringify(entry));
    console.log('real voice judge records: ' + [ok, dead].map((entry) => `${entry.signal || 'exit'} ${entry.cause || 'no cause'}`).join(' / '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Shared by both engine launch guards below.
const ENGINE_NAMES = 'claude|codex|cursor-agent|devin|agy|grok|opencode';
// Interactive sessions hand the terminal to the person, so no reading is kept.
const LAUNCH_EXEMPT_FILES = new Map([
  ['commands/console.js', 'interactive codex session'],
  ['commands/interview.js', 'interactive claude session'],
]);
// Comments are blanked with their line breaks kept, so a mention there
// never counts and line numbers still match the file.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
// Read parameter boundaries without treating resolver-call parentheses or
// quoted commas as the end of a function header.
const definitionHeader = (code, open) => {
  const text = code.slice(open);
  const prefix = /^[ \t]*(?:async\s+)?function\s+([\w$]+)\s*|^[ \t]*(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function(?:\s+([\w$]+))?\s*)?/.exec(text);
  if (!prefix) return null;
  let end = prefix[0].length;
  const parameters = [''];
  if (text[end] === '(') {
    let depth = 0;
    let closed = false;
    const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{},]|[^'"`()\[\]{},]+/g;
    for (const token of text.slice(end + 1).matchAll(tokens)) {
      if (token[0] === ')' && depth === 0) {
        end += token.index + 2;
        closed = true;
        break;
      }
      if (token[0] === ',' && depth === 0) parameters.push('');
      else {
        if (/^[([{]$/.test(token[0])) depth += 1;
        if (/^[)\]}]$/.test(token[0])) depth -= 1;
        parameters[parameters.length - 1] += token[0];
      }
    }
    if (!closed) return null;
  } else {
    const single = /^[\w$]+/.exec(text.slice(end));
    if (!single) return null;
    parameters[0] = single[0];
    end += single[0].length;
  }
  const suffix = /^\s*(=>|\{)/.exec(text.slice(end));
  if (!suffix) return null;
  return { name: prefix[1] || prefix[2], internalName: prefix[1] || prefix[3], parameters, end: open + end + suffix[0].length, arrow: suffix[1] === '=>' };
};
// Each function definition, named or bound to a variable, as start and end offsets.
// The scan asks again for the same text on every lookup, so recent texts
// are read once; the list is frozen so no caller can change a shared answer.
const DEFINITION_SPANS = new Map();
const DEFINITION_SPANS_KEPT = 100;
const definitionSpans = (code) => {
  const cached = DEFINITION_SPANS.get(code);
  if (cached) return cached;
  const definitions = /^[ \t]*(?:(?:async\s+)?function\s+[\w$]+\s*|(?:const|let|var)\s+[\w$]+\s*=)/gm;
  const spans = [];
  for (const header of code.matchAll(definitions)) {
    const parsed = definitionHeader(code, header.index);
    if (!parsed) continue;
    let body = parsed.end;
    const arrow = parsed.arrow;
    if (arrow) while (/\s/.test(code[body] || '') && body < code.length) body += 1;
    const block = !arrow || code[body] === '{';
    const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[{};]|[^'"`{};]+/g;
    let depth = 1;
    let end = code.length;
    for (const token of code.slice(block && arrow ? body + 1 : body).matchAll(tokens)) {
      if (block && token[0] === '{') depth += 1;
      if (block && token[0] === '}') depth -= 1;
      if ((block && depth === 0) || (!block && token[0] === ';')) {
        end = (block && arrow ? body + 1 : body) + token.index + token[0].length;
        break;
      }
    }
    spans.push(Object.freeze([header.index, end]));
  }
  if (DEFINITION_SPANS.size >= DEFINITION_SPANS_KEPT) DEFINITION_SPANS.clear();
  DEFINITION_SPANS.set(code, Object.freeze(spans));
  return spans;
};
// Ignore helper definitions when looking for calls in their enclosing code.
// Keep functions containing the launch, and blank siblings without moving lines.
// Nested spans overlap, so the text is rebuilt once over their merged ranges.
const withoutHelperDefinitions = (code, launch = -1) => {
  const spans = definitionSpans(code).filter(([start, end]) => launch < start || launch >= end).sort(([a], [b]) => a - b);
  const parts = [];
  let kept = 0;
  for (const [start, end] of spans) {
    if (end <= kept) continue;
    const from = Math.max(start, kept);
    parts.push(code.slice(kept, from), code.slice(from, end).replace(/[^\n]/g, ' '));
    kept = end;
  }
  parts.push(code.slice(kept));
  return parts.join('');
};
// A function in the same file that records the run counts as a recording
// call, the way the mission tick records through its own small wrapper.
const recordingCall = (code) => {
  const names = ['startEngineRun', 'recordEngineResource'];
  for (const match of code.matchAll(/^(?:async\s+)?function\s+([\w$]+)\s*\(/gm)) {
    const end = code.slice(match.index).search(/^\}/m);
    const body = withoutHelperDefinitions(code.slice(match.index + match[0].length, end < 0 ? undefined : match.index + end));
    if (/\b(?:startEngineRun|recordEngineResource)\(/.test(body)) names.push(match[1]);
  }
  return new RegExp(`\\b(?:${[...new Set(names)].join('|')})\\(`);
};
// Each launch needs a recording call on its line or in the dozen lines
// above it, without crossing a top-level function boundary.
const RECORD_WINDOW = 12;
const FUNCTION_START = /^(?:async\s+)?function\b|^(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/gm;
const recordedAbove = (lines, line, recorder) => {
  const code = lines.join('\n');
  const launch = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0) + lines[line - 1].search(/\S/);
  lines = withoutHelperDefinitions(code, launch).split('\n');
  // A parent's readings cannot cover a launch inside a helper it defines.
  const innermost = Math.max(0, ...definitionSpans(code).filter(([open, close]) => open <= launch && launch < close).map(([open]) => open));
  const helperStart = code.slice(0, innermost).split('\n').length - 1;
  let start = Math.max(0, line - 1 - RECORD_WINDOW, helperStart);
  for (let index = line - 1; index >= start; index -= 1) {
    // A closed function's readings cannot cover a later top-level launch.
    if (/^\}/.test(lines[index])) {
      start = index + 1;
      break;
    }
    if (lines[index].match(FUNCTION_START)) {
      // A concise arrow ends at its statement, without a closing brace.
      const concise = /=>\s*(?:[^\s{]|$)/.test(lines[index]);
      const statementEnd = concise ? lines.slice(index, line).findIndex((candidate) => /;\s*$/.test(candidate)) : -1;
      const end = statementEnd >= 0 ? index + statementEnd : index;
      const complete = /\}\s*;?\s*$/.test(lines[index]) || (concise && statementEnd >= 0);
      start = complete && end < line - 1 ? end + 1 : index;
      break;
    }
  }
  // Defining a recording wrapper is not a call to that wrapper.
  const nearby = lines.slice(start, line).join('\n').replace(/\bfunction\s+[\w$]+\s*\([^)]*\)/g, '');
  return recorder.test(nearby);
};
// A version or help probe starts no engine run.
const isProbe = (args) => /^\[\s*(?:['"`][\w-]+['"`]\s*,\s*)?['"`]--(?:version|help)['"`]\s*\]$/.test(args || '');

test('every launch of an engine program by name records its run or is named as exempt', () => {
  const ENGINE_LAUNCH = new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync)\\s*\\(\\s*['"\`](${ENGINE_NAMES})['"\`]\\s*,\\s*(\\[[^\\]]*\\])?`, 'g');
  const unrecorded = (rel, text) => {
    if (LAUNCH_EXEMPT_FILES.has(rel)) return [];
    const code = stripComments(text);
    const lines = code.split('\n');
    const recorder = recordingCall(code);
    const found = [];
    for (const match of code.matchAll(ENGINE_LAUNCH)) {
      if (isProbe(match[2])) continue;
      const line = code.slice(0, match.index).split('\n').length;
      if (recordedAbove(lines, line, recorder)) continue;
      found.push(`${rel}:${line} ${match[1]}`);
    }
    return found;
  };
  assert.deepStrictEqual(unrecorded('commands/planted.js', "const r = spawnSync('claude', ['-p', prompt]);\n"), ['commands/planted.js:1 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "spawnSync('claude', ['--version']);\n"), []);
  for (const helper of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    for (const whitespace of [' ', '\t', '\n  ']) {
      const launch = `${helper}${whitespace}('claude', ['-p', prompt]);\n`;
      assert.deepStrictEqual(unrecorded('commands/planted.js', launch), ['commands/planted.js:1 claude']);
      assert.deepStrictEqual(unrecorded('commands/planted.js', `startEngineRun(root);\n${launch}`), []);
      for (const probe of ['--help', '--version']) {
        assert.deepStrictEqual(unrecorded('commands/planted.js', `${helper}${whitespace}('claude', ['${probe}']);\n`), []);
      }
      assert.deepStrictEqual(unrecorded('commands/planted.js', `${helper}${whitespace}('git', ['status']);\n`), []);
      assert.deepStrictEqual(unrecorded('commands/planted.js', `// ${helper} ('claude', args);\n`), []);
      assert.deepStrictEqual(unrecorded('commands/console.js', launch), []);
    }
  }
  // A mention in a comment, or a recorded launch elsewhere in the file, does
  // not cover this launch.
  assert.deepStrictEqual(unrecorded('commands/planted.js', "// startEngineRun is called elsewhere\nconst r = spawnSync('claude', ['-p', prompt]);\n"), ['commands/planted.js:2 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "/* recordEngineResource( */ spawnSync('codex', ['exec']);\n"), ['commands/planted.js:1 codex']);
  const previousFunction = "function recorded() {\n  const end = startEngineRun(root);\n  spawnSync('claude', args);\n}\n";
  assert.deepStrictEqual(unrecorded('commands/planted.js', `${previousFunction}function bare() {\n  spawnSync('claude', args);\n}\n`), ['commands/planted.js:6 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', `${previousFunction}spawnSync('claude', args);\n`), ['commands/planted.js:5 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', `${previousFunction}const bare = () => {\n  spawnSync('claude', args);\n};\n`), ['commands/planted.js:6 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', `${previousFunction}function covered() {\n  const end = startEngineRun(root);\n  spawnSync('claude', args);\n}\n`), []);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "const record = () => startEngineRun(root);\nspawnSync('claude', args);\n"), ['commands/planted.js:2 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "const record = () =>\n  startEngineRun(root);\nspawnSync('claude', args);\n"), ['commands/planted.js:3 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function record() { startEngineRun(root); }\nspawnSync('claude', args);\n"), ['commands/planted.js:2 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function covered() { const end = startEngineRun(root);\n  spawnSync('claude', args);\n}\n"), []);
  {
    const source = "function outer() {\n  function helper() {\n    startEngineRun(root);\n  }\n  spawnSync('claude', args);\n}\n";
    assert.deepStrictEqual(unrecorded('commands/planted.js', source), ['commands/planted.js:5 claude']);
  }
  {
    const source = "function outer() {\n  const helper = () => {\n    startEngineRun(root);\n  };\n  spawnSync('claude', args);\n}\n";
    assert.deepStrictEqual(unrecorded('commands/planted.js', source), ['commands/planted.js:5 claude']);
  }
  {
    const source = "function outer() {\n  const helper = () =>\n    startEngineRun(root);\n\n  spawnSync('claude', args);\n}\n";
    assert.deepStrictEqual(unrecorded('commands/planted.js', source), ['commands/planted.js:5 claude']);
  }
  {
    const source = "function outer() {\n  startEngineRun(root);\n  function helper() {\n    noop();\n  }\n  spawnSync('claude', args);\n}\n";
    assert.deepStrictEqual(unrecorded('commands/planted.js', source), []);
  }
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function outer() {\n  function helper() { startEngineRun(root); }\n}\nfunction caller() {\n  outer();\n  spawnSync('claude', args);\n}\n"), ['commands/planted.js:6 claude'], 'a parent with only a nested recorder is not a recording wrapper');
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function outer() {\n  function helper() {\n    startEngineRun(root);\n    spawnSync('claude', args);\n  }\n}\n"), [], 'a helper can record its own launch');
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function outer() {\n  startEngineRun(root);\n  function helper() {\n    spawnSync('claude', args);\n  }\n}\n"), ['commands/planted.js:4 claude'], 'a parent recording does not cover a launch inside its helper');
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function outer() {\n  startEngineRun(root);\n  const helper = () => {\n    spawnSync('claude', args);\n  };\n}\n"), ['commands/planted.js:4 claude']);
  assert.deepStrictEqual(unrecorded('commands/planted.js', "function outer() {\n  startEngineRun(root);\n  const helper = () =>\n    spawnSync('claude', args);\n}\n"), ['commands/planted.js:4 claude']);
  const recordedThenBare = [
    "const end = startEngineRun(root, { engine: 'claude' });",
    "spawnSync('claude', ['-p', a]);",
    ...Array(20).fill(''),
    "spawnSync('claude', ['-p', b]);",
  ].join('\n');
  assert.deepStrictEqual(unrecorded('commands/planted.js', recordedThenBare), ['commands/planted.js:23 claude']);
  // An exempt file must still launch an engine by name, or its entry is
  // stale and would hide the next launch added there.
  const launchesIn = (text) => [...stripComments(text).matchAll(ENGINE_LAUNCH)].filter((match) => !isProbe(match[2])).map((match) => match[1]);
  assert.deepStrictEqual(launchesIn("spawnSync('codex', ['--full-auto', ...extraArgs]);\n"), ['codex']);
  assert.deepStrictEqual(launchesIn("// spawnSync('codex', ['--full-auto']);\nspawnSync('codex', ['--version']);\n"), [], 'a comment or a probe does not keep an exemption alive');
  for (const whitespace of [' ', '\t', '\n  ']) {
    assert.deepStrictEqual(launchesIn(`spawnSync${whitespace}('codex', ['exec']);\n`), ['codex']);
    assert.deepStrictEqual(launchesIn(`spawnSync${whitespace}('codex', ['--help']);\n`), []);
  }
  const repo = path.join(__dirname, '..');
  const staleFiles = [...LAUNCH_EXEMPT_FILES.keys()].filter((rel) => !fs.existsSync(path.join(repo, rel)) || !launchesIn(fs.readFileSync(path.join(repo, rel), 'utf8')).length);
  assert.deepStrictEqual(staleFiles, [], 'an exempt file no longer launches an engine by name; remove its entry');
  const missing = [];
  let launches = 0;
  for (const dir of ['commands', 'lib']) {
    for (const name of fs.readdirSync(path.join(repo, dir)).filter((file) => file.endsWith('.js'))) {
      const rel = `${dir}/${name}`;
      const text = fs.readFileSync(path.join(repo, rel), 'utf8');
      launches += [...text.matchAll(ENGINE_LAUNCH)].length;
      missing.push(...unrecorded(rel, text));
    }
  }
  assert.ok(launches >= 5, `the scan should see the known launches, saw ${launches}`);
  assert.deepStrictEqual(missing, [], 'record the run with startEngineRun, or add the file to the exempt list with its reason');
  console.log(`real engine launch scan: ${launches} launches by name, ${missing.length} unrecorded`);
});

test('every engine started through a runner or profile variable records its run or is named as exempt', () => {
  // The program is a variable or a call, like a runner binary, a profile's
  // bin, or an engine invocation's command. A list or map written in the
  // launch counts only when it is indexed there, and a program in its own
  // parentheses starts at the opening one.
  const VAR_LAUNCH = /\b(?:spawn|spawnSync|execFile|execFileSync|spawnWithOutputChunks|runInReapedProcessGroup)\s*\(\s*(\((?!\s*\))|(?:[A-Za-z_$][\w$]*|\[[^[\]{}()]*\](?=(?:\?\.)?\[)|\{[^[\]{}()]*\}(?=(?:\?\.)?\[))(?:\??\.[\w$]+|(?:\?\.)?\[\s*(?:'[^'\\\n]*'|"[^"\\\n]*"|[A-Za-z_$][\w$]*|\d+)\s*\])*)/g;
  // It is an engine when the call, or the variable's declaration in the same
  // function, names an engine program or an engine or runner resolver.
  const ENGINE_SOURCE = new RegExp(`['"\`](?:${ENGINE_NAMES})['"\`]|\\b[\\w$]*(?:Engine|engine|Runner|runner)[\\w$]*\\s*\\(`);
  // Launches whose run is recorded somewhere this scan cannot see, by
  // file, the function holding the launch, and its program. Each covers one
  // launch, so another launch added to the same function is still caught.
  const EXEMPT_LAUNCHES = new Map([
    ['lib/roster-prep.js#defaultPrepAskSync invocation.bin', 'recorded around the ask by startPrepReadings'],
    ['commands/run.js#execPhaseCommandSync cmd', 'recorded around the phase by executePhase'],
  ]);
  const engineLaunches = (rel, text) => {
    const code = stripComments(text);
    const lines = code.split('\n');
    const recorder = recordingCall(code);
    // The parameter names of the definition starting at this offset.
    const parametersOf = (open) => {
      const header = definitionHeader(code, open);
      // Keep names the parameters bind and skip defaults and renamed keys.
      return header ? header.parameters.flatMap((parameter) => [...parameter.matchAll(/(?<=^|[,{[:]|\.\.\.)\s*([A-Za-z_$][\w$]*)\s*(?=[,}\]=]|$)/g)].map((name) => name[1])) : [];
    };
    // A declaration at the start of this text still reaches its end when no
    // brace or parenthesis open before the declaration closes in between.
    // Plain var bindings instead live throughout their containing function.
    const inScope = (text) => {
      let depth = 0;
      for (const token of text.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[{}()]/g)) {
        depth += token[0] === '{' || token[0] === '(' ? 1 : token[0] === '}' || token[0] === ')' ? -1 : 0;
        if (depth < 0) return false;
      }
      return true;
    };
    // Inline callbacks are not named helper definitions, but their var
    // bindings still stop at the callback's closing brace.
    const functionBodies = [];
    const braces = [];
    const parentheses = [];
    let lastParameters = 0;
    // These read only the end of the text. A pattern anchored at the end of
    // a whole file prefix tries every start, which made each file quadratic.
    const keywordEnd = (text) => /(?:^|\W)(?:if|for|while|switch|catch|with)$/.test(text.slice(-7));
    const endsWithControl = (text) => {
      const end = text.trimEnd();
      if (keywordEnd(end)) return true;
      const at = end.length - 5;
      return end.endsWith('await') && /\s/.test(end[at - 1] || '') && keywordEnd(end.slice(0, at).trimEnd());
    };
    for (const token of code.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[{}()]/g)) {
      if (token[0] === '(') parentheses.push(token.index);
      else if (token[0] === ')') lastParameters = parentheses.pop() ?? 0;
      else if (token[0] === '{') {
        const before = code.slice(0, token.index).trimEnd();
        const control = endsWithControl(code.slice(0, lastParameters));
        braces.push({ open: token.index, fn: before.endsWith('=>') || (before.endsWith(')') && !control) });
      } else if (token[0] === '}') {
        const body = braces.pop();
        if (body?.fn) functionBodies.push([body.open, token.index]);
      }
    }
    const withinDeclaringFunction = (declaration, launch) => functionBodies.every(([open, close]) =>
      !(open < declaration && declaration < close) || (open < launch && launch < close));
    // A parameter of an enclosing function, or an earlier declaration still
    // in scope, binds this name at the position.
    const bindsAt = (name, position) => {
      if (definitionSpans(code).some(([open, close]) => open < position && position < close && parametersOf(open).includes(name))) return true;
      const visible = withoutHelperDefinitions(code, position).slice(0, position);
      const escaped = name.replace(/\$/g, '\\$');
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b|\\b(?:const|let|var)\\s*[{[](?:[^=;]*?[,:{[])?\\s*${escaped}\\s*[,}\\]=]`, 'g');
      return [...visible.matchAll(declaration)].some((binding) => (/^var\b/.test(binding[0]) && withinDeclaringFunction(binding.index, position)) || inScope(visible.slice(binding.index)));
    };
    // The whole array or object literal a declaration at this position holds,
    // read across line breaks, or null when the literal is only part of the
    // declared value.
    const declaredLiteral = (position) => {
      const value = /^(?:const|let|var)\s+[\w$]+\s*=\s*(?=[[{])/.exec(code.slice(position));
      if (!value) return null;
      const text = code.slice(position + value[0].length);
      let depth = 0;
      for (const token of text.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{}]/g)) {
        depth += /^[([{]$/.test(token[0]) ? 1 : /^[)\]}]$/.test(token[0]) ? -1 : 0;
        if (depth > 0) continue;
        const end = token.index + 1;
        return /^[ \t]*(?:;|\r?\n|$)/.test(text.slice(end)) ? text.slice(0, end) : null;
      }
      return null;
    };
    // The elements of an array literal, or of a same-file array declaration
    // never changed after it, each with the position it is read at. Anything
    // else is unknown.
    const arrayElements = (source, position) => {
      let text = source;
      let at = position;
      if (!text.startsWith('[')) {
        const name = /^[A-Za-z_$][\w$]*$/.exec(text)?.[0];
        if (!name) return null;
        const escaped = name.replace(/\$/g, '\\$');
        if (new RegExp(`\\b${escaped}\\s*(?:\\.\\s*(?:push|pop|shift|unshift|splice|fill|copyWithin|reverse|sort)\\s*\\(|\\[[^\\]]*\\]\\s*=(?!=)|\\.\\s*length\\s*=(?!=))`).test(code)) return null;
        const resolved = sourceAt(name, position);
        text = resolved.source.startsWith('[') ? declaredLiteral(resolved.position) ?? resolved.source : resolved.source;
        at = resolved.position;
      }
      if (!text.startsWith('[')) return null;
      const elements = [''];
      let depth = 0;
      const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{},]|[^'"`()\[\]{},]+/g;
      for (const token of text.slice(1).matchAll(tokens)) {
        // The literal must end where its bracket closes, not before an index
        // or call. An empty last element is a trailing comma or an empty array.
        if (token[0] === ']' && depth === 0) {
          if (token.index + 2 !== text.length) return null;
          if (!elements[elements.length - 1].trim()) elements.pop();
          return elements.map((element) => ({ text: element.trim(), position: at }));
        }
        if (token[0] === ',' && depth === 0) {
          elements.push('');
          continue;
        }
        if (/^[([{]$/.test(token[0])) depth += 1;
        if (/^[)\]}]$/.test(token[0])) depth -= 1;
        elements[elements.length - 1] += token[0];
      }
      return null;
    };
    // Arguments with known spreads expanded in place. An unknown spread ends
    // the list, so the slots after it read as left to their defaults.
    const spreadArguments = (items, depth = 0) => {
      const values = [];
      for (const item of items) {
        const spread = /^\.\.\.\s*([\s\S]*)$/.exec(item.text);
        if (!spread) {
          values.push(item);
          continue;
        }
        const elements = depth < 8 ? arrayElements(spread[1].trim(), item.position) : null;
        if (!elements) return { values, open: true };
        const inner = spreadArguments(elements, depth + 1);
        values.push(...inner.values);
        if (inner.open) return { values, open: true };
      }
      return { values, open: false };
    };
    // The top-level entries of a braced object and the text after its
    // closing brace, or null when the text does not start one.
    const objectEntries = (text) => {
      if (!text.startsWith('{')) return null;
      const entries = [''];
      let depth = 0;
      const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{},]|[^'"`()\[\]{},]+/g;
      for (const token of text.slice(1).matchAll(tokens)) {
        if (token[0] === '}' && depth === 0) return { entries: entries.map((entry) => entry.trim()).filter(Boolean), rest: text.slice(token.index + 2) };
        if (token[0] === ',' && depth === 0) {
          entries.push('');
          continue;
        }
        if (/^[([{]$/.test(token[0])) depth += 1;
        if (/^[)\]}]$/.test(token[0])) depth -= 1;
        entries[entries.length - 1] += token[0];
      }
      return null;
    };
    // The keys leading to this name in a destructured parameter, each with
    // its default, plus the whole-object default. A nested pattern's own
    // default is the default of the key that holds it.
    const objectPattern = (parameter, name) => {
      const object = objectEntries(parameter.trim());
      const whole = object && /^\s*(?:=\s*([\s\S]*))?$/.exec(object.rest);
      if (!whole) return null;
      for (const entry of object.entries) {
        const binding = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=\s*([\s\S]*))?$/.exec(entry);
        if (binding && (binding[2] || binding[1]) === name) return { path: [{ key: binding[1], fallback: (binding[3] || '').trim() }], whole: (whole[1] || '').trim() };
        const nested = /^([A-Za-z_$][\w$]*)\s*:\s*(\{[\s\S]*)$/.exec(entry);
        const inner = nested && objectPattern(nested[2], name);
        if (inner) return { path: [{ key: nested[1], fallback: inner.whole }, ...inner.path], whole: (whole[1] || '').trim() };
      }
      return null;
    };
    // The object literal a same-file variable is declared with, read where
    // it is declared, when nothing writes to its keys afterward. Anything
    // else stays as written and reads as unknown.
    const objectSource = (text, position) => {
      const name = /^[A-Za-z_$][\w$]*$/.exec(text)?.[0];
      if (!name) return { text, position };
      const escaped = name.replace(/\$/g, '\\$');
      if (new RegExp(`\\b${escaped}\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]]*\\])\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?!=)|\\bdelete\\s+${escaped}\\b|\\bObject\\.(?:assign|defineProperty|defineProperties)\\(\\s*${escaped}\\b`).test(code)) return { text, position };
      const resolved = sourceAt(name, position);
      const literal = objectEntries(resolved.source);
      if (literal && !literal.rest.trim()) return { text: resolved.source, position: resolved.position };
      const whole = resolved.source.startsWith('{') && declaredLiteral(resolved.position);
      return whole ? { text: whole, position: resolved.position } : { text, position };
    };
    const sourceAt = (source, position) => {
      const visible = withoutHelperDefinitions(code, position);
      let declarationEnd = position;
      while (!ENGINE_SOURCE.test(source)) {
        const alias = /^([A-Za-z_$][\w$]*)(?:\??\.[\w$]+|(?:\?\.)?\[\s*(?:'[^'\\\n]*'|"[^"\\\n]*"|[A-Za-z_$][\w$]*|\d+)\s*\])*$/.exec(source.trim());
        if (!alias) break;
        // Captured variables remain visible until a matching parameter hides them.
        const shadowStart = Math.max(0, ...definitionSpans(code).filter(([open, close]) => open <= declarationEnd && declarationEnd < close && parametersOf(open).includes(alias[1])).map(([open]) => open));
        const visibleText = visible.slice(shadowStart, declarationEnd);
        const declaration = [...visibleText.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${alias[1].replace(/\$/g, '\\$')}[ \\t]*(?:=\\s*([^;\\n]*)|(?=;|\\n))`, 'g'))]
          .filter((candidate) => (/^var\b/.test(candidate[0]) && withinDeclaringFunction(shadowStart + candidate.index, declarationEnd)) || inScope(visibleText.slice(candidate.index))).pop();
        const destructured = new RegExp(`\\b(?:const|let|var)\\s*[{[](?:[^=;]*?[,:{[])?\\s*${alias[1].replace(/\$/g, '\\$')}\\s*[,}\\]=]`, 'g');
        if ([...visibleText.matchAll(destructured)].some((binding) => binding.index > (declaration?.index ?? -1) && inScope(visibleText.slice(binding.index)))) return '';
        if (!declaration) break;
        source = declaration[1] || '';
        // Only earlier declarations can supply this alias, which also makes
        // a circular alias chain terminate without a separate depth limit.
        declarationEnd = shadowStart + declaration.index;
      }
      return { source: source.trim(), position: declarationEnd };
    };
    const engineSourceAt = (program, position, following = new Set()) => {
      const resolved = sourceAt(program, position);
      if (ENGINE_SOURCE.test(resolved.source)) return true;
      const parameter = /^([A-Za-z_$][\w$]*)(?:\??\.[\w$]+|(?:\?\.)?\[\s*(?:'[^'\\\n]*'|"[^"\\\n]*"|[A-Za-z_$][\w$]*|\d+)\s*\])*$/.exec(resolved.source)?.[1];
      // A captured parameter belongs to the nearest enclosing function that
      // binds it, at the alias declaration rather than the eventual launch.
      const owner = definitionSpans(code).filter(([open, close]) => open <= resolved.position && resolved.position < close && parametersOf(open).includes(parameter)).pop();
      if (!owner) return false;
      const [fnStart] = owner;
      // Follow simple parameters only when a call in this file supplies a
      // known runner. An unrelated parameter name alone is not evidence.
      const header = definitionHeader(code, fnStart);
      const parameters = header?.parameters || [];
      let slot = parameters.findIndex((name) => name.split('=')[0].trim() === parameter);
      let pattern = null;
      if (slot < 0) slot = parameters.findIndex((text) => (pattern = objectPattern(text, parameter)));
      const defaultSource = slot < 0 ? '' : parameters[slot].slice(parameters[slot].indexOf('=') + 1).trim();
      const binding = `${fnStart}:${parameter}`;
      if (slot >= 0 && !following.has(binding)) {
        const next = new Set(following).add(binding);
        const expressionName = header.internalName;
        const internalName = parameters.some((name) => name.trim() === expressionName) ? undefined : expressionName;
        const names = [...new Set([header.name, internalName].filter(Boolean))];
        const calls = new RegExp(`\\b(${names.map((name) => name.replace(/\$/g, '\\$')).join('|')})\\s*\\(`, 'g');
        const fnEnd = definitionSpans(code).find(([open]) => open === fnStart)?.[1] ?? code.length;
        for (const call of code.matchAll(calls)) {
          const internalOnly = call[1] === internalName && internalName !== header.name;
          // An expression's internal name exists only inside its body.
          if (internalOnly && (call.index < fnStart || call.index >= fnEnd)) continue;
          // A parameter or earlier local alias of another function holding the
          // call hides either name, and the launcher's own alias hides its
          // internal name. An alias inside a sibling helper does not count, and
          // a destructured alias counts unless the name is only a renamed key.
          const visible = withoutHelperDefinitions(code, call.index);
          const escaped = call[1].replace(/\$/g, '\\$');
          const alias = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=|\\b(?:const|let|var)\\s*[{[](?:[^=;]*?[,:{[])?\\s*${escaped}\\s*[,}\\]=]`, 'g');
          // A copy in an inner block, a loop header, or an inline callback
          // does not hide a later call.
          const covers = (text) => [...text.matchAll(alias)].some((copy) => inScope(text.slice(copy.index)));
          const hides = ([open, close]) => !(open <= fnStart && fnStart < close) || (internalOnly && open === fnStart);
          if (definitionSpans(code).some(([open, close]) => open < call.index && call.index < close && hides([open, close]) && (parametersOf(open).includes(call[1]) || covers(visible.slice(open, call.index))))) continue;
          // A loop or catch variable with the name hides it inside that block only.
          // A loop without braces hides it until its statement ends at the
          // first semicolon or line break, so a following call still counts.
          const blockHeader = new RegExp(`\\b(?:for\\s*\\(\\s*(?:const|let|var)\\s+${escaped}\\s+(?:of|in)\\b[^(){};]*(?:\\([^()]*\\)[^(){};]*)*|catch\\s*\\(\\s*${escaped}\\s*)\\)\\s*(\\{)?`, 'g');
          const stillOpen = (header) => (header[1]
            ? [...code.slice(header.index + header[0].length - 1, call.index).matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[{}]/g)]
              .reduce((depth, token) => depth + (token[0] === '{' ? 1 : token[0] === '}' ? -1 : 0), 0) > 0
            : !/[;\n]/.test(code.slice(header.index + header[0].length, call.index)));
          if ([...code.slice(0, call.index).matchAll(blockHeader)].some(stillOpen)) continue;
          const prefix = code.slice(0, call.index);
          if (/\bfunction\s*$|\.\s*$/.test(prefix)) continue;
          // Keep nested calls and quoted commas in their own argument.
          const argumentsList = [''];
          let depth = 0;
          const tokens = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{},]|[^'"`()\[\]{},]+/g;
          for (const token of code.slice(call.index + call[0].length).matchAll(tokens)) {
            if (token[0] === ')' && depth === 0) break;
            if (token[0] === ',' && depth === 0) {
              argumentsList.push('');
              continue;
            }
            if (/^[([{]$/.test(token[0])) depth += 1;
            if (/^[)\]}]$/.test(token[0])) depth -= 1;
            argumentsList[argumentsList.length - 1] += token[0];
          }
          const argument = spreadArguments(argumentsList.map((text) => ({ text: text.trim(), position: call.index }))).values[slot];
          const supplied = argument ? argument.text : '';
          const suppliedAt = argument ? argument.position : call.index;
          // Omitted arguments use defaults in the definition's outer scope,
          // and so does an explicit undefined unless a binding at the call
          // renames it. Any other value, including null, never falls back.
          const leftUndefined = (text, at) => !text || text === 'void 0' || (text === 'undefined' && !bindsAt('undefined', at));
          const omitted = leftUndefined(supplied, suppliedAt);
          if (pattern) {
            // An omitted object takes the whole-object default, and an absent
            // or null object throws before any launch. In an object literal
            // the last entry for the key wins, a later spread or computed key
            // may replace it, and a missing key uses the key default. Unknown
            // objects may leave the key out too, and what they hold for a
            // nested key is unknown as well.
            const keySources = (written, writtenAt, [{ key, fallback }, ...deeper]) => {
              const { text: objectText, position: objectAt } = objectSource(written, writtenAt);
              if (!objectText || objectText === 'null') return [];
              const literal = objectEntries(objectText);
              const values = [];
              let unset = true;
              if (literal && !literal.rest.trim()) {
                let value = '';
                let open = false;
                for (const entry of literal.entries) {
                  const property = /^(['"]?)([A-Za-z_$][\w$]*)\1\s*(?::\s*([\s\S]*))?$/.exec(entry);
                  if (property && property[2] === key) {
                    value = property[3] === undefined ? property[2] : property[3].trim();
                    open = false;
                  } else if (/^(?:\.\.\.|\[)/.test(entry)) open = true;
                }
                unset = open || leftUndefined(value, objectAt);
                if (!leftUndefined(value, objectAt)) values.push([value, objectAt]);
              } else if (deeper.length) values.push([objectText, objectAt]);
              if (unset && fallback) values.push([fallback, fnStart]);
              return deeper.length ? values.flatMap(([text, at]) => keySources(text, at, deeper)) : values;
            };
            const sources = keySources(omitted ? pattern.whole : supplied, omitted ? fnStart : suppliedAt, pattern.path);
            if (sources.some(([source, at]) => engineSourceAt(source, at, next))) {
              route = 'options key';
              return true;
            }
            continue;
          }
          const hasDefault = parameters[slot].includes('=');
          if (engineSourceAt(omitted && hasDefault ? defaultSource : supplied, omitted && hasDefault ? fnStart : suppliedAt, next)) {
            route = omitted && hasDefault ? 'parameter default' : 'call argument';
            return true;
          }
        }
      }
      return false;
    };
    // How each engine launch was traced, named by the outermost step: its
    // own declaration, or a launcher parameter filled at a call.
    let route = '';
    const routes = {};
    const traced = [];
    let seen = 0;
    // The choices of a condition or fallback chain, without the condition.
    const choicesOf = (text) => {
      const pieces = [''];
      let depth = 0;
      let condition = 0;
      for (const token of text.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\?\?|\|\||\?\.|[?:|()[\]{}]|[^'"`?:|()[\]{}]+/g)) {
        if (/^[([{]$/.test(token[0])) depth += 1;
        if (/^[)\]}]$/.test(token[0])) depth -= 1;
        if (depth === 0 && /^(?:\?\?|\|\||\?|:)$/.test(token[0])) {
          if (token[0] === '?' && !condition) condition = pieces.length;
          pieces.push('');
          continue;
        }
        pieces[pieces.length - 1] += token[0];
      }
      return pieces.slice(condition).map((piece) => piece.trim()).filter(Boolean);
    };
    // A program in its own parentheses reads as each choice they hold, then
    // any members after the closing one.
    const optionsOf = (text) => {
      if (!text.startsWith('(')) return [text];
      let depth = 0;
      for (const token of text.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()]/g)) {
        depth += token[0] === '(' ? 1 : token[0] === ')' ? -1 : 0;
        if (depth === 0) {
          const after = text.slice(token.index + 1).trim();
          return choicesOf(text.slice(1, token.index)).flatMap((option) => optionsOf(option + after));
        }
      }
      return [text];
    };
    const missing = [];
    const exempted = new Set();
    for (const match of code.matchAll(VAR_LAUNCH)) {
      // A wrapped program is read like a call's argument list, from its
      // opening parenthesis through any members after the closing one.
      const wrapped = match[1] === '(';
      const program = wrapped ? '' : match[1];
      const rest = code.slice(match.index + match[0].length - (wrapped ? 1 : 0));
      let called = '';
      if (/^\s*\(/.test(rest)) {
        let depth = 0;
        for (const token of rest.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()]/g)) {
          if (token[0] === '(') depth += 1;
          else if (token[0] === ')') depth -= 1;
          if (depth === 0) {
            called = rest.slice(0, token.index + 1);
            break;
          }
        }
        if (!called) continue;
        // A resolved profile can supply its binary through a dotted member or a
        // bracketed key, quoted or held in a variable, each optionally chained.
        called += /^(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*(?:\?\.\s*)?\[\s*(?:'[^'\\\n]*'|"[^"\\\n]*"|`[^`\\$\n]*`|[A-Za-z_$][\w$]*)\s*\])*/.exec(rest.slice(called.length))[0];
      }
      // A program chosen by a condition or a fallback, after a name, a call,
      // or a wrapped group, runs to the end of the first argument.
      let choice = '';
      const tail = rest.slice(called.length);
      if (/^\s*(?:\?(?!\.)|\|\||\?\?)/.test(tail)) {
        let depth = 0;
        for (const token of tail.matchAll(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[()[\]{},]/g)) {
          if (depth === 0 && (token[0] === ',' || token[0] === ')')) {
            choice = tail.slice(0, token.index).trimEnd();
            break;
          }
          if (/^[([{]$/.test(token[0])) depth += 1;
          if (/^[)\]}]$/.test(token[0])) depth -= 1;
        }
        if (!choice) continue;
      }
      const argumentsStart = /^\s*,\s*(\[[^\]]*\])?/.exec(rest.slice(called.length + choice.length));
      if (!argumentsStart) continue;
      const args = argumentsStart[1];
      const before = code.slice(0, match.index);
      const fnStart = Math.max(0, ...definitionSpans(code).filter(([open, close]) => open <= match.index && match.index < close).map(([open]) => open));
      const fnName = (/^(?:async\s+)?(?:function|const|let|var)\s+([\w$]+)/.exec(code.slice(fnStart).trimStart()) || [])[1] || '';
      route = 'declaration';
      const chosen = program + called + choice;
      // Any choice can be the program, and a condition only picks one.
      const isEngine = (choice ? choicesOf(chosen) : [chosen]).flatMap(optionsOf).some((option) => engineSourceAt(option, match.index));
      if (!isEngine || isProbe(args)) continue;
      seen += 1;
      routes[route] = (routes[route] || 0) + 1;
      const line = before.split('\n').length;
      const launch = `${rel}#${fnName} ${chosen}`;
      traced.push({ route, at: `${rel}:${line} ${chosen}`, launch });
      if (recordedAbove(lines, line, recorder)) continue;
      if (EXEMPT_LAUNCHES.has(launch) && !exempted.has(launch)) {
        exempted.add(launch);
        continue;
      }
      missing.push(`${rel}:${line} ${chosen}`);
    }
    return { seen, missing, routes, traced, exempted: [...exempted] };
  };
  const planted = (text) => engineLaunches('commands/planted.js', text).missing;
  // An inline resolver selects the same runner with whitespace before its call.
  for (const helper of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnWithOutputChunks', 'runInReapedProcessGroup']) {
    for (const gap of [' ', '\t', '\n']) {
      const runner = `resolveClaudeRunnerBin${gap}()`;
      assert.deepStrictEqual(planted(`${helper}(${runner}, args);\n`), [`commands/planted.js:1 ${runner}`]);
      assert.deepStrictEqual(planted(`startEngineRun(root);\n${helper}(${runner}, args);\n`), []);
      assert.deepStrictEqual(planted(`${helper}(${runner}, ['--help']);\n`), []);
      assert.deepStrictEqual(planted(`${helper}(findExecutable${gap}(), args);\n`), []);
    }
  }
  // Resolver arguments can contain nested calls and quoted closing parentheses.
  for (const helper of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnWithOutputChunks', 'runInReapedProcessGroup']) {
    for (const input of ['engine', "selectTopic(topic, { hint: 'x),y' })", 'pick(["a)", nested(topic)], `b),c`)']) {
      const runner = `resolveRunnerBin (${input})`;
      assert.deepStrictEqual(planted(`${helper}(${runner}, args);\n`), [`commands/planted.js:1 ${runner}`]);
      assert.deepStrictEqual(planted(`startEngineRun(root);\n${helper}(${runner}, args);\n`), []);
      for (const probe of ['--help', '--version']) {
        assert.deepStrictEqual(planted(`${helper}(${runner}, ['${probe}']);\n`), []);
      }
      assert.deepStrictEqual(planted(`${helper}(findExecutable (${input}), args);\n`), []);
    }
  }
  assert.deepStrictEqual(planted('spawnSync(resolveRunnerBin(\n  selectTopic(topic)\n), args);\n'), ['commands/planted.js:1 resolveRunnerBin(\n  selectTopic(topic)\n)']);
  // Inline profile members, dotted or bracketed, keep the same recording and
  // probe requirements.
  for (const helper of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnWithOutputChunks', 'runInReapedProcessGroup']) {
    for (const member of ['.bin', '.command', ' . runner . bin', "['bin']", '[ "command" ]', "['runner'].bin", '[key]', '\n  [`bin`]', '?.bin', " ?. ['bin']", '?.runner?.command']) {
      const profile = `resolveEngineProfile(select(topic, { hint: 'x),y' }))${member}`;
      assert.deepStrictEqual(planted(`${helper}(${profile}, args);\n`), [`commands/planted.js:1 ${profile}`]);
      assert.deepStrictEqual(planted(`startEngineRun(root);\n${helper}(${profile}, args);\n`), []);
      for (const probe of ['--help', '--version']) {
        assert.deepStrictEqual(planted(`${helper}(${profile}, ['${probe}']);\n`), []);
      }
      assert.deepStrictEqual(planted(`${helper}(findExecutable(topic)${member}, args);\n`), []);
    }
  }
  assert.deepStrictEqual(planted('spawnSync(resolveEngineProfile(\n  topic\n)\n  .bin, args);\n'), ['commands/planted.js:1 resolveEngineProfile(\n  topic\n)\n  .bin']);
  // A declared or passed profile read through optional or bracketed members is the same launch.
  for (const member of ['?.bin', '?.runner?.command', '.runner?.bin', "['bin']", '?.[ "command" ]', "['runner'].bin", '[key]']) {
    assert.deepStrictEqual(planted(`const profile = resolveEngineProfile(topic);\nspawnSync(profile${member}, args);\n`), [`commands/planted.js:2 profile${member}`]);
    assert.deepStrictEqual(planted(`const profile = resolveEngineProfile(topic);\nstartEngineRun(root);\nspawnSync(profile${member}, args);\n`), []);
    assert.deepStrictEqual(planted(`const profile = resolveEngineProfile(topic);\nspawnSync(profile${member}, ['--version']);\n`), []);
    assert.deepStrictEqual(planted(`const profile = findExecutable(topic);\nspawnSync(profile${member}, args);\n`), []);
    assert.deepStrictEqual(planted(`function launch(profile) {\n  spawnSync(profile${member}, args);\n}\nlaunch(resolveEngineProfile());\n`), [`commands/planted.js:2 profile${member}`]);
  }
  // An engine list or map written in the launch and indexed there, or a
  // declared one read at a number, is the same launch.
  for (const program of ["['claude', 'codex'][i]", "{ claude: 'claude', codex: 'codex' }[name]", "['claude']?.[0]", '{ fast: "codex" }[\'fast\']']) {
    assert.deepStrictEqual(planted(`spawnSync(${program}, args);\n`), [`commands/planted.js:1 ${program}`]);
    assert.deepStrictEqual(planted(`startEngineRun(root);\nspawnSync(${program}, args);\n`), []);
    assert.deepStrictEqual(planted(`spawnSync(${program}, ['--version']);\n`), []);
  }
  assert.deepStrictEqual(planted("spawnSync(['git', 'node'][i], args);\n"), [], 'a list without an engine name is not an engine launch');
  assert.deepStrictEqual(planted("const engines = ['claude', 'codex'];\nspawnSync(engines[0], args);\n"), ['commands/planted.js:2 engines[0]']);
  assert.deepStrictEqual(planted("function launch(engines) {\n  spawnSync(engines[0], args);\n}\nlaunch(['claude']);\n"), ['commands/planted.js:2 engines[0]']);
  // A program chosen in the launch by a condition or a fallback is an engine
  // launch when any choice is one; the condition alone never makes it one.
  for (const program of ["fast ? 'codex' : 'claude'", "fast ? codexBin : 'claude'", "bin || 'claude'", "profile?.bin ?? 'codex'"]) {
    assert.deepStrictEqual(planted(`spawnSync(${program}, args);\n`), [`commands/planted.js:1 ${program}`]);
    assert.deepStrictEqual(planted(`startEngineRun(root);\nspawnSync(${program}, args);\n`), []);
    assert.deepStrictEqual(planted(`spawnSync(${program}, ['--version']);\n`), []);
  }
  assert.deepStrictEqual(planted("spawnSync(fast ? 'git' : 'node', args);\n"), [], 'choices without an engine are not an engine launch');
  assert.deepStrictEqual(planted("spawnSync(name === 'claude' ? gitBin : nodeBin, args);\n"), [], 'an engine named only in the condition does not pick the program');
  assert.deepStrictEqual(planted("const runner = resolveClaudeRunnerBin();\nspawnSync(fast ? runner : 'node', args);\n"), ["commands/planted.js:2 fast ? runner : 'node'"]);
  // A condition or fallback after a call chooses the same way, and a call
  // used only as the condition does not pick the program.
  for (const program of ["resolveClaudeRunnerBin() || 'node'", "resolveEngineProfile(topic).bin ?? 'node'", "findExecutable('git') || 'claude'", "isFast() ? 'codex' : 'claude'"]) {
    assert.deepStrictEqual(planted(`spawnSync(${program}, args);\n`), [`commands/planted.js:1 ${program}`]);
    assert.deepStrictEqual(planted(`startEngineRun(root);\nspawnSync(${program}, args);\n`), []);
    assert.deepStrictEqual(planted(`spawnSync(${program}, ['--help']);\n`), []);
  }
  assert.deepStrictEqual(planted("spawnSync(findExecutable('git') || 'node', args);\n"), [], 'a call and fallback without an engine are not an engine launch');
  assert.deepStrictEqual(planted("spawnSync(isEngineReady() ? 'git' : 'node', args);\n"), [], 'an engine call used only as the condition does not pick the program');
  // A program in its own parentheses is the program they hold.
  for (const program of ["(fast ? 'codex' : 'claude')", "('claude')", "(bin || 'claude')", "((fast) ? 'codex' : bin)", "(bin) || 'claude'"]) {
    assert.deepStrictEqual(planted(`spawnSync(${program}, args);\n`), [`commands/planted.js:1 ${program}`]);
    assert.deepStrictEqual(planted(`startEngineRun(root);\nspawnSync(${program}, args);\n`), []);
    assert.deepStrictEqual(planted(`spawnSync(${program}, ['--version']);\n`), []);
  }
  assert.deepStrictEqual(planted("const runner = resolveClaudeRunnerBin();\nspawnSync((runner), args);\n"), ['commands/planted.js:2 (runner)']);
  assert.deepStrictEqual(planted("const profile = resolveEngineProfile();\nspawnSync((profile).bin, args);\n"), ['commands/planted.js:2 (profile).bin']);
  assert.deepStrictEqual(planted("const profile = resolveEngineProfile();\nspawnSync((fast ? profile : other).bin, args);\n"), ['commands/planted.js:2 (fast ? profile : other).bin']);
  assert.deepStrictEqual(planted("spawnSync((fast ? 'git' : 'node'), args);\n"), [], 'wrapped choices without an engine are not an engine launch');
  assert.deepStrictEqual(planted("spawnSync((runner), args);\n"), [], 'a wrapped unknown program stays unknown');
  // Spaces before resolver arguments do not change the program they select.
  for (const gap of [' ', '\t']) {
    const runner = `resolveClaudeRunnerBin${gap}()`;
    const profile = `resolveEngineProfile${gap}()`;
    assert.deepStrictEqual(planted(`const runner = ${runner};\nspawnSync(runner, args);\n`), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(`const profile = ${profile};\nspawnSync(profile.bin, args);\n`), ['commands/planted.js:2 profile.bin']);
    assert.deepStrictEqual(planted(`const runner = ${runner};\nstartEngineRun(root);\nspawnSync(runner, args);\n`), []);
    assert.deepStrictEqual(planted(`const runner = ${runner};\nspawnSync(runner, ['--help']);\n`), []);
    assert.deepStrictEqual(planted(`const runner = findExecutable${gap}('git');\nspawnSync(runner, args);\n`), []);
    assert.deepStrictEqual(planted(`function launch(runner) {\n  spawnSync(runner, args);\n}\nlaunch(${runner});\n`), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(`function launch(profile = ${profile}) {\n  spawnSync(profile.bin, args);\n}\nlaunch();\n`), ['commands/planted.js:2 profile.bin']);
    assert.deepStrictEqual(planted('const runner = resolveClaudeRunnerBin;\nspawnSync(runner, args);\n'), [], 'a resolver reference alone does not identify an engine program');
  }
  // Launch helpers accept whitespace before their own opening parenthesis.
  for (const helper of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnWithOutputChunks', 'runInReapedProcessGroup']) {
    for (const gap of [' ', '\t', '\n']) {
      const call = (program, args = 'args') => `${helper}${gap}(${program}, ${args});`;
      assert.deepStrictEqual(planted(`const runner = resolveClaudeRunnerBin();\n${call('runner')}\n`), ['commands/planted.js:2 runner']);
      assert.deepStrictEqual(planted(`const profile = resolveEngineProfile();\n${call('profile.bin')}\n`), ['commands/planted.js:2 profile.bin']);
      assert.deepStrictEqual(planted(`${call('resolveClaudeRunnerBin()')}\n`), ['commands/planted.js:1 resolveClaudeRunnerBin()']);
      assert.deepStrictEqual(planted(`const runner = resolveClaudeRunnerBin();\nstartEngineRun(root);\n${call('runner')}\n`), []);
      assert.deepStrictEqual(planted(`const runner = resolveClaudeRunnerBin();\n${call('runner', "['--help']")}\n`), []);
      assert.deepStrictEqual(planted(`const runner = 'git';\n${call('runner')}\n`), []);
      assert.deepStrictEqual(planted(`function launch(runner) {\n  ${call('runner')}\n}\nlaunch(resolveClaudeRunnerBin());\n`), ['commands/planted.js:2 runner']);
    }
  }
  // Spaces and line breaks before the call parentheses do not change its arguments.
  for (const gap of [' ', '\t', '\n']) {
    const spaced = (argument, body = '  spawnSync(runner, args);') => planted(`function launch(runner) {\n${body}\n}\nlaunch${gap}(${argument});\n`);
    assert.deepStrictEqual(spaced("'claude'"), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(spaced('resolveClaudeRunnerBin()'), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(spaced("'git'"), []);
    assert.deepStrictEqual(spaced("'claude'", '  startEngineRun(root);\n  spawnSync(runner, args);'), []);
    assert.deepStrictEqual(spaced("'claude'", "  spawnSync(runner, ['--help']);"), []);
    assert.deepStrictEqual(planted(`function launch(profile) {\n  spawnSync(profile.bin, args);\n}\nlaunch${gap}(resolveEngineProfile());\n`), ['commands/planted.js:2 profile.bin']);
  }
  // Resolver defaults keep nested parentheses and commas in one parameter.
  for (const prefix of ['function launch', 'const launch =', 'let launch = async', 'const launch = function worker']) {
    const arrow = prefix === 'const launch =' || prefix === 'let launch = async' ? ' =>' : '';
    const end = prefix === 'function launch' ? '}' : '};';
    const source = (parameters, body, call = 'launch();') => `${prefix}(${parameters})${arrow} {\n${body}\n${end}\n${call}\n`;
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  spawnSync(runner, args);')), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  startEngineRun(root);\n  spawnSync(runner, args);')), []);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', "  spawnSync(runner, ['--help']);")), []);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  spawnSync(runner, args);', "launch('git');")), []);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  spawnSync(runner, args);', 'launch(null);')), []);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  spawnSync(runner, args);', '')), []);
    assert.deepStrictEqual(planted(source("runner = findExecutable('git')", '  spawnSync(runner, args);')), []);
    assert.deepStrictEqual(planted(source("prompt = render('a,b', { nested: [one, two] }), runner = resolveClaudeRunnerBin()", '  spawnSync(runner, args);')), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(source("prompt = render('a,b', { nested: [one, two] }), runner = resolveClaudeRunnerBin()", '  spawnSync(runner, args);', "launch(prompt, 'git');")), []);
    assert.deepStrictEqual(planted(source("profile = resolveEngineProfile(select('a,b', [one, two]))", '  const runner = profile.bin;\n  spawnSync(runner, args);')), ['commands/planted.js:3 runner']);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin(), prompt = render(one, two)', '  spawnSync(runner, args);')), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(source('runner = resolveClaudeRunnerBin()', '  function nested() {\n    spawnSync(runner, args);\n  }\n  nested();')), ['commands/planted.js:3 runner']);
  }
  assert.deepStrictEqual(planted("function launch(runner = resolveClaudeRunnerBin()) {\n  spawnSync(runner, args);\n}\nfunction other({ run = wrap, launch }) {\n  launch();\n}\n"), [], 'a destructured binding after another default still hides the launcher');
  // An explicit undefined argument uses the default too, unless a visible
  // binding named undefined holds some other value.
  const withDefault = (call, between = '') => planted(`function launch(prompt, runner = resolveClaudeRunnerBin()) {\n  spawnSync(runner, args);\n}\n${between}${call}\n`);
  assert.deepStrictEqual(withDefault('launch(prompt, undefined);'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(withDefault('launch(prompt, void 0);'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(withDefault('launch(prompt,  undefined  );'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(planted("function launch(prompt, runner = resolveClaudeRunnerBin()) {\n  startEngineRun(root);\n  spawnSync(runner, args);\n}\nlaunch(prompt, undefined);\n"), []);
  assert.deepStrictEqual(planted("function launch(runner) {\n  spawnSync(runner, args);\n}\nlaunch(undefined);\n"), [], 'undefined with no default names no engine');
  assert.deepStrictEqual(withDefault('launch(prompt, undefined);', "const undefined = 'git';\n"), [], 'a module binding named undefined replaces the default');
  assert.deepStrictEqual(withDefault('launch(prompt, undefined);', "const undefined = 'claude';\n"), ['commands/planted.js:2 runner'], 'a redefined undefined is traced like any argument');
  assert.deepStrictEqual(withDefault("function caller() {\n  const undefined = 'git';\n  launch(prompt, undefined);\n}"), [], 'a local binding named undefined replaces the default');
  assert.deepStrictEqual(withDefault("function caller(undefined) {\n  launch(prompt, undefined);\n}"), [], 'a parameter named undefined is not evidence of the default');
  assert.deepStrictEqual(withDefault("function caller() {\n  {\n    const undefined = 'git';\n  }\n  launch(prompt, undefined);\n}"), ['commands/planted.js:2 runner'], 'a binding in a closed block does not reach the call');
  assert.deepStrictEqual(withDefault("function other() {\n  const undefined = 'git';\n}\nlaunch(prompt, undefined);"), ['commands/planted.js:2 runner'], 'a binding inside a sibling helper does not reach the call');
  // A spread of a known array fills the slots it covers; one with unknown
  // contents may leave the runner slot to its default.
  const spreadOne = (call, between = '') => planted(`function launch(runner = resolveClaudeRunnerBin()) {\n  spawnSync(runner, args);\n}\n${between}${call}\n`);
  const spreadNoDefault = (call, between = '') => planted(`function launch(runner) {\n  spawnSync(runner, args);\n}\n${between}${call}\n`);
  assert.deepStrictEqual(spreadOne('launch(...[]);'), ['commands/planted.js:2 runner'], 'an empty spread leaves the default');
  assert.deepStrictEqual(spreadOne("launch(...['git']);"), []);
  assert.deepStrictEqual(spreadOne("launch(...['git',]);"), [], 'a trailing comma adds no slot');
  assert.deepStrictEqual(spreadNoDefault("launch(...['claude']);"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(spreadOne('launch(...picks);', "const picks = ['git'];\n"), []);
  assert.deepStrictEqual(spreadOne('launch(...picks);', 'const picks = [];\n'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(spreadNoDefault('launch(...picks);', "const picks = ['claude'];\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(spreadNoDefault('launch(...picks);', "const inner = ['claude'];\nconst picks = [...inner];\n"), ['commands/planted.js:2 runner'], 'a spread inside the array is followed');
  assert.deepStrictEqual(spreadOne('launch(...rest);'), ['commands/planted.js:2 runner'], 'unknown contents may leave the default');
  assert.deepStrictEqual(spreadNoDefault('launch(...rest);'), [], 'unknown contents with no default name no engine');
  assert.deepStrictEqual(spreadOne('launch(...picks);', "const picks = ['git'];\npicks.pop();\n"), ['commands/planted.js:2 runner'], 'an array emptied after its declaration counts as unknown');
  assert.deepStrictEqual(spreadOne('launch(...picks);', "const picks = [\n  'git',\n];\n"), [], 'a multi-line array fills its slots');
  assert.deepStrictEqual(spreadOne('launch(...picks);', 'const picks = [\n];\n'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(spreadNoDefault('launch(...picks);', "const picks = [\n  'claude',\n  { a: [1, 2] },\n]\n"), ['commands/planted.js:2 runner'], 'a declaration without a semicolon ends at its line break');
  assert.deepStrictEqual(spreadOne('launch(...picks);', "const picks = [\n  'git',\n].filter(Boolean);\n"), ['commands/planted.js:2 runner'], 'an array that is only part of the value reads as unknown');
  assert.deepStrictEqual(spreadOne('launch(...picks);', "const picks = [\n  'git',\n];\npicks.pop();\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(withDefault("launch(...[prompt], 'git');"), []);
  assert.deepStrictEqual(withDefault('launch(...[prompt]);'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(withDefault("launch(...[prompt, 'git']);"), []);
  assert.deepStrictEqual(withDefault("launch(...[prompt, undefined]);"), ['commands/planted.js:2 runner'], 'undefined inside a spread array uses the default too');
  // A destructured options parameter reads its key from the call's object,
  // and the key default applies when that object leaves the key unset.
  const options = (call, parameters = '{ runner = resolveClaudeRunnerBin() }', between = '') => planted(`function launch(${parameters}) {\n  spawnSync(runner, args);\n}\n${between}${call}\n`);
  assert.deepStrictEqual(options('launch({});'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ prompt });'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ runner: undefined });'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options("launch({ runner: 'git' });"), []);
  assert.deepStrictEqual(options("launch({ 'runner': 'git' });"), [], 'a quoted key names the same property');
  assert.deepStrictEqual(options('launch(null);'), [], 'null throws before any launch');
  assert.deepStrictEqual(options('launch();'), [], 'an omitted object with no default throws before any launch');
  assert.deepStrictEqual(options('launch();', '{ runner = resolveClaudeRunnerBin() } = {}'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch();', '{ runner } = { runner: resolveClaudeRunnerBin() }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);'), ['commands/planted.js:2 runner'], 'unknown options may leave the key out');
  assert.deepStrictEqual(options('launch({ ...opts });'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options("launch({ runner: 'git', ...opts });"), ['commands/planted.js:2 runner'], 'a later spread may unset the key');
  assert.deepStrictEqual(options("launch({ ...opts, runner: 'git' });"), [], 'a key after the spread wins');
  assert.deepStrictEqual(options('launch({ runner: resolveClaudeRunnerBin() });', '{ runner }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ runner });', '{ runner }', 'const runner = resolveClaudeRunnerBin();\n'), ['commands/planted.js:2 runner'], 'a shorthand key reads the binding at the call');
  assert.deepStrictEqual(options("launch({ runner: 'git' });", '{ runner }'), []);
  assert.deepStrictEqual(options('launch({});', '{ bin: runner = resolveClaudeRunnerBin() }'), ['commands/planted.js:2 runner'], 'a renamed key keeps its own default');
  assert.deepStrictEqual(options('launch({ runner: resolveClaudeRunnerBin() });', '{ bin: runner }'), [], 'the key, not the local name, picks the value');
  assert.deepStrictEqual(options('launch(prompt, {});', 'prompt, { runner = resolveClaudeRunnerBin() }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(planted("function launch({ runner = resolveClaudeRunnerBin() }) {\n  startEngineRun(root);\n  spawnSync(runner, args);\n}\nlaunch({});\n"), []);
  // A nested pattern follows each key in turn, and a nested default stands
  // in for a missing key that holds it.
  const nested = '{ engine: { runner = resolveClaudeRunnerBin() } }';
  assert.deepStrictEqual(options('launch({ engine: {} });', nested), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options("launch({ engine: { runner: 'git' } });", nested), []);
  assert.deepStrictEqual(options('launch({});', nested), [], 'a missing nested object with no default throws before any launch');
  assert.deepStrictEqual(options('launch({});', '{ engine: { runner = resolveClaudeRunnerBin() } = {} }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch();', '{ engine: { runner = resolveClaudeRunnerBin() } = {} } = {}'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ engine: picks });', nested), ['commands/planted.js:2 runner'], 'an unknown nested object may leave the key out');
  assert.deepStrictEqual(options('launch(opts);', nested), ['commands/planted.js:2 runner'], 'unknown options hold an unknown nested object');
  assert.deepStrictEqual(options("launch({ engine: { runner: 'git', ...more } });", nested), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ engine: { runner: resolveClaudeRunnerBin() } });', '{ engine: { runner } }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options("launch({ engine: { runner: 'git' } });", '{ engine: { runner } = { runner: resolveClaudeRunnerBin() } }'), [], 'a supplied nested object replaces its default');
  assert.deepStrictEqual(options('launch({});', '{ engine: { runner } = { runner: resolveClaudeRunnerBin() } }'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ engine: { bin: resolveClaudeRunnerBin() } });', '{ engine: { bin: runner } }'), ['commands/planted.js:2 runner'], 'a renamed nested key reads its own key');
  // Options built in a variable read like the literal it was declared with,
  // unless something writes to its keys after the declaration.
  const defaulted = '{ runner = resolveClaudeRunnerBin() }';
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = { runner: 'git' };\n"), [], 'a known object in a variable supplies its key');
  assert.deepStrictEqual(options('launch(opts);', defaulted, 'const opts = { prompt };\n'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);', '{ runner }', 'const opts = { runner: resolveClaudeRunnerBin() };\n'), ['commands/planted.js:2 runner'], 'a variable can carry the engine itself');
  assert.deepStrictEqual(options('launch(opts);', '{ runner }', "const opts = { runner: 'git' };\n"), []);
  assert.deepStrictEqual(options('launch(opts);', '{ runner }', 'const runner = resolveClaudeRunnerBin();\nconst opts = { runner };\n'), ['commands/planted.js:2 runner'], 'a shorthand key reads the binding at the declaration');
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = { runner: 'git' };\nopts.runner = undefined;\n"), ['commands/planted.js:2 runner'], 'an object written after its declaration counts as unknown');
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = { runner: 'git' };\ndelete opts.runner;\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = { runner: 'git' };\nObject.assign(opts, more);\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = { runner: 'git' };\nif (opts.runner === 'git') noop();\n"), [], 'a comparison is not a write');
  assert.deepStrictEqual(options('launch({ engine: picks });', nested, "const picks = { runner: 'git' };\n"), []);
  assert.deepStrictEqual(options('launch(opts);', '{ runner }', 'function other() {\n  const opts = { runner: resolveClaudeRunnerBin() };\n}\n'), [], 'a declaration inside another function does not reach the call');
  // A literal written across several lines reads the same as one on a
  // single line, when it is the whole declared value.
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = {\n  prompt,\n  runner: 'git',\n};\n"), [], 'a multi-line object supplies its key');
  assert.deepStrictEqual(options('launch(opts);', defaulted, 'const opts = {\n  prompt,\n  timeout: 5,\n};\n'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);', '{ runner }', 'const opts = {\n  prompt,\n  runner: resolveClaudeRunnerBin(),\n};\n'), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = {\n  runner: 'git',\n  nested: { a: [1, 2] },\n}\n"), [], 'a declaration without a semicolon ends at its line break');
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = {\n  runner: 'git',\n} || fallback;\n"), ['commands/planted.js:2 runner'], 'a literal that is only part of the value reads as unknown');
  assert.deepStrictEqual(options('launch(opts);', defaulted, "const opts = {\n  runner: 'git',\n};\nopts.runner = undefined;\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(options('launch({ engine: picks });', nested, "const picks = {\n  runner: 'git',\n};\n"), []);
  // Literal and captured defaults count only when a same-file call omits them.
  for (const [head, tail] of [
    ['function launch', '}'],
    ['const launch = ', '};'],
    ['const launch = function named', '};'],
    ['let launch = async ', '};'],
  ]) {
    const arrow = head.endsWith(' ') ? ' =>' : '';
    const launcher = (runner, body, call = 'launch();') => `${head}(runner = ${runner})${arrow} {\n${body}\n${tail}\n${call}\n`;
    assert.deepStrictEqual(planted(launcher("'claude'", '  spawnSync(runner, args);')), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(launcher("'claude'", '  spawnSync(runner, args);', '')), [], 'an uncalled default is not a run');
    assert.deepStrictEqual(planted(launcher("'claude'", '  spawnSync(runner, args);', "launch('git');")), [], 'a supplied plain program overrides the default');
    assert.deepStrictEqual(planted(launcher("'claude'", '  spawnSync(runner, args);', 'launch(null);')), [], 'null does not select the default');
    assert.deepStrictEqual(planted(launcher("'git'", '  spawnSync(runner, args);')), [], 'a plain default is not an engine');
    assert.deepStrictEqual(planted(launcher("'claude'", '  startEngineRun(root);\n  spawnSync(runner, args);')), []);
    assert.deepStrictEqual(planted(launcher("'claude'", "  spawnSync(runner, ['--help']);")), []);
    assert.deepStrictEqual(planted('const fallback = resolveClaudeRunnerBin();\n' + launcher('fallback', '  const fallback = \'git\';\n  spawnSync(runner, args);')), ['commands/planted.js:4 runner'], 'body declarations cannot hide the default source');
    assert.deepStrictEqual(planted('const profile = resolveEngineProfile(engine);\n' + launcher('profile', '  spawnSync(runner.bin, args);')), ['commands/planted.js:3 runner.bin']);
  }
  assert.deepStrictEqual(planted("function launch(prompt, runner = 'claude') {\n  spawnSync(runner, args);\n}\nlaunch('hello');\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(planted("function launch(runner = 'claude') {\n  spawnSync(runner, args);\n}\nfunction forward() {\n  launch();\n}\n"), ['commands/planted.js:2 runner']);
  assert.deepStrictEqual(planted("function a() {\n  const bin = findExecutable('claude', env);\n  return spawnSync(bin, ['-p', prompt]);\n}\n"), ['commands/planted.js:3 bin']);
  assert.deepStrictEqual(planted("function a() {\n  const inv = engineInvocation(engine, prompt);\n  spawn(inv.command, inv.args);\n}\n"), ['commands/planted.js:3 inv.command']);
  assert.deepStrictEqual(planted("function a() {\n  spawn(resolveClaudeRunnerBin(), args);\n}\n"), ['commands/planted.js:2 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted("function a() {\n  const bin = resolveClaudeRunnerBin();\n  spawnSync(bin, ['--help']);\n}\n"), [], 'a help probe starts no run');
  assert.deepStrictEqual(planted("function a() {\n  const profile = resolveEngineProfile(engine);\n  const runner = profile.bin;\n  const program = runner;\n  spawnSync(program, args);\n}\n"), ['commands/planted.js:5 program']);
  assert.deepStrictEqual(planted("function a() {\n  const runner = resolveClaudeRunnerBin();\n  const program = runner;\n  const end = startEngineRun(root);\n  spawnSync(program, args);\n}\n"), []);
  assert.deepStrictEqual(planted("function a() {\n  const runner = resolveClaudeRunnerBin();\n  const program = runner;\n  spawnSync(program, ['--help']);\n}\n"), []);
  assert.deepStrictEqual(planted("function a() {\n  const runner = findExecutable('git');\n  const program = runner;\n  spawnSync(program, args);\n}\n"), []);
  assert.deepStrictEqual(planted("function a() {\n  const program = runner;\n  const runner = resolveClaudeRunnerBin();\n  spawnSync(program, args);\n}\n"), [], 'a later declaration is not the source of an earlier alias');
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), ['commands/planted.js:2 program']);
  assert.deepStrictEqual(planted("function launch(prompt, profile) {\n  spawnSync(profile.bin, args);\n}\nfunction caller() {\n  const runner = resolveEngineProfile(engine);\n  launch(prompt, runner);\n}\n"), ['commands/planted.js:2 profile.bin']);
  assert.deepStrictEqual(planted("function launch(program) {\n  const end = startEngineRun(root);\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, ['--help']);\n}\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\nlaunch(findExecutable('git'));\n"), []);
  assert.deepStrictEqual(planted("function launch(prompt, program) {\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin(), git);\n"), [], 'an engine in another argument does not identify the program');
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\n// launch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\nlaunch(git);\nother.launch(resolveClaudeRunnerBin());\n"), [], 'a member call does not supply a local function parameter');
  assert.deepStrictEqual(planted("function launch(prompt, program) {\n  spawnSync(program, args);\n}\nlaunch('hi, there', resolveClaudeRunnerBin());\n"), ['commands/planted.js:2 program']);
  assert.deepStrictEqual(planted("function launch(program, options) {\n  spawnSync(program, args);\n}\nfunction caller() {\n  const runner = findExecutable('claude', env);\n  launch(\n    runner,\n    { prompt: buildPrompt(topic) }\n  );\n}\n"), ['commands/planted.js:2 program']);
  assert.deepStrictEqual(planted("function launch(options, program) {\n  spawnSync(program, args);\n}\nlaunch({ a: 1, b: 2 }, resolveClaudeRunnerBin());\n"), ['commands/planted.js:2 program']);
  assert.deepStrictEqual(planted("function launch(options, program) {\n  spawnSync(program, args);\n}\nlaunch([1, resolveClaudeRunnerBin()], git);\n"), [], 'an engine in an earlier array is not the program argument');
  assert.deepStrictEqual(planted("function launch(runner) {\n  const program = runner;\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), ['commands/planted.js:3 program']);
  assert.deepStrictEqual(planted("function launch(profile) {\n  const runner = profile.bin;\n  const program = runner;\n  spawnSync(program, args);\n}\nlaunch(resolveEngineProfile(engine));\n"), ['commands/planted.js:4 program']);
  assert.deepStrictEqual(planted("function launch(runner) {\n  const program = runner;\n  startEngineRun(root);\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function launch(runner) {\n  const program = runner;\n  spawnSync(program, ['--help']);\n}\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function launch(runner) {\n  const program = runner;\n  spawnSync(program, args);\n}\nlaunch(findExecutable('git'));\n"), []);
  assert.deepStrictEqual(planted("function launch(runner) {\n  const program = buildCommand(runner);\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("function outer() {\n  const launch = (program) => {\n    spawnSync(program, args);\n  };\n  launch(resolveClaudeRunnerBin());\n}\n"), ['commands/planted.js:3 program']);
  assert.deepStrictEqual(planted("const launch = (program) => {\n  spawnSync(program, args);\n};\nlaunch(resolveClaudeRunnerBin());\n"), ['commands/planted.js:2 program']);
  assert.deepStrictEqual(planted("const launch = async (prompt, profile) => {\n  const runner = profile.bin;\n  spawn(runner, args);\n};\nlaunch(prompt, resolveEngineProfile(engine));\n"), ['commands/planted.js:3 runner']);
  assert.deepStrictEqual(planted("let launch = (program) => spawnSync(program, args);\nlaunch(resolveClaudeRunnerBin());\n"), ['commands/planted.js:1 program']);
  assert.deepStrictEqual(planted("const launch = (program) => {\n  startEngineRun(root);\n  spawnSync(program, args);\n};\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("const launch = (program) => {\n  spawnSync(program, ['--help']);\n};\nlaunch(resolveClaudeRunnerBin());\n"), []);
  assert.deepStrictEqual(planted("const launch = (program) => {\n  spawnSync(program, args);\n};\nlaunch(findExecutable('git'));\n"), []);
  assert.deepStrictEqual(planted("const launch = (prompt, program) => {\n  spawnSync(program, args);\n};\nlaunch(resolveClaudeRunnerBin(), git);\n"), []);
  {
    const source = "function outer() {\n  function helper() {\n    startEngineRun(root);\n  }\n  spawn(resolveClaudeRunnerBin(), args);\n}\n";
    assert.deepStrictEqual(planted(source), ['commands/planted.js:5 resolveClaudeRunnerBin()']);
  }
  {
    const source = "function outer() {\n  const helper = () => {\n    startEngineRun(root);\n  };\n  spawn(resolveClaudeRunnerBin(), args);\n}\n";
    assert.deepStrictEqual(planted(source), ['commands/planted.js:5 resolveClaudeRunnerBin()']);
  }
  {
    const source = "function outer() {\n  const helper = () =>\n    startEngineRun(root);\n\n  spawn(resolveClaudeRunnerBin(), args);\n}\n";
    assert.deepStrictEqual(planted(source), ['commands/planted.js:5 resolveClaudeRunnerBin()']);
  }
  {
    const source = "function outer() {\n  startEngineRun(root);\n  function helper() {\n    noop();\n  }\n  spawn(resolveClaudeRunnerBin(), args);\n}\n";
    assert.deepStrictEqual(planted(source), []);
  }
  assert.deepStrictEqual(planted("function outer() {\n  function helper() { startEngineRun(root); }\n}\nfunction caller() {\n  outer();\n  spawn(resolveClaudeRunnerBin(), args);\n}\n"), ['commands/planted.js:6 resolveClaudeRunnerBin()'], 'a nested recorder does not make the parent a recording wrapper');
  assert.deepStrictEqual(planted("function outer() {\n  function helper() {\n    startEngineRun(root);\n    spawn(resolveClaudeRunnerBin(), args);\n  }\n}\n"), [], 'a recorded launch inside a helper stays covered');
  assert.deepStrictEqual(planted("function outer() {\n  startEngineRun(root);\n  function helper() {\n    spawn(resolveClaudeRunnerBin(), args);\n  }\n}\n"), ['commands/planted.js:4 resolveClaudeRunnerBin()'], 'a parent recording does not cover a launch inside its helper');
  assert.deepStrictEqual(planted("function outer() {\n  startEngineRun(root);\n  const helper = () => {\n    const runner = resolveClaudeRunnerBin();\n    spawn(runner, args);\n  };\n}\n"), ['commands/planted.js:5 runner']);
  assert.deepStrictEqual(planted("function outer() {\n  startEngineRun(root);\n  const launch = runner => {\n    spawnSync(runner, args);\n  };\n  launch(resolveClaudeRunnerBin());\n}\n"), ['commands/planted.js:4 runner'], 'a parent recording cannot cover a single-input helper');
  assert.deepStrictEqual(planted("const record = input => startEngineRun(root);\nspawn(resolveClaudeRunnerBin(), args);\n"), ['commands/planted.js:2 resolveClaudeRunnerBin()'], 'a single-input recording definition is not a recording call');
  // A single input may omit parentheses in both block and concise arrows.
  for (const prefix of ['const launch = runner =>', 'let launch = async runner =>']) {
    assert.deepStrictEqual(planted(`${prefix} {\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin());\n`), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(`${prefix} spawnSync(runner, args);\nlaunch(resolveClaudeRunnerBin());\n`), ['commands/planted.js:1 runner']);
    assert.deepStrictEqual(planted(`${prefix} {\n  const program = runner.bin;\n  spawnSync(program, args);\n};\nlaunch(resolveEngineProfile(engine));\n`), ['commands/planted.js:3 program']);
    assert.deepStrictEqual(planted(`${prefix} {\n  startEngineRun(root);\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin());\n`), []);
    assert.deepStrictEqual(planted(`${prefix} spawnSync(runner, ['--help']);\nlaunch(resolveClaudeRunnerBin());\n`), []);
    assert.deepStrictEqual(planted(`${prefix} spawnSync(runner, args);\nlaunch(findExecutable('git'));\n`), []);
  }
  // Runner arguments can pass through a second helper before the launch.
  for (const helper of ['function relay(runner)', 'const relay = (runner) =>', 'const relay = async runner =>', 'const relay = function forward(runner)']) {
    const end = helper.startsWith('function') ? '}' : '};';
    const source = (body, argument) => `function launch(program) {\n${body}\n}\n${helper} {\n  launch(runner);\n${end}\nrelay(${argument});\n`;
    assert.deepStrictEqual(planted(source('  spawnSync(program, args);', 'resolveClaudeRunnerBin()')), ['commands/planted.js:2 program']);
    assert.deepStrictEqual(planted(source('  startEngineRun(root);\n  spawnSync(program, args);', 'resolveClaudeRunnerBin()')), []);
    assert.deepStrictEqual(planted(source("  spawnSync(program, ['--help']);", 'resolveClaudeRunnerBin()')), []);
    assert.deepStrictEqual(planted(source('  spawnSync(program, args);', "findExecutable('git')")), []);
    assert.deepStrictEqual(planted(source('  const bin = program.bin;\n  spawnSync(bin, args);', 'resolveEngineProfile(engine)')), ['commands/planted.js:3 bin']);
  }
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\nfunction relay(runner) {\n  launch(runner);\n  relay(runner);\n}\nrelay(git);\n"), [], 'a circular helper chain without an engine terminates');
  assert.deepStrictEqual(planted("function launch(program) {\n  spawnSync(program, args);\n}\nfunction relay(runner) {\n  launch(runner);\n  relay(runner);\n}\nrelay(resolveClaudeRunnerBin());\n"), ['commands/planted.js:2 program'], 'a circular branch does not hide another engine caller');
  // A nested helper can capture a forwarded parameter without receiving it.
  for (const helper of ['function nested()', 'const nested = () =>', 'const nested = async () =>', 'const nested = function worker()']) {
    const end = helper.startsWith('function') ? '}' : '};';
    const source = (body, argument) => `function relay(runner) {\n  ${helper} {\n${body}\n  ${end}\n  nested();\n}\nrelay(${argument});\n`;
    assert.deepStrictEqual(planted(source('    spawnSync(runner, args);', 'resolveClaudeRunnerBin()')), ['commands/planted.js:3 runner']);
    assert.deepStrictEqual(planted(source('    startEngineRun(root);\n    spawnSync(runner, args);', 'resolveClaudeRunnerBin()')), []);
    assert.deepStrictEqual(planted(source("    spawnSync(runner, ['--help']);", 'resolveClaudeRunnerBin()')), []);
    assert.deepStrictEqual(planted(source('    spawnSync(runner, args);', "findExecutable('git')")), []);
    assert.deepStrictEqual(planted(source('    const bin = runner.bin;\n    spawnSync(bin, args);', 'resolveEngineProfile(engine)')), ['commands/planted.js:4 bin']);
  }
  assert.deepStrictEqual(planted("function relay(runner) {\n  const program = runner;\n  function nested(runner) {\n    spawnSync(program, args);\n  }\n  nested(git);\n}\nrelay(resolveClaudeRunnerBin());\n"), ['commands/planted.js:4 program'], 'a captured alias keeps its parameter owner when an inner parameter has the same name');
  assert.deepStrictEqual(planted("function relay(runner) {\n  function nested(runner) {\n    spawnSync(runner, args);\n  }\n  nested(git);\n}\nrelay(resolveClaudeRunnerBin());\n"), [], 'a matching inner parameter hides the forwarded engine');
  assert.deepStrictEqual(planted("function relay(runner) {\n  function nested(runner) {\n    spawnSync(runner, args);\n  }\n  nested(resolveClaudeRunnerBin());\n}\nrelay(git);\n"), ['commands/planted.js:3 runner'], 'an inner engine parameter is followed independently of the outer argument');
  // A helper parameter hides an outer declaration with the same name.
  for (const arrow of [false, true, 'single']) {
    const helper = arrow === 'single' ? 'const launch = runner =>' : arrow ? 'const launch = (runner) =>' : 'function launch(runner)';
    const outer = (runner, body, argument) => `function outer() {\n  const runner = ${runner};\n  ${helper} {\n${body}\n  }${arrow ? ';' : ''}\n  launch(${argument});\n}\n`;
    assert.deepStrictEqual(planted(`function outer() {\n  const runner = resolveClaudeRunnerBin();\n  const program = runner;\n  ${helper} {\n    spawnSync(program, args);\n  }${arrow ? ';' : ''}\n  launch(findExecutable('git'));\n}\n`), ['commands/planted.js:5 program'], 'a captured alias resolves where it was declared');
    const captured = arrow ? 'const launch = () =>' : 'function launch()';
    assert.deepStrictEqual(planted(`function outer() {\n  const runner = resolveClaudeRunnerBin();\n  ${captured} {\n    spawnSync(runner, args);\n  }${arrow ? ';' : ''}\n  launch();\n}\n`), ['commands/planted.js:4 runner'], 'a helper without a matching parameter still captures the outer runner');
    assert.deepStrictEqual(planted(outer("findExecutable('git')", '    spawnSync(runner, args);', 'resolveClaudeRunnerBin()')), ['commands/planted.js:4 runner']);
    assert.deepStrictEqual(planted(outer('resolveClaudeRunnerBin()', '    spawnSync(runner, args);', "findExecutable('git')")), [], 'the outer engine is hidden by the helper parameter');
    assert.deepStrictEqual(planted(outer("findExecutable('git')", '    const program = runner.bin;\n    spawnSync(program, args);', 'resolveEngineProfile(engine)')), ['commands/planted.js:5 program']);
    assert.deepStrictEqual(planted(outer("findExecutable('git')", '    startEngineRun(root);\n    spawnSync(runner, args);', 'resolveClaudeRunnerBin()')), []);
    assert.deepStrictEqual(planted(outer("findExecutable('git')", "    spawnSync(runner, ['--help']);", 'resolveClaudeRunnerBin()')), []);
  }
  // Function expressions receive runners through the variable used to call them.
  for (const prefix of ['const launch = function', 'let launch = async function', 'var launch = function worker']) {
    assert.deepStrictEqual(planted(`${prefix}(runner) {\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin());\n`), ['commands/planted.js:2 runner']);
    assert.deepStrictEqual(planted(`${prefix}(prompt, profile) {\n  const program = profile.bin;\n  spawnSync(program, args);\n};\nlaunch(prompt, resolveEngineProfile(engine));\n`), ['commands/planted.js:3 program']);
    assert.deepStrictEqual(planted(`${prefix}(runner) {\n  startEngineRun(root);\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin());\n`), []);
    assert.deepStrictEqual(planted(`${prefix}(runner) {\n  spawnSync(runner, ['--help']);\n};\nlaunch(resolveClaudeRunnerBin());\n`), []);
    assert.deepStrictEqual(planted(`${prefix}(runner) {\n  spawnSync(runner, args);\n};\nlaunch(findExecutable('git'));\n`), []);
    assert.deepStrictEqual(planted(`${prefix}(prompt, runner) {\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin(), git);\n`), []);
    const nested = (outerRunner, argument) => `function outer() {\n  const runner = ${outerRunner};\n  ${prefix}(runner) {\n    spawnSync(runner, args);\n  };\n  launch(${argument});\n}\n`;
    assert.deepStrictEqual(planted(nested("findExecutable('git')", 'resolveClaudeRunnerBin()')), ['commands/planted.js:4 runner']);
    assert.deepStrictEqual(planted(nested('resolveClaudeRunnerBin()', "findExecutable('git')")), [], 'function expression parameters hide captured runners');
    assert.deepStrictEqual(planted(`function outer() {\n  startEngineRun(root);\n  ${prefix}(runner) {\n    spawnSync(runner, args);\n  };\n  launch(resolveClaudeRunnerBin());\n}\n`), ['commands/planted.js:4 runner'], 'a parent recording cannot cover a function expression');
    assert.deepStrictEqual(planted(`${prefix}(runner) { startEngineRun(root); };\nspawn(resolveClaudeRunnerBin(), args);\n`), ['commands/planted.js:2 resolveClaudeRunnerBin()'], 'a function expression definition is not a recording call');
  }
  // Named expressions can supply runner arguments through their own name.
  for (const prefix of ['const launch = function worker', 'let launch = async function worker$']) {
    const name = prefix.endsWith('$') ? 'worker$' : 'worker';
    const expression = (body, outside = '') => `${prefix}(runner) {\n${body}\n};\n${outside}`;
    assert.deepStrictEqual(planted(expression(`  ${name}(resolveClaudeRunnerBin());\n  spawnSync(runner, args);`)), ['commands/planted.js:3 runner']);
    assert.deepStrictEqual(planted(expression(`  const profile = resolveEngineProfile(engine);\n  ${name}(profile);\n  const program = runner.bin;\n  spawnSync(program, args);`)), ['commands/planted.js:5 program']);
    assert.deepStrictEqual(planted(expression(`  ${name}(resolveClaudeRunnerBin());\n  startEngineRun(root);\n  spawnSync(runner, args);`)), []);
    assert.deepStrictEqual(planted(expression(`  ${name}(resolveClaudeRunnerBin());\n  spawnSync(runner, ['--help']);`)), []);
    assert.deepStrictEqual(planted(expression(`  ${name}(findExecutable('git'));\n  spawnSync(runner, args);`)), []);
    assert.deepStrictEqual(planted(expression('  spawnSync(runner, args);', `${name}(resolveClaudeRunnerBin());\n`)), [], 'an internal name is not visible after the expression');
    assert.deepStrictEqual(planted(`${name}(resolveClaudeRunnerBin());\n` + expression('  spawnSync(runner, args);')), [], 'an internal name is not visible before the expression');
    assert.deepStrictEqual(planted(expression(`  other.${name}(resolveClaudeRunnerBin());\n  spawnSync(runner, args);`)), [], 'a member call does not supply the internal parameter');
    assert.deepStrictEqual(planted(expression('  spawnSync(runner, args);', 'launch(resolveClaudeRunnerBin());\n')), ['commands/planted.js:2 runner'], 'the assigned variable still supplies parameters');
    assert.deepStrictEqual(planted(`${prefix}(${name}) {\n  ${name}(resolveClaudeRunnerBin());\n  spawnSync(${name}, args);\n};\nlaunch(git);\n`), [], 'a parameter hides the internal function name');
    assert.deepStrictEqual(planted(expression(`  const ${name} = other;\n  ${name}(resolveClaudeRunnerBin());\n  spawnSync(runner, args);`)), [], 'a local alias hides the internal function name');
    assert.deepStrictEqual(planted(expression(`  function inner() {\n    const ${name} = other;\n  }\n  ${name}(resolveClaudeRunnerBin());\n  spawnSync(runner, args);`)), ['commands/planted.js:6 runner'], 'an alias in a sibling helper does not hide the internal function name');
    assert.deepStrictEqual(planted(`function outer() {\n  const ${name} = other;\n  ${prefix}(runner) {\n    ${name}(resolveClaudeRunnerBin());\n    spawnSync(runner, args);\n  };\n}\n`), ['commands/planted.js:5 runner'], 'the internal function name hides an outer alias');
  }
  // A nested parameter hides the launcher's own name, even when the assigned
  // and internal names match or the launcher is a plain declaration.
  for (const prefix of ['const launch = function launch', 'let launch = async function launch', 'function launch']) {
    const end = prefix.startsWith('function') ? '}' : '};';
    const launcher = (body, outside = 'launch(git);\n') => `${prefix}(runner) {\n${body}\n  spawnSync(runner, args);\n${end}\n${outside}`;
    assert.deepStrictEqual(planted(launcher('  function helper(launch) {\n    launch(resolveClaudeRunnerBin());\n  }')), [], 'a helper parameter hides the launcher name');
    assert.deepStrictEqual(planted(launcher('  const helper = (launch) => launch(resolveClaudeRunnerBin());')), [], 'an arrow parameter hides the launcher name');
    assert.deepStrictEqual(planted(launcher('  const helper = launch => {\n    launch(resolveClaudeRunnerBin());\n  };')), []);
    assert.deepStrictEqual(planted(launcher('  function helper(other) {\n    launch(resolveClaudeRunnerBin());\n  }')), ['commands/planted.js:5 runner'], 'a helper without a matching parameter still calls the launcher');
    assert.deepStrictEqual(planted(launcher('  function helper(launch) {\n    noop(launch);\n  }\n  launch(resolveClaudeRunnerBin());')), ['commands/planted.js:6 runner'], 'a call after the helper closes still reaches the launcher');
    assert.deepStrictEqual(planted(launcher('', 'function other(launch) {\n  launch(resolveClaudeRunnerBin());\n}\n')), [], 'a later function parameter hides the launcher name');
    assert.deepStrictEqual(planted(launcher('', 'function other(prompt) {\n  launch(resolveClaudeRunnerBin());\n}\n')), ['commands/planted.js:3 runner']);
    // A local alias in another function hides the launcher name the same way.
    assert.deepStrictEqual(planted(launcher('', 'function other() {\n  const launch = wrap;\n  launch(resolveClaudeRunnerBin());\n}\n')), [], 'a local alias hides the launcher name');
    assert.deepStrictEqual(planted(launcher('', 'const other = () => {\n  let launch = wrap;\n  launch(resolveClaudeRunnerBin());\n};\n')), []);
    assert.deepStrictEqual(planted(launcher('  function helper() {\n    var launch = wrap;\n    launch(resolveClaudeRunnerBin());\n  }')), [], 'a helper alias hides the launcher name');
    assert.deepStrictEqual(planted(launcher('', 'function other() {\n  function inner() {\n    const launch = wrap;\n  }\n  launch(resolveClaudeRunnerBin());\n}\n')), ['commands/planted.js:3 runner'], 'an alias in a sibling helper does not hide the call');
    assert.deepStrictEqual(planted(launcher('', 'function other() {\n  const launcher = wrap;\n  launch(resolveClaudeRunnerBin());\n}\n')), ['commands/planted.js:3 runner'], 'a longer name is not an alias of the launcher');
    // A destructured copy hides the launcher name; a renamed key does not.
    for (const copy of ['const { launch } = tools;', 'let { run, launch = wrap } = tools;', 'var { run: launch } = tools;', 'const [launch] = tools;', 'const [, launch] = tools;', 'const {\n    launch,\n  } = tools;']) {
      assert.deepStrictEqual(planted(launcher('', `function other() {\n  ${copy}\n  launch(resolveClaudeRunnerBin());\n}\n`)), [], `a destructured copy hides the launcher name: ${copy}`);
    }
    for (const copy of ['const { launch: run } = tools;', 'const { launcher } = tools;', 'const [launcher] = tools;']) {
      assert.deepStrictEqual(planted(launcher('', `function other() {\n  ${copy}\n  launch(resolveClaudeRunnerBin());\n}\n`)), ['commands/planted.js:3 runner'], `a destructured copy of another name still calls the launcher: ${copy}`);
    }
    // A destructured parameter hides the launcher name; a renamed key or a default value does not.
    for (const header of ['function other({ launch })', 'const other = ({ run, launch = wrap }) =>', 'function other([, launch])', 'function other(tools, { run: launch })', 'function other(...launch)']) {
      assert.deepStrictEqual(planted(launcher('', `${header} {\n  launch(resolveClaudeRunnerBin());\n}\n`)), [], `a destructured parameter hides the launcher name: ${header}`);
    }
    for (const header of ['function other({ launch: run })', 'function other({ run = launch })', 'function other({ launcher })']) {
      assert.deepStrictEqual(planted(launcher('', `${header} {\n  launch(resolveClaudeRunnerBin());\n}\n`)), ['commands/planted.js:3 runner'], `a parameter that does not bind the name still calls the launcher: ${header}`);
    }
    // A loop or catch variable hides the launcher name inside its own block only.
    for (const block of ['for (const launch of list) {', 'for (let launch in tools) {', 'for (const launch of Object.values(tools)) {', 'try {\n    run();\n  } catch (launch) {']) {
      assert.deepStrictEqual(planted(launcher('', `function other(list) {\n  ${block}\n    launch(resolveClaudeRunnerBin());\n  }\n}\n`)), [], `a block variable hides the launcher name: ${block}`);
      assert.deepStrictEqual(planted(launcher('', `function other(list) {\n  ${block}\n    noop(launch);\n  }\n  launch(resolveClaudeRunnerBin());\n}\n`)), ['commands/planted.js:3 runner'], `a call after the block still reaches the launcher: ${block}`);
    }
    assert.deepStrictEqual(planted(launcher('', 'for (const launch of list) {\n  launch(resolveClaudeRunnerBin());\n}\n')), [], 'a top-level loop variable hides the launcher name');
    assert.deepStrictEqual(planted(launcher('', 'try {\n  run();\n} catch (launcher) {\n  launch(resolveClaudeRunnerBin());\n}\n')), ['commands/planted.js:3 runner'], 'a longer catch name still calls the launcher');
    // A loop without braces hides the name for its single statement only.
    for (const body of ['for (const launch of list) launch(resolveClaudeRunnerBin());', 'for (const launch of Object.values(tools))\n    launch(resolveClaudeRunnerBin());', 'for (const launch in tools) if (launch) launch(resolveClaudeRunnerBin());']) {
      assert.deepStrictEqual(planted(launcher('', `function other(list) {\n  ${body}\n}\n`)), [], `a loop statement hides the launcher name: ${body}`);
    }
    for (const body of ['for (const launch of list) noop(launch);\n  launch(resolveClaudeRunnerBin());', 'for (const launch of list) noop(launch)\n  launch(resolveClaudeRunnerBin())']) {
      assert.deepStrictEqual(planted(launcher('', `function other(list) {\n  ${body}\n}\n`)), ['commands/planted.js:3 runner'], `a statement after the loop still reaches the launcher: ${body}`);
    }
    // A copy hides the launcher name only until its block or parentheses close.
    for (const body of ['if (ready) {\n    const launch = wrap;\n  }', 'for (let launch = 0; launch < 3; launch++) {}', 'list.forEach(() => { const launch = wrap; });']) {
      assert.deepStrictEqual(planted(launcher('', `function other(list) {\n  ${body}\n  launch(resolveClaudeRunnerBin());\n}\n`)), ['commands/planted.js:3 runner'], `a copy in a closed block does not hide a later call: ${body}`);
    }
    assert.deepStrictEqual(planted(launcher('', 'function other() {\n  if (ready) {\n    const launch = wrap;\n    launch(resolveClaudeRunnerBin());\n  }\n}\n')), [], 'a copy hides the launcher name inside its own block');
  }
  // Closed sibling helpers do not cut off captured runner declarations.
  for (const helper of [
    'function helper() { return 1; }',
    'const helper = () => { return 1; };',
    'const helper = function named() { return 1; };',
  ]) {
    const source = `const runner = resolveClaudeRunnerBin();\n${helper}\nspawnSync(runner, args);\n`;
    assert.deepStrictEqual(planted(source), ['commands/planted.js:3 runner']);
    assert.deepStrictEqual(planted(`const runner = resolveClaudeRunnerBin();\nfunction launch() {\n  const { runner } = tools;\n  ${helper}\n  spawnSync(runner, args);\n}\n`), [], 'a destructured local hides the outer engine');
    assert.deepStrictEqual(planted(`const runner = resolveClaudeRunnerBin();\nfunction launch() {\n  let runner;\n  ${helper}\n  spawnSync(runner, args);\n}\n`), [], 'an uninitialized local hides the outer engine');
    assert.deepStrictEqual(planted(`const runner = 'git';\n${helper}\nspawnSync(runner, args);\n`), []);
    assert.deepStrictEqual(planted(`function outer() {\n  const profile = resolveEngineProfile(engine);\n  ${helper}\n  const runner = profile.bin;\n  spawnSync(runner, args);\n}\n`), ['commands/planted.js:5 runner']);
  }
  assert.deepStrictEqual(planted("function helper() {\n  const runner = resolveClaudeRunnerBin();\n}\nspawnSync(runner, args);\n"), [], 'a closed helper does not supply its local runner');
  // Plain var declarations belong to the function even after a block closes.
  for (const body of [
    'if (ready) { var runner = resolveClaudeRunnerBin(); }',
    'if (ready) { var\trunner = resolveClaudeRunnerBin(); }',
    'for (var runner = resolveClaudeRunnerBin(); ready; ) { break; }',
    'try { var runner = resolveClaudeRunnerBin(); } finally { noop(); }',
  ]) {
    assert.deepStrictEqual(planted(`function launch() {\n  ${body}\n  spawnSync(runner, args);\n}\n`), ['commands/planted.js:3 runner']);
    assert.deepStrictEqual(planted(`function launch() {\n  ${body}\n  startEngineRun(root);\n  spawnSync(runner, args);\n}\n`), []);
  }
  assert.deepStrictEqual(planted("function launch() {\n  if (ready) { var profile = resolveEngineProfile(engine); }\n  const runner = profile.bin;\n  spawnSync(runner, args);\n}\n"), ['commands/planted.js:4 runner']);
  assert.deepStrictEqual(planted("function launch() {\n  if (ready) { var runner = 'git'; }\n  spawnSync(runner, args);\n}\n"), []);
  assert.deepStrictEqual(planted("function helper() {\n  if (ready) { var runner = resolveClaudeRunnerBin(); }\n}\nspawnSync(runner, args);\n"), [], 'function-scoped runners do not escape a helper');
  for (const callback of ['() =>', 'function ()']) {
    assert.deepStrictEqual(planted(`function launch() {\n  list.forEach(${callback} {\n    var runner = resolveClaudeRunnerBin();\n  });\n  spawnSync(runner, args);\n}\n`), [], 'a var runner does not escape an inline callback');
    assert.deepStrictEqual(planted(`function launch() {\n  list.forEach(${callback} {\n    if (ready) { var runner = resolveClaudeRunnerBin(); }\n    spawnSync(runner, args);\n  });\n}\n`), ['commands/planted.js:4 runner'], 'a var runner remains visible inside its callback');
  }
  assert.deepStrictEqual(planted("function outer() {\n  if (ready) { var runner = resolveClaudeRunnerBin(); }\n  function helper() {\n    spawnSync(runner, args);\n  }\n}\n"), ['commands/planted.js:4 runner'], 'nested helpers can capture a function-scoped runner');
  for (const helper of [
    'list.forEach(function (entry = current()) { var runner = resolveClaudeRunnerBin(); });',
    'const helpers = { run() { var runner = resolveClaudeRunnerBin(); } };',
  ]) {
    assert.deepStrictEqual(planted(`function launch() {\n  ${helper}\n  spawnSync(runner, args);\n}\n`), [], 'a runner stays inside a method or callback with default parameters');
  }
  // A program declared in a closed block does not supply a later launch.
  assert.deepStrictEqual(planted("function a() {\n  const program = resolveClaudeRunnerBin();\n  if (x) {\n    const program = 'git';\n  }\n  spawnSync(program, args);\n}\n"), ['commands/planted.js:6 program'], 'an inner plain program does not hide the outer engine');
  assert.deepStrictEqual(planted("function a() {\n  const program = 'git';\n  if (x) {\n    const program = resolveClaudeRunnerBin();\n  }\n  spawnSync(program, args);\n}\n"), [], 'an inner engine program does not reach a later launch');
  assert.deepStrictEqual(planted("function a() {\n  const program = 'git';\n  if (x) {\n    const program = resolveClaudeRunnerBin();\n    spawnSync(program, args);\n  }\n}\n"), ['commands/planted.js:5 program'], 'a program declared in the same block still supplies the launch');
  assert.deepStrictEqual(planted("function a() {\n  const runner = resolveClaudeRunnerBin();\n  list.forEach(() => { const runner = 'git'; });\n  const program = runner;\n  spawnSync(program, args);\n}\n"), ['commands/planted.js:5 program'], 'a chained alias skips a declaration in a closed callback');
  assert.deepStrictEqual(planted('const launch = function launch(runner) {\n  spawnSync(runner, args);\n};\nlaunch(resolveClaudeRunnerBin());\n'), ['commands/planted.js:2 runner'], 'matching expression and variable names keep external arguments visible');
  assert.deepStrictEqual(planted('const launch = function launch(runner) {\n  launch(resolveClaudeRunnerBin());\n  spawnSync(runner, args);\n};\n'), ['commands/planted.js:3 runner'], 'the defining assignment does not hide same-name recursion');
  // A variable declared in another function is not this launch's program.
  assert.deepStrictEqual(planted("function a() {\n  const command = buildEngineCommand(engine);\n}\nfunction b(command) {\n  spawnSync(command, { shell: true });\n}\n"), []);
  // A local wrapper that records the run covers the launch below it; a
  // comment naming the recorder does not.
  const wrapper = "function startTick(cwd) {\n  return startEngineRun(cwd, { engine: 'claude' });\n}\n";
  assert.deepStrictEqual(planted(`${wrapper}function a() {\n  const end = startTick(cwd);\n  spawn(resolveClaudeRunnerBin(), args);\n}\n`), []);
  assert.deepStrictEqual(planted(`${wrapper}function bare() {\n  spawn(resolveClaudeRunnerBin(), args);\n}\n`), ['commands/planted.js:5 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted(`${wrapper}spawn(resolveClaudeRunnerBin(), args);\n`), ['commands/planted.js:4 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted("const record = () => startEngineRun(root);\nspawn(resolveClaudeRunnerBin(), args);\n"), ['commands/planted.js:2 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted("const record = () =>\n  startEngineRun(root);\nspawn(resolveClaudeRunnerBin(), args);\n"), ['commands/planted.js:3 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted("function record() { startEngineRun(root); }\nspawn(resolveClaudeRunnerBin(), args);\n"), ['commands/planted.js:2 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted(`${wrapper}const bare = () => {\n  spawn(resolveClaudeRunnerBin(), args);\n};\n`), ['commands/planted.js:5 resolveClaudeRunnerBin()']);
  assert.deepStrictEqual(planted("function recordAndLaunch() {\n  startEngineRun(root);\n}\nfunction bare() {\n  const profile = resolveEngineProfile(engine);\n  const runner = profile.bin;\n  spawnSync(runner, args);\n}\n"), ['commands/planted.js:7 runner']);
  assert.deepStrictEqual(planted("function a() {\n  // startEngineRun(root)\n  spawn(resolveClaudeRunnerBin(), args);\n}\n"), ['commands/planted.js:3 resolveClaudeRunnerBin()']);
  // A nested helper's parameter can hide the expression's internal name.
  for (const name of ['worker', 'worker$']) {
    for (const helper of [
      `function helper(${name})`,
      `const helper = (${name}) =>`,
      `let helper = async ${name} =>`,
      `const helper = function nested(${name})`,
    ]) {
      const expression = (body) => `const launch = function ${name}(runner) {\n${body}\n  spawnSync(runner, args);\n};\n`;
      assert.deepStrictEqual(planted(expression(`  ${helper} {\n    ${name}(resolveClaudeRunnerBin());\n  }`)), [], 'a nested parameter hides the internal name');
      assert.deepStrictEqual(planted(expression(`  ${helper} {\n    const profile = resolveEngineProfile(engine);\n    ${name}(profile);\n  }`)), [], 'a profile argument to the hidden name belongs to the helper parameter');
      assert.deepStrictEqual(planted(expression(`  ${helper} {\n    ${name}(resolveClaudeRunnerBin());\n  }\n  ${name}(resolveClaudeRunnerBin());`)), ['commands/planted.js:6 runner'], 'a closed helper does not hide a later internal call');
      const captured = helper.replace(name, 'other');
      assert.deepStrictEqual(planted(expression(`  ${captured} {\n    ${name}(resolveClaudeRunnerBin());\n  }`)), ['commands/planted.js:5 runner'], 'a helper without a matching parameter captures the internal name');
    }
  }
  // An exemption covers its one named launch, not every launch in the
  // function that holds it.
  const exemptAsk = (body) => engineLaunches('lib/roster-prep.js', `function defaultPrepAskSync({ engine, prompt }) {\n  const invocation = buildReadOnlyEngineInvocation(engine, prompt);\n${body}\n}\n`).missing;
  assert.deepStrictEqual(exemptAsk('  spawnSync(invocation.bin, invocation.args);'), []);
  assert.deepStrictEqual(exemptAsk('  spawnSync(invocation.bin, invocation.args);\n  spawnSync(invocation.bin, invocation.args);'), ['lib/roster-prep.js:4 invocation.bin'], 'a second launch of the same program is not exempt');
  assert.deepStrictEqual(exemptAsk('  spawnSync(invocation.bin, invocation.args);\n  const runner = resolveClaudeRunnerBin();\n  spawnSync(runner, args);'), ['lib/roster-prep.js:5 runner'], 'a launch of another program is not exempt');
  assert.deepStrictEqual(exemptAsk('  startEngineRun(root);\n  spawnSync(invocation.bin, invocation.args);\n  spawnSync(invocation.bin, invocation.args);'), [], 'a recorded launch leaves the exemption for the next one');
  // A file with interactive sessions is still scanned, so a new launch
  // there beside its recorded one is caught.
  const consoleLaunch = 'function launchClaude(systemPrompt, extraArgs) {\n  const runnerBin = resolveClaudeRunnerBin();\n  const endResource = startEngineRun(root);\n  spawnSync(runnerBin, args);\n}\n';
  assert.deepStrictEqual(engineLaunches('commands/console.js', consoleLaunch).missing, []);
  assert.deepStrictEqual(engineLaunches('commands/console.js', `${consoleLaunch}function launchReview() {\n  spawnSync(resolveClaudeRunnerBin(), args);\n}\n`).missing, ['commands/console.js:7 resolveClaudeRunnerBin()']);
  // An exemption no launch used is stale, like one left behind when its
  // function was renamed.
  const staleExemptions = (used) => [...EXEMPT_LAUNCHES.keys()].filter((launch) => !used.includes(launch));
  const usedIn = (rel, text) => engineLaunches(rel, text).exempted;
  assert.deepStrictEqual(usedIn('lib/roster-prep.js', 'function defaultPrepAskSync({ engine, prompt }) {\n  const invocation = buildReadOnlyEngineInvocation(engine, prompt);\n  spawnSync(invocation.bin, invocation.args);\n}\n'), ['lib/roster-prep.js#defaultPrepAskSync invocation.bin']);
  const renamed = usedIn('lib/roster-prep.js', 'function prepAskSync({ engine, prompt }) {\n  const invocation = buildReadOnlyEngineInvocation(engine, prompt);\n  startEngineRun(root);\n  spawnSync(invocation.bin, invocation.args);\n}\n');
  assert.deepStrictEqual(staleExemptions(renamed), [...EXEMPT_LAUNCHES.keys()], 'a renamed function leaves its exemption unused');
  assert.deepStrictEqual(usedIn('lib/roster-prep.js', 'function defaultPrepAskSync({ engine, prompt }) {\n  const invocation = buildReadOnlyEngineInvocation(engine, prompt);\n  startEngineRun(root);\n  spawnSync(invocation.bin, invocation.args);\n}\n'), [], 'a recorded launch does not use its exemption');
  // Each launch is counted under the route that traced it, so a reader
  // that stops working shows up as a lower count.
  const routesOf = (text) => engineLaunches('commands/planted.js', text).routes;
  assert.deepStrictEqual(routesOf("function a() {\n  const runner = resolveClaudeRunnerBin();\n  spawnSync(runner, args);\n}\n"), { declaration: 1 });
  assert.deepStrictEqual(routesOf("function launch(program) {\n  spawnSync(program, args);\n}\nlaunch(resolveClaudeRunnerBin());\n"), { 'call argument': 1 });
  assert.deepStrictEqual(routesOf("function launch(runner = resolveClaudeRunnerBin()) {\n  spawnSync(runner, args);\n}\nlaunch();\n"), { 'parameter default': 1 });
  assert.deepStrictEqual(routesOf("function launch({ runner = resolveClaudeRunnerBin() }) {\n  spawnSync(runner, args);\n}\nlaunch({});\n"), { 'options key': 1 });
  assert.deepStrictEqual(routesOf("function launch(runner) {\n  spawnSync(runner, ['--help']);\n}\nlaunch(resolveClaudeRunnerBin());\n"), {}, 'a help probe is not counted');
  const repo = path.join(__dirname, '..');
  const missing = [];
  const routes = {};
  // Where each traced launch lives, by route, so a dropped count points at
  // the launch it lost.
  const tracedAt = {};
  const traced = [];
  const exempted = [];
  let seen = 0;
  for (const dir of ['commands', 'lib']) {
    for (const name of fs.readdirSync(path.join(repo, dir)).filter((file) => file.endsWith('.js'))) {
      const rel = `${dir}/${name}`;
      const result = engineLaunches(rel, fs.readFileSync(path.join(repo, rel), 'utf8'));
      seen += result.seen;
      missing.push(...result.missing);
      for (const [kind, count] of Object.entries(result.routes)) routes[kind] = (routes[kind] || 0) + count;
      for (const { route, at } of result.traced) (tracedAt[route] = tracedAt[route] || []).push(at);
      traced.push(...result.traced);
      exempted.push(...result.exempted);
    }
  }
  assert.deepStrictEqual(staleExemptions(exempted), [], 'an exempt launch was not found; remove its entry, or rename it to match the launch');
  // The known launches by file, function, and program, with the route that
  // traces each. Names, not line numbers, so ordinary edits keep matching
  // and a lost launch is named exactly.
  const KNOWN_TRACED = new Map([
    ['commands/autopilot.js#defaultCodexExecutor cmd', 'declaration'],
    ['commands/dream.js#defaultDreamRunner bin', 'declaration'],
    ['commands/mission.js#spawnClaudeTick resolveClaudeRunnerBin()', 'declaration'],
    ['commands/console.js#launchClaude runnerBin', 'declaration'],
    ['commands/orb.js#dispatch invocation.command', 'declaration'],
    ['commands/run.js#execPhaseCommandSync cmd', 'call argument'],
    ['commands/unknowns.js#runRunnerPrompt cmd', 'declaration'],
    ['commands/voice.js#runJudge claudePath', 'declaration'],
    ['lib/roster-prep.js#defaultPrepAskSync invocation.bin', 'declaration'],
  ]);
  const tracedRoute = new Map(traced.map(({ launch, route }) => [launch, route]));
  const lost = [...KNOWN_TRACED].filter(([launch, route]) => tracedRoute.get(launch) !== route)
    .map(([launch, route]) => `${launch} by ${route}, now ${tracedRoute.get(launch) || 'not traced'}`);
  assert.deepStrictEqual(lost, [], 'a known launch is no longer traced by its route; fix the reader, or update the list if the launch moved on purpose');
  assert.deepStrictEqual(missing, [], 'record the run with startEngineRun, or add the launch to the exempt list with its reason');
  console.log(`real runner and profile launch scan: ${seen} engine launches through a variable, ${missing.length} unrecorded`);
  console.log(`real runner and profile launch routes: ${JSON.stringify(routes)}`);
  for (const [kind, places] of Object.entries(tracedAt)) console.log(`  ${kind}: ${places.join(', ')}`);
  const added = [...tracedRoute.keys()].filter((launch) => !KNOWN_TRACED.has(launch));
  console.log(`real runner and profile launches beyond the known list: ${added.length ? added.join(', ') : 'none'}`);
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

test('run command phases record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync } = require('node:child_process');
  const { executePhase } = require('../commands/run');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-phase-resource-')));
  const before = process.cwd();
  const savedTemplate = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const phase = (template) => {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
    try {
      return { output: executePhase('do', { task: 'fixture' }, { timeout: 5000 }) };
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
    assert.equal(ok.output.trim(), 'done');
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'run do');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    const killEnd = lines[3];
    assert.equal(killEnd.signal, 'SIGKILL');
    assert.match(killEnd.cause, /^killed \((machine memory low|cause unknown)\)$/);
    assert.ok(killed.error.message.includes(killEnd.cause), killed.error.message);
    const failEnd = lines[5];
    assert.equal(failEnd.signal, undefined);
    assert.match(failEnd.error, /not found|No such file|exited with code 127/i);
    assert.ok(failed.output !== undefined || failed.error, 'the failed start must return or throw');
    console.log(`run phase readings: ${JSON.stringify([killEnd, failEnd])}`);
    console.log(`run kill message: ${killed.error.message}`);
  } finally {
    process.chdir(before);
    if (savedTemplate === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = savedTemplate;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compile builds record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync } = require('node:child_process');
  const { executeBuild, appendRecord } = require('../commands/compile');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compile-build-resource-')));
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const build = (cmdOverride) => {
    try {
      return { manifest: executeBuild(root, 'demo', { cmdOverride, timeout: 5000 }) };
    } catch (error) {
      return { error };
    }
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
    // The clean launch writes no runner, so the build itself refuses after it.
    const ok = build('true');
    const killed = build('sh -c "kill -KILL $$"');
    const failed = build(missing);
    assert.match(ok.error.message, /was not written/);
    assert.equal(killed.error.signal, 'SIGKILL');
    assert.ok(failed.error, 'a missing program must fail the build');
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'compile demo');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The thrown error names the cause, and stays the original error.
    assert.ok(killed.error.message.includes(lines[3].cause), killed.error.message);
    assert.equal(killed.error.status, null);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.error.message, /killed \(/);
    console.log(`compile build readings: ${JSON.stringify([lines[3], lines[5]])}`);

    // The real command prints the cause where the operator reads it.
    const cli = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'compile', 'build', 'demo'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: 'sh', ATRIS_RUNNER_COMMAND_TEMPLATE: 'sh -c "kill -KILL $$"' },
    });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /Error: Command failed: .*; killed \((machine memory low|cause unknown)\)/);
    console.log(`compile build CLI exit ${cli.status}: ${cli.stderr.trim().split('\n').pop()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknowns runner launches record paired readings on success, SIGKILL and startup failure', () => {
  const { runRunnerPrompt } = require('../commands/unknowns');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unknowns-resource-')));
  const saved = { bin: process.env.ATRIS_RUNNER_BIN, template: process.env.ATRIS_RUNNER_COMMAND_TEMPLATE };
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const launch = (template) => {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
    return runRunnerPrompt(root, 'fixture prompt');
  };
  try {
    process.env.ATRIS_RUNNER_BIN = 'sh';
    const ok = launch('echo done');
    const killed = launch('sh -c "kill -KILL $$"');
    const failed = launch(missing);
    assert.deepEqual(ok, { ok: true, output: 'done' });
    assert.equal(killed.ok, false);
    assert.equal(failed.ok, false);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'unknowns');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The reason the operator reads names the cause.
    assert.ok(killed.reason.includes(lines[3].cause), killed.reason);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.reason, /killed \(/);
    console.log(`unknowns readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`unknowns kill reason: ${killed.reason}`);
  } finally {
    for (const [key, name] of [['bin', 'ATRIS_RUNNER_BIN'], ['template', 'ATRIS_RUNNER_COMMAND_TEMPLATE']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staleness checks record paired readings on success, SIGKILL and startup failure', () => {
  const { askModel } = require('../commands/autopilot');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-resource-')));
  const saved = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const check = (template) => {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
    return askModel({ title: 'fixture task', age: 9 }, root);
  };
  try {
    const ok = check('echo YES still used');
    const killed = check('sh -c "kill -KILL $$"');
    const failed = check(missing);
    assert.deepEqual(ok, { fresh: true, reasoning: 'still used' });
    assert.equal(killed.fresh, false);
    assert.equal(failed.fresh, false);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'staleness check');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The skip reason written to the journal names the cause.
    assert.ok(killed.reasoning.includes(lines[3].cause), killed.reasoning);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.reasoning, /killed \(/);
    console.log(`staleness readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`staleness kill reason: ${killed.reasoning}`);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('horizon proposals record paired readings on success, SIGKILL and startup failure', async () => {
  const { execFileSync } = require('node:child_process');
  const { proposeCandidateHorizons } = require('../commands/autopilot');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-resource-')));
  const before = process.cwd();
  const saved = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const candidates = JSON.stringify([1, 2, 3].map((n) => ({ title: `Ship widget step ${n}`, confidence: 0.8, rationale: 'fixture' })));
  const propose = async (template) => {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
    try {
      return { result: await proposeCandidateHorizons(root) };
    } catch (error) {
      return { error };
    }
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    process.chdir(root);
    const ok = await propose(`printf '%s' '${candidates}'`);
    const killed = await propose('sh -c "kill -KILL $$"');
    const failed = await propose(missing);
    process.chdir(before);
    assert.equal(ok.error, undefined);
    assert.equal(ok.result.length, 3);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'horizon proposal');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    assert.ok(killed.error.message.includes(lines[3].cause), killed.error.message);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.error.message, /killed \(/);
    console.log(`horizon readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`horizon kill message: ${killed.error.message}`);
  } finally {
    process.chdir(before);
    if (saved === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autopilot names a failed horizon proposal instead of calling the workspace clean', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-idle-')));
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const tick = (template) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'autopilot', '--legacy', '--auto', '--dry-run', '--iterations=1'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: 'sh', ATRIS_RUNNER_COMMAND_TEMPLATE: template },
  });
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO\n\n## In Progress\n\n## Backlog\n\n## Completed\n');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    const killed = tick('sh -c "kill -KILL $$"');
    assert.equal(killed.status, 0, killed.stderr);
    assert.match(killed.stdout, /I could not ask the engine for new work: horizon-proposal phase killed by SIGKILL .*; killed \((machine memory low|cause unknown)\)/);
    assert.doesNotMatch(killed.stdout, /looks clean/);
    const failed = tick(missing);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, /I could not ask the engine for new work: Command failed: /);
    assert.doesNotMatch(failed.stdout, /looks clean|killed \(/);
    // An engine that answers with nothing usable still reads as no work.
    const empty = tick('echo none');
    assert.match(empty.stdout, /looks clean/);
    assert.doesNotMatch(empty.stdout, /could not ask the engine/);
    console.log(`autopilot idle on kill: ${killed.stdout.split('\n').find((line) => line.includes('could not ask')).trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan reviews record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync } = require('node:child_process');
  const { runPlanReview } = require('../commands/autopilot');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-resource-')));
  const saved = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const review = (template) => {
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
    try {
      return { result: runPlanReview({ cwd: root, context: { task: 'fixture', tags: [] }, planOutput: 'fixture plan' }) };
    } catch (error) {
      return { error };
    }
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    const ok = review('echo VERDICT: SIGNOFF');
    const killed = review('sh -c "kill -KILL $$"');
    const failed = review(missing);
    assert.equal(ok.error, undefined);
    assert.ok(ok.result.signers.includes('validator'));
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].task, 'autopilot plan review');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The thrown review error names the cause, and stays the original error.
    assert.ok(killed.error.message.includes(lines[3].cause), killed.error.message);
    assert.equal(killed.error.signal, 'SIGKILL');
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.error.message, /killed \(/);
    console.log(`plan review readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`plan review kill message: ${killed.error.message}`);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex plan review signers record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync } = require('node:child_process');
  const { runPlanReview } = require('../commands/autopilot');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-resource-')));
  const saved = { template: process.env.ATRIS_RUNNER_COMMAND_TEMPLATE, codex: process.env.ATRIS_CODEX_CMD };
  const script = (name, body) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const review = (codex) => {
    process.env.ATRIS_CODEX_CMD = codex;
    return runPlanReview({ cwd: root, context: { task: 'fixture', tags: ['codex'] }, planOutput: 'fixture plan', options: { hasCodex: true } });
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = 'echo VERDICT: SIGNOFF';
    const ok = review(script('codex-ok', 'echo VERDICT: SIGNOFF'));
    const killed = review(script('codex-killed', 'kill -KILL $$'));
    const failed = review(path.join(root, 'codex-missing'));
    assert.deepEqual(ok.signers, ['validator', 'codex']);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse)
      .filter((line) => line.task === 'autopilot codex review');
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'codex');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The fallback note the review carries names the cause.
    assert.ok(killed.notes.includes(lines[3].cause), killed.notes);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /ENOENT/);
    assert.doesNotMatch(failed.notes, /killed \(/);
    console.log(`codex review readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`codex review kill note: ${killed.notes}`);
  } finally {
    for (const [key, name] of [['template', 'ATRIS_RUNNER_COMMAND_TEMPLATE'], ['codex', 'ATRIS_CODEX_CMD']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine probes record paired readings on success, SIGKILL and startup failure', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-probe-resource-')));
  const bin = path.join(root, 'bin');
  const missing = path.join(os.tmpdir(), `atris-missing-engine-${process.pid}`);
  const probe = (template) => {
    const ran = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'engine', 'test', 'claude', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_COMMAND_TEMPLATE: template, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    return { status: ran.status, result: JSON.parse(ran.stdout).results[0], stderr: ran.stderr };
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    // A stand-in so the installed check passes; the template decides the run.
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho OK\n', { mode: 0o755 });
    const ok = probe('echo OK');
    const killed = probe('sh -c "kill -KILL $$"');
    const failed = probe(missing);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.result.pass, true);
    assert.equal(killed.status, 1);
    assert.equal(failed.status, 1);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'engine probe');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.notEqual(lines[0].run_id, lines[2].run_id);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The probe result the operator reads names the cause.
    assert.ok(killed.result.message.includes(lines[3].cause), killed.result.message);
    assert.equal(lines[5].signal, undefined);
    assert.match(lines[5].error, /not found|No such file/i);
    assert.doesNotMatch(failed.result.message, /killed \(/);
    console.log(`engine probe readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`engine probe kill message: ${killed.result.message}`);
  } finally {
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

test('a kill on a machine with more work than cores names the programs using the most CPU', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-busiest-'));
  const PS = [
    ' 120.5 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)',
    '  80.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)',
    ' 150.2 /usr/libexec/PerfPowerServices',
    '  45.0 node',
    '  10.0 git',
    '   0.0 launchd',
    'not a process line',
  ].join('\n');
  const psCalls = [];
  const run = (cmd, args) => {
    if (cmd === 'ps') { psCalls.push(args); return { status: 0, stdout: PS }; }
    return fakeRun(PRESSURE_OK, SWAP_OK)(cmd);
  };
  try {
    // Helpers of one app add up, paths drop to the program name, and idle
    // programs and junk lines are skipped.
    assert.deepStrictEqual(parseBusiest(PS), [
      { name: 'Google Chrome Helper (Renderer)', cpu: 201 },
      { name: 'PerfPowerServices', cpu: 150 },
      { name: 'node', cpu: 45 },
    ]);
    assert.deepStrictEqual(parseBusiest(''), []);

    const crowded = { platform: 'darwin', run, loadavg: () => [9, 8, 7], cores: 8 };
    const killed = recordEngineResource(root, { phase: 'end', engine: 'codex', task: 'T', run_id: 'r1', signal: 'SIGKILL', timed_out: true }, crowded);
    assert.deepStrictEqual(killed.busiest.map((p) => p.name), ['Google Chrome Helper (Renderer)', 'PerfPowerServices', 'node']);
    assert.strictEqual(killLoadText(killed, 8), ', load 9 on 8 cores, busiest Google Chrome Helper (Renderer) 201%, PerfPowerServices 150%, node 45%');
    const logged = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(logged[0].busiest, killed.busiest, 'the busiest programs are written to the run log');

    // At the core count, on a plain end, or with a list that cannot be read,
    // no process list is kept.
    const calm = recordEngineResource(root, { phase: 'end', run_id: 'r2', signal: 'SIGKILL', timed_out: true }, { ...crowded, cores: 9 });
    const ended = recordEngineResource(root, { phase: 'end', run_id: 'r3' }, crowded);
    const unread = recordEngineResource(root, { phase: 'end', run_id: 'r4', signal: 'SIGKILL' }, { ...crowded, run: (cmd) => (cmd === 'ps' ? { status: 1, stdout: '' } : run(cmd)) });
    assert.strictEqual(psCalls.length, 1, 'only the crowded kill read the process list');
    for (const entry of [calm, ended, unread]) assert.strictEqual(entry.busiest, undefined);
    assert.strictEqual(killLoadText(calm, 9), ', load 9 on 9 cores');
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
  const timeLimit = (at, task, extra = {}) => killed(at, task, 'killed (time limit reached)', 70, { timed_out: true, ...extra });
  const file = path.join(root, RESOURCE_LOG);
  const minute = (at) => `${at.slice(0, 16).replace('T', ' ')} UTC`;
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const firstTimeout = hoursAgo(4);
    // Load at the core count is not crowded; just above it is.
    const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
    fs.writeFileSync(file, [timeLimit(hoursAgo(5), 'SLOW1', { load: [cores, 1, 1] }), timeLimit(firstTimeout, 'SLOW2', { load: [cores + 0.25, 9, 8] }), ''].join('\n'));
    const onlyTimeouts = status();
    assert.strictEqual(onlyTimeouts.status, 0, onlyTimeouts.stderr);
    assert.ok(onlyTimeouts.stdout.includes(`engine runs force-killed in the last day: 2, all at their time limit (1 with load above the ${cores} cores); newest codex on SLOW2 at ${minute(firstTimeout)}, killed (time limit reached), 70% memory free, load ${cores + 0.25} on ${cores} cores`), onlyTimeouts.stdout);

    const crash = hoursAgo(3);
    fs.appendFileSync(file, [killed(crash, 'HEAVY', 'killed (machine memory low)', 5), timeLimit(hoursAgo(1), 'SLOW3'), ''].join('\n'));
    const mixed = status();
    assert.strictEqual(mixed.status, 0, mixed.stderr);
    assert.ok(mixed.stdout.includes(`engine runs force-killed in the last day: 4, 3 at their time limit (1 with load above the ${cores} cores), 1 with machine memory low; newest not at a time limit: codex on HEAVY at ${minute(crash)}, killed (machine memory low), 5% memory free`), mixed.stdout);
    assert.match(mixed.stdout, /killed \(machine memory low\), 5% memory free\n/, 'a kill with no load reading names no load');
    const history = readResourceHistory(root);
    assert.strictEqual(history.time_limit_kills_day, 3);
    assert.strictEqual(history.crowded_time_limit_kills_day, 1);
    assert.strictEqual(readResourceHistory(root, { cores: cores + 1 }).crowded_time_limit_kills_day, 0, 'a bigger machine would not have been crowded');
    assert.strictEqual(history.last_day_other_kill.task, 'HEAVY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status names the most engine runs open at a crowded time limit kill and says whether running fewer would help', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-crowded-peak-'));
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const status = () => spawnSync(process.execPath, [cli, 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const start = (at, id) => JSON.stringify({ at, phase: 'start', engine: 'codex', task: id, run_id: id });
  const end = (at, id) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, code: 0 });
  const timeLimit = (at, id, load, busiest) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, signal: 'SIGKILL', cause: 'killed (time limit reached)', timed_out: true, free_pct: 70, load: [load, 1, 1], ...(busiest ? { busiest } : {}) });
  const top = (...names) => names.map((name, i) => ({ name, cpu: 300 - i * 100 }));
  const file = path.join(root, RESOURCE_LOG);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Four runs open when the first crowded kill lands, then two when the
    // second does; the peak is four. The calm kill had three open.
    fs.writeFileSync(file, [
      start(hoursAgo(6), 'A'), start(hoursAgo(6), 'B'), start(hoursAgo(6), 'C'), start(hoursAgo(6), 'D'),
      timeLimit(hoursAgo(5), 'A', cores + 2, top('mds_stores', 'node')),
      end(hoursAgo(4.5), 'B'),
      timeLimit(hoursAgo(4), 'C', cores + 1, top('mds_stores', 'WindowServer')),
      start(hoursAgo(3), 'E'), start(hoursAgo(3), 'F'),
      timeLimit(hoursAgo(2), 'E', 1),
      '',
    ].join('\n'));
    const most = status();
    assert.strictEqual(most.status, 0, most.stderr);
    assert.ok(most.stdout.includes(`engine runs force-killed in the last day: 3, all at their time limit (2 with load above the ${cores} cores and up to 4 engine runs open, so run fewer at once, mds_stores using the most CPU at 2 of them);`), most.stdout);
    const history = readResourceHistory(root);
    assert.strictEqual(history.crowded_peak_open_runs, 4);
    assert.strictEqual(readResourceHistory(root, { cores: cores + 1 }).crowded_peak_open_runs, 4, 'the kill one above a bigger core count still counts');
    assert.strictEqual(readResourceHistory(root, { cores: cores + 2 }).crowded_peak_open_runs, 0, 'no crowded kill means no peak');
    assert.deepStrictEqual(history.crowded_top_busiest, { name: 'mds_stores', kills: 2 });
    assert.strictEqual(readResourceHistory(root, { cores: cores + 2 }).crowded_top_busiest, null, 'no crowded kill means no top program');

    // Two more calm timeouts leave the crowded ones a minority: the peak is
    // still named, but the advice to run fewer is not.
    fs.appendFileSync(file, [timeLimit(hoursAgo(1), 'F', 1), timeLimit(hoursAgo(0.5), 'D', 1), ''].join('\n'));
    const few = status();
    assert.strictEqual(few.status, 0, few.stderr);
    assert.ok(few.stdout.includes(`all at their time limit (2 with load above the ${cores} cores and up to 4 engine runs open, mds_stores using the most CPU at 2 of them);`), few.stdout);

    // A crowded kill with only the killed run open means the load came from
    // other work, so running fewer engines would not help.
    const busiest = [{ name: 'PerfPowerServices', cpu: 180 }, { name: 'node', cpu: 85 }];
    fs.writeFileSync(file, [start(hoursAgo(2), 'G'), JSON.stringify({ ...JSON.parse(timeLimit(hoursAgo(1), 'G', cores + 3)), busiest }), ''].join('\n'));
    const alone = status();
    assert.strictEqual(alone.status, 0, alone.stderr);
    assert.ok(alone.stdout.includes(`all at their time limit (1 with load above the ${cores} cores and no other engine run open, so the load came from other work);`), alone.stdout);
    assert.doesNotMatch(alone.stdout, /run fewer at once/);
    assert.doesNotMatch(alone.stdout, /using the most CPU at/, 'one crowded kill is not a repeat');

    // Two programs on top at two kills each out of four is no majority, so
    // neither is named; the first to reach two is still the one kept.
    fs.writeFileSync(file, [
      timeLimit(hoursAgo(4), 'H', cores + 1, top('Xcode')), timeLimit(hoursAgo(3), 'I', cores + 1, top('Docker')),
      timeLimit(hoursAgo(2), 'J', cores + 1, top('Xcode')), timeLimit(hoursAgo(1), 'K', cores + 1, top('Docker')),
      '',
    ].join('\n'));
    const split = status();
    assert.strictEqual(split.status, 0, split.stderr);
    assert.ok(split.stdout.includes(`all at their time limit (4 with load above the ${cores} cores);`), split.stdout);
    assert.deepStrictEqual(readResourceHistory(root).crowded_top_busiest, { name: 'Xcode', kills: 2 });
    assert.ok(alone.stdout.includes(`load ${cores + 3} on ${cores} cores, busiest PerfPowerServices 180%, node 85%\n`), 'the status names what was using the CPU');
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
  const now = Date.now();
  const hoursAgo = (hours) => new Date(now - hours * 3600000).toISOString();
  const shown = (at) => at.slice(0, 16).replace('T', ' ') + ' UTC';
  const crashAt = hoursAgo(3);
  const firstLimitAt = hoursAgo(2);
  const lastLimitAt = hoursAgo(1);
  const timeLimit = (at, task, extra = {}) => JSON.stringify({ at, phase: 'end', engine: 'codex', task, run_id: task, free_pct: 70, signal: 'SIGKILL', timed_out: true, cause: 'killed (time limit reached)', ...extra });
  fs.writeFileSync(file, [
    JSON.stringify({ at: crashAt, phase: 'end', engine: 'claude', task: 'CLI-2', run_id: 'crash', free_pct: 9, signal: 'SIGKILL', cause: 'killed (machine memory low)' }),
    timeLimit(firstLimitAt, 'SLOW1'),
    timeLimit(lastLimitAt, 'SLOW2', { load: [14.25, 9, 8] }),
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
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  assert.ok(text.split('\n').includes(`last SIGKILL: codex on SLOW2 at ${shown(lastLimitAt)}, killed (time limit reached), 70% memory free, load 14.25 on ${cores} cores`), text);
  assert.ok(text.split('\n').includes(`last SIGKILL not at a time limit: claude on CLI-2 at ${shown(crashAt)}, killed (machine memory low), 9% memory free`), 'a kill with no load reading names no load');
  assert.match(text, /1 of 3 SIGKILLs ended with machine memory low, 2 at their time limit/);
});

test('atris engine sweep names the day\'s crowded time limit kills in the same words as the landing status', () => {
  const { spawnSync } = require('node:child_process');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-crowded-'));
  const file = path.join(root, RESOURCE_LOG);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const start = (at, id) => JSON.stringify({ at, phase: 'start', engine: 'codex', task: id, run_id: id });
  const busiest = [{ name: 'mds_stores', cpu: 300 }, { name: 'node', cpu: 90 }];
  const timeLimit = (at, id, load, extra = {}) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, free_pct: 70, signal: 'SIGKILL', timed_out: true, cause: 'killed (time limit reached)', load: [load, 1, 1], ...extra });
  const sweep = (args = []) => {
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      engineCommand(['sweep', ...args], { root, engineSweep: { read: () => ({ agents: [], referenced: new Set() }), uid: 501 } });
    } finally {
      console.log = original;
    }
    return out.join('\n').split('\n');
  };
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [timeLimit(hoursAgo(3), 'CALM', 1), ''].join('\n'));
    assert.ok(!sweep().some((line) => line.startsWith('time limit kills in the last day')), 'no crowded kill, no line');

    fs.writeFileSync(file, [
      start(hoursAgo(5), 'A'), timeLimit(hoursAgo(4), 'A', cores + 2, { busiest }),
      start(hoursAgo(3), 'B'), timeLimit(hoursAgo(2), 'B', cores + 1, { busiest }),
      timeLimit(hoursAgo(1), 'C', 1),
      // Four old runs overlap, but their crowded kills cannot raise today's peak.
      ...['OLD', 'OLD-31', 'OLD-32', 'OLD-33'].map((id) => start(hoursAgo(36), id)),
      timeLimit(hoursAgo(30), 'OLD', cores + 5, { busiest }),
      ...[31, 32, 33].map((h) => timeLimit(hoursAgo(h), `OLD-${h}`, cores + 5, { busiest: [{ name: 'Xcode', cpu: 400 }] })),
      '',
    ].join('\n'));
    const crowdedText = `2 with load above the ${cores} cores and no other engine run open, so the load came from other work, mds_stores using the most CPU at 2 of them`;
    const lines = sweep();
    assert.ok(lines.includes(`time limit kills in the last day: 3 (${crowdedText})`), lines.join('\n'));
    assert.ok(lines.includes('0 of 7 SIGKILLs ended with machine memory low, 7 at their time limit'), lines.join('\n'));

    const { history } = JSON.parse(sweep(['--json']).join('\n'));
    assert.deepStrictEqual([history.time_limit_kills_day, history.time_limit_kills, history.crowded_time_limit_kills_day], [3, 7, 2], 'the older crowded kills stay out of the recent counts');
    assert.strictEqual(history.crowded_peak_open_runs, 1, 'older overlapping crowded kills do not inflate the recent peak');
    assert.deepStrictEqual(history.crowded_top_busiest, { name: 'mds_stores', kills: 2 }, 'older kills neither inflate the recent count nor replace its leader with a more frequent old program');
    console.log(`real sweep json totals: ${JSON.stringify({ recent: history.time_limit_kills_day, overall: history.time_limit_kills, peak: history.crowded_peak_open_runs, busiest: history.crowded_top_busiest })}`);
    const status = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'autoland', 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.strictEqual(status.status, 0, status.stderr);
    assert.ok(status.stdout.includes(`engine runs force-killed in the last day: 3, all at their time limit (${crowdedText});`), status.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a run started over a day ago and still open at a recent crowded kill counts toward its peak', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-old-open-peak-'));
  const file = path.join(root, RESOURCE_LOG);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const start = (at, id) => JSON.stringify({ at, phase: 'start', engine: 'codex', task: id, run_id: id });
  const end = (at, id) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, code: 0 });
  const timeLimit = (at, id, load) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, signal: 'SIGKILL', cause: 'killed (time limit reached)', timed_out: true, free_pct: 70, load: [load, 1, 1] });
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // LONG starts 30 hours ago and is still open when A is killed; SHORT
    // started with it but ended before A began, so it stays out of the peak.
    fs.writeFileSync(file, [
      start(hoursAgo(30), 'LONG'), start(hoursAgo(30), 'SHORT'), end(hoursAgo(28), 'SHORT'),
      start(hoursAgo(5), 'A'), timeLimit(hoursAgo(4), 'A', cores + 2),
      end(hoursAgo(3), 'LONG'),
      '',
    ].join('\n'));
    const history = readResourceHistory(root);
    assert.deepStrictEqual([history.crowded_time_limit_kills_day, history.crowded_peak_open_runs], [1, 2], 'the old open run and the killed run make a peak of two');
    console.log(`real old open peak: ${JSON.stringify({ crowded: history.crowded_time_limit_kills_day, peak: history.crowded_peak_open_runs })}`);
    const status = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'autoland', 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
    });
    assert.strictEqual(status.status, 0, status.stderr);
    assert.ok(status.stdout.includes(`engine runs force-killed in the last day: 1, all at their time limit (1 with load above the ${cores} cores and up to 2 engine runs open, so run fewer at once);`), status.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a crowded kill whose start fell before the read part of a big log still counts itself beside other open runs', () => {
  const { spawnSync } = require('node:child_process');
  const { MAX_LOG_BYTES } = require('../lib/engine-resource');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-cut-start-peak-'));
  const file = path.join(root, RESOURCE_LOG);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const start = (at, id) => JSON.stringify({ at, phase: 'start', engine: 'codex', task: id, run_id: id });
  const end = (at, id) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, code: 0 });
  const timeLimit = (at, id) => JSON.stringify({ at, phase: 'end', engine: 'codex', task: id, run_id: id, signal: 'SIGKILL', cause: 'killed (time limit reached)', timed_out: true, free_pct: 70, load: [cores + 2, 1, 1] });
  const status = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'autoland', 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  // A pad line the size of the read part pushes LOST's start out of it.
  const pad = 'x'.repeat(MAX_LOG_BYTES);
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [start(hoursAgo(6), 'LOST'), pad, start(hoursAgo(5), 'B'), timeLimit(hoursAgo(4), 'LOST'), end(hoursAgo(3), 'B'), ''].join('\n'));
    const history = readResourceHistory(root);
    assert.deepStrictEqual([history.crowded_time_limit_kills_day, history.crowded_peak_open_runs], [1, 2], 'B and the killed run make two even without the killed run\'s start');
    console.log(`real cut start peak: ${JSON.stringify({ crowded: history.crowded_time_limit_kills_day, peak: history.crowded_peak_open_runs })}`);
    const beside = status();
    assert.strictEqual(beside.status, 0, beside.stderr);
    assert.ok(beside.stdout.includes(`all at their time limit (1 with load above the ${cores} cores and up to 2 engine runs open, so run fewer at once);`), beside.stdout);

    // Alone, the count is unknown, so the status does not claim the load
    // came from other work.
    fs.writeFileSync(file, [start(hoursAgo(6), 'LOST'), pad, timeLimit(hoursAgo(4), 'LOST'), ''].join('\n'));
    assert.strictEqual(readResourceHistory(root).crowded_peak_open_runs, 0);
    const alone = status();
    assert.strictEqual(alone.status, 0, alone.stderr);
    assert.ok(alone.stdout.includes(`all at their time limit (1 with load above the ${cores} cores);`), alone.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status counts leaked ssh-agents, says how they get stopped, and stays quiet with none or a failed read', () => {
  const { showStatus, HOURLY_SSH_AGENT_STOP_LIMIT } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agents-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const status = (deps) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], deps && { atrisCommand: 'atris', ...deps });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const leaked = status({ readSshAgents: () => ({ agents: [agent(200), agent(201), agent(202)], referenced: new Set([202]) }), uid: 501 });
    assert.match(leaked, /leaked ssh-agents on this machine: 2; stop them now: atris engine sweep --apply/);
    const elsewhere = status({ readSshAgents: () => ({ agents: [agent(200)], referenced: new Set() }), uid: 501, atrisCommand: 'node ~/checkout/bin/atris.js' });
    assert.match(elsewhere, /stop them now: node ~\/checkout\/bin\/atris\.js engine sweep --apply/, 'the stop command names the checkout when the atris on PATH is another install');
    // A live hourly pass stops them only when its receipt shows a sweep ran.
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const tick = (name, receipt) => fs.writeFileSync(path.join(runsDir, `autoland-tick-${name}.json`), JSON.stringify(receipt));
    const leakedNow = () => status({ readSshAgents: () => ({ agents: [agent(200)], referenced: new Set() }), uid: 501 });
    tick('2026-10-14T01', { at: '2026-10-14T01:00:00Z' });
    assert.match(leakedNow(), /leaked ssh-agents on this machine: 1; the hourly pass runs a version without the ssh-agent cleanup, so stop them now: atris engine sweep --apply/);
    tick('2026-10-14T02', { at: '2026-10-14T02:00:00Z', ssh_agent_sweep: { stopped: [], failed: [], skipped: [] } });
    assert.match(leakedNow(), /leaked ssh-agents on this machine: 1; the next hourly pass stops them/);
    tick('2026-10-14T03', { at: '2026-10-14T03:00:00Z', ssh_agent_sweep_error: 'ps failed' });
    assert.match(leakedNow(), /the next hourly pass stops them/, 'a pass that tried and failed still has the cleanup');
    const pile = Array.from({ length: HOURLY_SSH_AGENT_STOP_LIMIT + 1 }, (_, i) => agent(1000 + i));
    assert.match(status({ readSshAgents: () => ({ agents: pile, referenced: new Set() }), uid: 501 }), new RegExp(`leaked ssh-agents on this machine: ${HOURLY_SSH_AGENT_STOP_LIMIT + 1}; the next hourly pass stops only the oldest ${HOURLY_SSH_AGENT_STOP_LIMIT}, so stop the rest now: atris engine sweep --apply`));
    fs.rmSync(runsDir, { recursive: true, force: true });
    const none = status({ readSshAgents: () => ({ agents: [agent(300)], referenced: new Set([300]) }), uid: 501 });
    assert.doesNotMatch(none, /ssh-agents/);
    const broken = status({ readSshAgents: () => { throw new Error('ps missing'); }, uid: 501 });
    assert.doesNotMatch(broken, /ssh-agents/);
    assert.doesNotMatch(status(), /ssh-agents/, 'a test run never reads the real machine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status names an unreadable agent scan instead of showing no leaks', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agents-unread-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const status = (deps) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], deps && { atrisCommand: 'atris', ...deps });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const blind = status({ readSshAgents: () => ({ agents: [], referenced: new Set(), unread: ['process list'] }), uid: 501 });
    assert.match(blind, /leaked ssh-agents on this machine: unknown, could not read the process list, so some ssh-agents went unchecked/);
    const partial = status({ readSshAgents: () => ({ agents: [agent(200), agent(201)], referenced: new Set([201]), unread: ['agent sockets'] }), uid: 501 });
    assert.match(partial, /leaked ssh-agents on this machine: at least 1; stop them now: atris engine sweep --apply; could not read the agent sockets, so some ssh-agents went unchecked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the fix command names this checkout when the atris on PATH is another install', () => {
  const { atrisCommand, fixStartupHint } = require('../lib/engine-resource');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-atris-command-')));
  try {
    const bin = path.join(tmp, 'checkout', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'atris'), '', { mode: 0o755 });
    const linked = path.join(tmp, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(bin, 'atris'), path.join(linked, 'atris'));
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'atris'), '', { mode: 0o755 });
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const script = path.join(bin, 'atris.js'); fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris.js'), script);
    assert.strictEqual(atrisCommand({ pathEnv: [empty, linked, other, path.dirname(process.execPath)].join(path.delimiter), binDir: bin, home: '' }), 'atris', 'the atris on PATH links to this checkout');
    assert.strictEqual(atrisCommand({ pathEnv: [other, linked].join(path.delimiter), binDir: bin, home: '' }), `${process.execPath} ${script}`, 'an older install found first is not the one that has the sweep');
    assert.strictEqual(atrisCommand({ pathEnv: empty, binDir: bin, home: '' }), `${process.execPath} ${script}`, 'no atris on PATH');
    assert.strictEqual(atrisCommand({ pathEnv: empty, binDir: bin, home: tmp }), `${process.execPath} ~/checkout/bin/atris.js`, 'a path under home is shortened');
    const spaced = path.join(tmp, 'my checkout', 'bin');
    fs.mkdirSync(spaced, { recursive: true });
    assert.strictEqual(atrisCommand({ pathEnv: empty, binDir: spaced, home: tmp }), `${process.execPath} '${path.join(spaced, 'atris.js')}'`, 'a path with a space is quoted in full');
    const { pathAtrisRecordsRuns } = require('../lib/engine-resource');
    assert.strictEqual(pathAtrisRecordsRuns({ pathEnv: other }), false, 'an install with no run recording file');
    assert.strictEqual(pathAtrisRecordsRuns({ pathEnv: empty }), true, 'no atris on PATH, nothing to warn about');
    fs.mkdirSync(path.join(tmp, 'checkout', 'lib'));
    fs.writeFileSync(path.join(tmp, 'checkout', 'lib', 'engine-resource.js'), '');
    assert.strictEqual(pathAtrisRecordsRuns({ pathEnv: linked }), true, 'a linked checkout that records runs');
    assert.strictEqual(fixStartupHint(`node ${script}`), `to make that change, run node ${script} engine sweep --fix-startup; it saves the old file beside it first`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the landing status names the startup line behind leaked ssh-agents and its fix', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agent-source-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-agent-home-'));
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
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    const leaked = status({ readSshAgents: () => ({ agents: [agent(200)], referenced: new Set() }), uid: 501, home, atrisCommand: 'atris' });
    assert.match(leaked, /leaked ssh-agents on this machine: 1;[^\n]*\n {4}likely source: ~\/\.zshrc line 1 starts a new ssh-agent in every shell that reads it, including the shells Claude and Codex start in each session that runs a command; to start one only when none is reachable, change it to: \[ -S "\$SSH_AUTH_SOCK" \] \|\| eval "\$\(ssh-agent -s\)"/);
    assert.match(leaked, /\n {4}to make that change, run atris engine sweep --fix-startup; it saves the old file beside it first/, 'the one-step fix is named under its line');
    const clean = status({ readSshAgents: () => ({ agents: [agent(200)], referenced: new Set([200]) }), uid: 501, home });
    assert.doesNotMatch(clean, /likely source/, 'no leak, no source line');
    assert.doesNotMatch(clean, /--fix-startup/, 'no leak, no fix command');
    fs.writeFileSync(path.join(home, '.zshrc'), 'if true; then eval "$(ssh-agent -s)"; fi\n');
    const handEdit = status({ readSshAgents: () => ({ agents: [agent(200)], referenced: new Set() }), uid: 501, home });
    assert.match(handEdit, /likely source: ~\/\.zshrc line 1/);
    assert.doesNotMatch(handEdit, /--fix-startup/, 'a line the command would leave alone does not point to it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
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

test('prep passes record paired readings and name the cause of a SIGKILL', async () => {
  const { spawnSync } = require('node:child_process');
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const { runPrepPass, runPrepPassSync } = require('../lib/roster-prep');
  const keys = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN',
    'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'PATH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prep-resource-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-resource-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-resource-bin-'));
  const engine = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const task = { id: 'CLI-1', title: 'build the widget' };
  const pass = { prepJob: 'search', forJob: 'build', task, root, worktreePath: root };
  try {
    spawnSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## search\n- claude, model: haiku\n\n## build\n- cursor, prep: search\n');
    for (const key of keys) if (key !== 'PATH') delete process.env[key];
    process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
    process.env.ATRIS_ROUTER_EXPLAIN = '0';
    process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
    readEngineRegistry(root);
    for (const name of ['cursor', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
    engine('echo "read lib/widget.js first"');
    const ok = runPrepPassSync(pass);
    engine('kill -KILL $$');
    const killed = runPrepPassSync(pass);
    const killedAsync = await runPrepPass(pass);
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(killed.ok, false);
    assert.equal(killedAsync.ok, false);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'prep for build');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    for (const [line, result] of [[lines[3], killed], [lines[5], killedAsync]]) {
      assert.equal(line.signal, 'SIGKILL');
      assert.match(line.cause, /^killed \((machine memory low|cause unknown)\)$/);
      // The reason the prep pass hands back, and the run record keeps, names the cause.
      assert.ok(result.reason.includes(line.cause), result.reason);
    }
    console.log(`prep readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`prep kill reasons: ${killed.reason} | ${killedAsync.reason}`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dream launches record paired readings and name the cause of a SIGKILL', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dream-resource-')));
  const bin = path.join(root, 'bin');
  const dream = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'dream', '--yes'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const engine = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    fs.mkdirSync(path.join(root, 'atris', 'logs', '2099'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'logs', '2099', '2099-01-01.md'), '# Log 2099-01-01\n\n## Completed\n\n- shipped a loop\n');
    fs.mkdirSync(bin);
    const cards = JSON.stringify([
      { title: 'Check open wishes', why: 'A wish needs a next step.', move: 'Answer the waiting wish.' },
      { title: 'Review mission proof', why: 'A proof is ready.', move: 'Read the latest receipt.' },
    ]);
    engine(`cat <<'CARDS'\n${cards}\nCARDS`);
    const ok = dream();
    engine('kill -KILL $$');
    const killed = dream();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Dreamed 2 cards/);
    assert.equal(killed.status, 0, killed.stderr);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    // One launch for the clean dream; the killed dream tries each model once.
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'dream');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    for (const line of [lines[3], lines[5]]) {
      assert.equal(line.signal, 'SIGKILL');
      assert.match(line.cause, /^killed \((machine memory low|cause unknown)\)$/);
    }
    // The line the operator reads names the cause.
    assert.ok(killed.stdout.includes(lines[5].cause), killed.stdout);
    console.log(`dream readings: ${JSON.stringify([lines[3], lines[5]])}`);
    console.log(`dream kill line: ${killed.stdout.split('\n')[0]}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asks with their own launcher, like link and the dispatch scout, record paired readings', async () => {
  const { linkCommand } = require('../commands/link');
  const keys = ['ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'PATH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-resource-')));
  const bin = path.join(root, 'bin');
  const engine = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const report = { jobs: [{ job: 'build', engine: 'claude' }], team: [] };
  const quiet = { log: console.log, error: console.error };
  const link = async () => {
    console.log = () => {};
    console.error = () => {};
    try {
      return await linkCommand(['a sled', 'a dog', '--json'], { root, rosterReport: () => report, timeoutMs: 30000 });
    } finally {
      console.log = quiet.log;
      console.error = quiet.error;
    }
  };
  try {
    fs.mkdirSync(bin);
    for (const key of keys) if (key !== 'PATH') delete process.env[key];
    process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
    engine('echo "{}"');
    await link();
    engine('kill -KILL $$');
    await link();
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'ask link');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    console.log(`link readings: ${JSON.stringify(lines[3])}`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed ask prints the cause from its end reading in link and engine ask', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cause-')));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_MACHINE_ROSTER_PATH: path.join(home, '.atris', 'roster.json'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE']) delete env[key];
  const atris = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env });
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## build\n- claude\n');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nkill -KILL $$\n', { mode: 0o755 });
    const link = atris('link', 'a sled', 'a dog');
    const ask = atris('engine', 'ask', '--engine', 'claude', 'say hi');
    const ends = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse).filter((line) => line.phase === 'end');
    assert.equal(ends.length, 2);
    for (const end of ends) {
      assert.equal(end.signal, 'SIGKILL');
      assert.match(end.cause, /^killed \((machine memory low|cause unknown)\)$/);
    }
    assert.equal(link.status, 1);
    assert.ok(link.stderr.includes(`stopped by SIGKILL; ${ends[0].cause}`), link.stderr);
    assert.ok(`${ask.stdout}${ask.stderr}`.includes(`stopped by SIGKILL; ${ends[1].cause}`), `${ask.stdout}${ask.stderr}`);
    console.log(`link line: ${link.stderr.trim()}`);
    console.log(`ask lines: ${`${ask.stdout}${ask.stderr}`.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the write coach records paired readings and names the cause of a SIGKILL', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'write-resource-')));
  const bin = path.join(root, 'bin');
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const atris = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env });
  // Answers the installed check, then runs the given body for the coach prompt.
  const engine = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0; exit 0; }\n${body}\n`, { mode: 0o755 });
  try {
    fs.mkdirSync(bin);
    engine('exit 0');
    const started = atris('write', 'start', 'why sleds need dogs');
    assert.equal(started.status, 0, started.stderr);
    engine('printf "QUESTION: what does the dog want?\\nLESSON: start with the dog\\n"');
    const ok = atris('write', 'coach');
    engine('kill -KILL $$');
    const killed = atris('write', 'coach');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /QUESTION: what does the dog want/);
    assert.equal(killed.status, 0, killed.stderr);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'write coach');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The fallback line the writer reads names the cause.
    assert.ok(killed.stdout.includes(lines[3].cause), killed.stdout);
    console.log(`write readings: ${JSON.stringify(lines[3])}`);
    console.log(`write fallback line: ${killed.stdout.split('\n').find((line) => line.includes('coach')) || ''}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the youtube digest records paired readings and names the cause of a SIGKILL', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-resource-')));
  const bin = path.join(root, 'bin');
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const digest = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'youtube', 'digest'], { cwd: root, encoding: 'utf8', timeout: 60000, env });
  const engine = (body) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'atris', 'wiki', 'briefs'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(root, 'atris', 'wiki', 'briefs', 'youtube-abc.md'), `source: https://www.youtube.com/watch?v=abc\ndate: ${today}\n\n# sleds and dogs\n\nthe dog sets the pace.\n`);
    engine('echo "# what this week\'s videos changed"; echo "- the dog sets the pace (atris/wiki/briefs/youtube-abc.md)"');
    const ok = digest();
    engine('kill -KILL $$');
    const killed = digest();
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /digest filed/);
    assert.equal(killed.status, 1, `${killed.stdout}${killed.stderr}`);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'youtube digest');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // A kill used to read as an engine that returned no text.
    assert.ok(killed.stdout.includes(`digest engine stopped by SIGKILL; ${lines[3].cause}`), killed.stdout);
    console.log(`digest readings: ${JSON.stringify(lines[3])}`);
    console.log(`digest kill line: ${killed.stdout.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('youtube notes record paired readings around their writer and name the cause of a SIGKILL', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-resource-')));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  const exec = (file, lines) => fs.writeFileSync(path.join(bin, file), `${lines.join('\n')}\n`, { mode: 0o755 });
  const d = new Date();
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const notes = () => spawnSync(path.join(__dirname, '..', 'scripts', 'det', 'ytnotes'), ['https://www.youtube.com/watch?v=sled123'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_YTNOTES_ENGINE: 'haiku', ATRIS_YTNOTES_ROSTER: '0', TMPDIR: work, PATH: `${bin}:${process.env.PATH || '/usr/bin'}` },
  });
  try {
    for (const dir of [bin, work, path.join(root, 'atris')]) fs.mkdirSync(dir);
    // A stand-in caption tool: one caption line, no network.
    exec('yt-dlp', [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${today}"; exit 0; fi`,
      'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The dog sets the pace." > yt_sled123.en.vtt',
      'printf "%s\\n" "sled123|Sled Dogs|Trail|0:02"',
    ]);
    exec('claude', ['#!/bin/sh', 'printf "%s\\n" "# Sled Dogs" "" "The dog sets the pace."']);
    const ok = notes();
    exec('claude', ['#!/bin/sh', 'kill -KILL $$']);
    const killed = notes();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(killed.status, 3, killed.stderr);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.phase), ['start', 'end', 'start', 'end']);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].run_id, /^[0-9a-f-]{36}$/);
      assert.equal(lines[i + 1].run_id, lines[i].run_id);
      assert.equal(lines[i].engine, 'claude');
      assert.equal(lines[i].task, 'youtube notes');
      assert.ok(Array.isArray(lines[i + 1].load));
      assert.ok(Number.isInteger(lines[i + 1].duration_ms));
    }
    // The start names the notes script, which lives for the whole run, not the
    // short helper that wrote it, so a sweep never closes a run still going.
    assert.equal(lines[0].pid, ok.pid);
    assert.equal(lines[2].pid, killed.pid);
    assert.equal(lines[1].signal, undefined);
    assert.equal(lines[1].error, undefined);
    assert.equal(lines[3].signal, 'SIGKILL');
    assert.match(lines[3].cause, /^killed \((machine memory low|cause unknown)\)$/);
    // The notes script says which writer was killed and why, before its no-notes line.
    assert.ok(killed.stderr.includes(`claude stopped by SIGKILL; ${lines[3].cause}`), killed.stderr);
    console.log(`ytnotes readings: ${JSON.stringify(lines[3])}`);
    console.log(`ytnotes kill line: ${killed.stderr.split('\n').find((line) => line.includes('SIGKILL')) || ''}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('youtube notes in auto mode show a killed writer\'s cause on screen before the fallback line', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-auto-')));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  const exec = (file, lines) => fs.writeFileSync(path.join(bin, file), `${lines.join('\n')}\n`, { mode: 0o755 });
  const d = new Date();
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  try {
    for (const dir of [bin, work, path.join(root, 'atris')]) fs.mkdirSync(dir);
    exec('yt-dlp', [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${today}"; exit 0; fi`,
      'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The dog sets the pace." > yt_sled123.en.vtt',
      'printf "%s\\n" "sled123|Sled Dogs|Trail|0:02"',
    ]);
    exec('claude', ['#!/bin/sh', 'kill -KILL $$']);
    exec('codex', ['#!/bin/sh', 'printf "%s\\n" "# Sled Dogs" "" "The dog sets the pace."']);
    // Only the stand-in writers are on the path, so no real writer is launched.
    const ran = spawnSync(path.join(__dirname, '..', 'scripts', 'det', 'ytnotes'), ['https://www.youtube.com/watch?v=sled123'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ATRIS_YTNOTES_ENGINE: 'auto', ATRIS_YTNOTES_ROSTER: '0', TMPDIR: work, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const lines = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    const killed = lines.find((line) => line.phase === 'end' && line.engine === 'claude');
    assert.equal(killed.signal, 'SIGKILL');
    const screen = ran.stderr.split('\n');
    const fallback = screen.indexOf('Haiku did not answer; writing the notes with Codex instead.');
    assert.ok(fallback > 0, ran.stderr);
    assert.equal(screen[fallback - 1], `claude stopped by SIGKILL; ${killed.cause}`);
    assert.ok(screen.includes('notes by Codex'), ran.stderr);
    console.log(`ytnotes auto screen: ${screen.slice(fallback - 1, fallback + 1).join(' | ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('youtube notes run outside an Atris workspace write no readings', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-plain-')));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  const exec = (file, lines) => fs.writeFileSync(path.join(bin, file), `${lines.join('\n')}\n`, { mode: 0o755 });
  const d = new Date();
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  try {
    for (const dir of [bin, work]) fs.mkdirSync(dir);
    exec('yt-dlp', [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${today}"; exit 0; fi`,
      'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The dog sets the pace." > yt_sled123.en.vtt',
      'printf "%s\\n" "sled123|Sled Dogs|Trail|0:02"',
    ]);
    exec('claude', ['#!/bin/sh', 'printf "%s\\n" "# Sled Dogs" "" "The dog sets the pace."']);
    const ran = spawnSync(path.join(__dirname, '..', 'scripts', 'det', 'ytnotes'), ['https://www.youtube.com/watch?v=sled123'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ATRIS_YTNOTES_ENGINE: 'haiku', ATRIS_YTNOTES_ROSTER: '0', TMPDIR: work, PATH: `${bin}:${process.env.PATH || '/usr/bin'}` },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable process list is reported instead of a clean agent count', () => {
  for (const failure of [() => ({ status: 1, stdout: '' }), () => { throw new Error('process scan timed out'); }]) {
    const scan = readSshAgents({ run: (cmd, args) => {
      if (cmd === 'ps' && !args.includes('-E')) return failure();
      if (cmd === 'ps') return { status: 0, stdout: '  300 SHELL=/bin/zsh' };
      return { status: 1, stdout: '' };
    } });
    assert.deepStrictEqual(scan.unread, ['process list']);
    assert.deepStrictEqual(scan.agents, []);
  }
});

test('the real sweep warns when the system cannot provide its process list', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('node:child_process');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-no-ps-'));
  try {
    const ran = spawnSync('/usr/bin/sandbox-exec', [
      '-p', '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))',
      process.execPath, path.join(__dirname, '..', 'bin', 'atris.js'), 'engine', 'sweep',
    ], { cwd, encoding: 'utf8', timeout: 30000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /could not read the process list/);
    assert.match(ran.stdout, /the leak count may be incomplete/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('start leak readings stay unknown when any scan reader is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-unread-'));
  try {
    for (const missing of ['process list', 'process environments', 'agent sockets']) {
      const start = recordEngineResource(root, { phase: 'start' }, {
        platform: 'linux', uid: 501, loadavg: () => [0, 0, 0],
        readSshAgents: () => ({ agents: [], referenced: new Set(), unread: [missing] }),
      });
      assert.strictEqual(start.leaked_ssh_agents, null, missing);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real start recording keeps a denied process scan unknown on disk', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-denied-'));
  try {
    const probe = `
      const { recordEngineResource } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'engine-resource'))});
      process.stdout.write(JSON.stringify(recordEngineResource(${JSON.stringify(root)}, { phase: 'start', engine: 'probe' })));
    `;
    const ran = require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-p', '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))',
      process.execPath, '-e', probe,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(ran.status, 0, ran.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8'));
    assert.strictEqual(saved.leaked_ssh_agents, null);
    assert.deepStrictEqual(saved, JSON.parse(ran.stdout));
    console.log(`denied process scan exit ${ran.status}: ${ran.stdout}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup reports unreadable initial and final scans without saving a false zero', () => {
  const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
  const reads = () => [
    { agents: [agent], referenced: new Set(), unread: ['agent sockets'] },
    { agents: [agent], referenced: new Set([200]), unread: ['process environments'] },
  ];
  const signals = [];
  const text = sweepWithReads(reads(), { kill: (pid) => signals.push(pid) });
  assert.match(text.text, /could not read the agent sockets or the process environments/);
  assert.match(text.text, /the leak count may be incomplete/);
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(text.log[0].leaked_ssh_agents, null);
  assert.deepStrictEqual(text.log[0].unread, ['process environments']);
  const json = sweepWithReads(reads(), { args: ['sweep', '--apply', '--json'], kill: () => assert.fail('unread agent must stay safe') });
  assert.deepStrictEqual(JSON.parse(json.text).unread, ['agent sockets', 'process environments']);
});

test('real cleanup reports denied process scans and saves an unknown remaining count', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cleanup-denied-'));
  try {
    const cli = path.join(__dirname, '..', 'bin', 'atris.js');
    const run = (extra) => require('node:child_process').spawnSync('/usr/bin/sandbox-exec', [
      '-p', '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))',
      process.execPath, cli, 'engine', 'sweep', '--apply', ...extra,
    ], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' } });
    const text = run([]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /could not read the process list/);
    const json = run(['--json']);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.deepStrictEqual(report.unread, ['process list']);
    assert.strictEqual(report.history.last_sweep.leaked_ssh_agents, null);
    assert.deepStrictEqual(report.history.last_sweep.unread, ['process list']);
    assert.deepStrictEqual(report.stopped, []);
    console.log('denied cleanup exit ' + text.status + ': ' + text.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real cleanup skips a younger replacement pid while stopping an unchanged agent', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-reused-pid-'));
  const pids = [];
  try {
    for (const name of ['replacement', 'unchanged']) {
      const started = spawnSync('/usr/bin/ssh-agent', ['-s', '-a', path.join(root, name)], { encoding: 'utf8', timeout: 10000 });
      const pid = Number((/SSH_AGENT_PID=(\d+)/.exec(started.stdout) || [])[1]);
      if (pid) pids.push(pid);
      assert.equal(started.status, 0, started.stderr);
      assert.ok(pid);
    }
    // Keep real sockets and real signals, but stage the two process ages to
    // reproduce reuse without waiting for the OS to recycle a process number.
    // Restrict the process list to agents this test owns.
    const preload = path.join(root, 'reuse.cjs');
    fs.writeFileSync(preload, `
      const cp = require('node:child_process');
      const real = cp.spawnSync;
      let scan = 0;
      cp.spawnSync = (cmd, args, opts) => {
        const reading = real(cmd, args, opts);
        if (require('node:path').basename(cmd) === 'ps' && args.includes('pid=,ppid=,uid=,etime=,args=')) {
          scan++;
          reading.stdout = String(reading.stdout || '').split('\\n').flatMap(line => {
            const match = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+\\S+\\s+(.+)$/.exec(line);
            if (!match || !${JSON.stringify(pids)}.includes(Number(match[1]))) return [];
            const age = scan === 1 ? '01:00:00' : Number(match[1]) === ${pids[0]} ? '15:00' : '01:00:01';
            return [match[1] + ' 1 ' + match[3] + ' ' + age + ' ssh-agent -s'];
          }).join('\\n');
        }
        return reading;
      };
    `);
    const cli = path.join(__dirname, '..', 'bin', 'atris.js');
    const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
    });
    assert.equal(ran.status, 0, ran.stderr);
    const report = JSON.parse(ran.stdout);
    assert.deepStrictEqual(report.stopped, [pids[1]]);
    assert.deepStrictEqual(report.skipped, [pids[0]]);
    assert.deepStrictEqual(report.replaced, [pids[0]]);
    const reachable = spawnSync('/usr/bin/ssh-add', ['-l'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, SSH_AUTH_SOCK: path.join(root, 'replacement') },
    });
    assert.equal(reachable.status, 1, reachable.stderr);
    assert.match(reachable.stdout, /no identities/i);
    assert.deepStrictEqual(report.history.last_sweep.skipped, [pids[0]]);
    assert.deepStrictEqual(report.history.last_sweep.replaced, [pids[0]]);
    const text = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply'], {
      cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
    });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /1 skipped because a younger ssh-agent now has the same process number/);
    assert.doesNotMatch(text.stdout, /in use or gone/);
    console.log('replacement text cleanup exit ' + text.status + ': ' + text.stdout.trim());
    console.log('replacement cleanup exit ' + ran.status + ': stopped one unchanged agent, skipped one younger replacement; replacement socket still answers');
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('cleanup separates younger replacements from in-use or gone skips', () => {
  const agent = (pid, age_sec = 3600) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
  const first = { agents: [agent(200), agent(201), agent(202)], referenced: new Set() };
  const second = { agents: [agent(200, 90), agent(201)], referenced: new Set([201]) };
  const report = sweepWithReads([first, second], { kill: () => assert.fail('all agents must stay safe') });
  assert.match(report.text, /1 skipped because a younger ssh-agent now has the same process number/);
  assert.match(report.text, /2 skipped because they were in use or gone on the recheck/);
  assert.deepStrictEqual(report.log[0].replaced, [200]);
  assert.deepStrictEqual(report.log[0].skipped, [200, 201, 202]);
});

test('every map ref to an engine resource or dispatch test lands on the line that starts the test', () => {
  // A single line ref opens one test; a line range opens a test and ends on
  // the line that closes a test.
  const offTest = (doc, text, testFiles) => {
    const found = [];
    for (const match of text.matchAll(/(test\/engine-(?:resource|dispatch)\.test\.js):(\d+)(?:-(\d+))?(?!\d)/g)) {
      const [ref, file, start, end] = match;
      const lines = testFiles[file];
      const opens = /^test\(/.test(lines[Number(start) - 1] || '');
      const closes = !end || (Number(end) > Number(start) && lines[Number(end) - 1] === '});');
      if (!opens || !closes) found.push(`${doc} ${ref}`);
    }
    return [...new Set(found)];
  };
  const planted = { 'test/engine-resource.test.js': ['', "test('one', () => {", '  ok();', '});'], 'test/engine-dispatch.test.js': [] };
  assert.deepStrictEqual(offTest('doc', 'see `test/engine-resource.test.js:2` and `test/engine-resource.test.js:3`', planted), ['doc test/engine-resource.test.js:3']);
  assert.deepStrictEqual(offTest('doc', 'block `test/engine-resource.test.js:2-4`', planted), []);
  assert.deepStrictEqual(offTest('doc', 'block `test/engine-resource.test.js:1-4` and `test/engine-resource.test.js:2-3`', planted), [
    'doc test/engine-resource.test.js:1-4', 'doc test/engine-resource.test.js:2-3',
  ]);
  const repo = path.join(__dirname, '..');
  const testFiles = {};
  for (const file of ['test/engine-resource.test.js', 'test/engine-dispatch.test.js']) testFiles[file] = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  const stale = [];
  for (const doc of ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']) stale.push(...offTest(doc, fs.readFileSync(path.join(repo, doc), 'utf8'), testFiles));
  assert.deepStrictEqual(stale, [], 'a test moved; point each ref at the line where its test now starts, and a range at the line where its last test ends');
});

test('the console records a piped print run and keeps no reading for a session handed to the person', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-console-run-'));
  try {
    const runner = path.join(root, 'fake-claude');
    fs.writeFileSync(runner, '#!/bin/sh\ncat >/dev/null\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
    const consolePath = path.join(__dirname, '..', 'commands', 'console.js');
    const launch = (options, exit = '0') => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(consolePath)}).launchClaude('system', [], ${JSON.stringify(options)})`], {
      cwd: root,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, ATRIS_RUNNER_BIN: runner, FAKE_EXIT: exit },
    });
    const log = () => {
      const file = path.join(root, '.atris', 'state', 'engine-resource.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    };
    assert.strictEqual(launch({ skipPermissions: false }).status, 0);
    assert.deepStrictEqual(log(), [], 'a session handed to the person keeps no reading');
    assert.strictEqual(launch({ skipPermissions: false, promptStdin: 'hello' }).status, 0);
    const ok = log();
    assert.deepStrictEqual(ok.map((entry) => [entry.phase, entry.engine, entry.task]), [['start', 'fake-claude', 'console print'], ['end', 'fake-claude', 'console print']]);
    assert.strictEqual(ok[0].run_id, ok[1].run_id);
    assert.strictEqual(ok[1].error, undefined, 'a clean run keeps no error');
    assert.strictEqual(launch({ skipPermissions: false, promptStdin: 'hello' }, '3').status, 3);
    const failed = log().at(-1);
    assert.deepStrictEqual([failed.phase, failed.error], ['end', 'runner exited 3']);
    console.log(`real console print run end reading: ${JSON.stringify(failed)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a headless pack run records its print run through the real command', () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-print-'));
  try {
    const packDir = path.join(dir, 'g-brain');
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, 'pack.json'), `${JSON.stringify({ slug: 'g-brain', title: 'G Brain', version: '0.1.0' })}\n`);
    fs.writeFileSync(path.join(packDir, 'README.md'), '# G Brain\n');
    const runner = path.join(dir, 'fake-runner.sh');
    fs.writeFileSync(runner, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'pack', 'run', 'g-brain'], {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: runner },
    });
    assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    // The run log sits under whichever folder the launch ran in.
    const logs = [dir, packDir].map((root) => path.join(root, '.atris', 'state', 'engine-resource.jsonl')).filter((file) => fs.existsSync(file));
    assert.strictEqual(logs.length, 1, 'one run log is written');
    const entries = fs.readFileSync(logs[0], 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepStrictEqual(entries.map((entry) => [entry.phase, entry.engine, entry.task]), [['start', 'fake-runner.sh', 'console print'], ['end', 'fake-runner.sh', 'console print']]);
    assert.strictEqual(entries[0].run_id, entries[1].run_id);
    console.log(`real pack print run log: ${path.relative(dir, logs[0])}, ${entries.length} readings`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each sweep line counts the unguarded agent starts in the shell startup files it read', () => {
  const { runSshAgentSweep } = require('../commands/autoland');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-start-lines-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-start-lines-home-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const read = () => ({ agents: [agent(200)], referenced: new Set() });
  const lines = () => fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    fs.writeFileSync(path.join(home, '.zprofile'), 'if true; then eval `ssh-agent -s`; fi\n');
    runSshAgentSweep(root, {}, { read, uid: 501, home, kill: () => {} });
    assert.strictEqual(lines().pop().unguarded_start_lines, 2, 'the hourly pass counts every unguarded start, fixable or not');
    fs.writeFileSync(path.join(home, '.zshrc'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n');
    fs.rmSync(path.join(home, '.zprofile'));
    const original = console.log;
    console.log = () => {};
    try {
      engineCommand(['sweep', '--apply'], { root, engineSweep: { read, uid: 501, home, kill: () => {} } });
    } finally {
      console.log = original;
    }
    assert.strictEqual(lines().pop().unguarded_start_lines, 0, 'a guarded line is recorded as fixed');
    runSshAgentSweep(root, {}, { read, uid: 501, kill: () => {} });
    assert.ok(!('unguarded_start_lines' in lines().pop()), 'a sweep that read no startup files records no count');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the landing status says when the sweeps first found the ssh-agent startup line guarded', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-guarded-'));
  const file = path.join(root, RESOURCE_LOG);
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const sweep = (h, count) => JSON.stringify({ at: hoursAgo(h), phase: 'sweep', stopped: [], failed: [], skipped: [], leaked_ssh_agents: 0, ...(count === undefined ? {} : { unguarded_start_lines: count }) });
  const status = (lines, home) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { readSshAgents: () => ({ agents: [], referenced: new Set() }), uid: 501, ...(home ? { home } : {}) });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const guarded = status([sweep(5, 1), sweep(4, 1), sweep(3), sweep(2, 0), sweep(1, 0)]);
    const at = (h) => hoursAgo(h).slice(0, 13);
    assert.match(guarded, /ssh-agent startup line guarded: the sweep at \d{4}-\d\d-\d\d \d\d:\d\d UTC found no unguarded start, the one at \d{4}-\d\d-\d\d \d\d:\d\d UTC found 1/);
    const named = guarded.match(/the sweep at (\S+ \d\d)/)[1].replace(' ', 'T');
    assert.strictEqual(named, at(2), 'the first sweep at zero is named, not a later one, and a sweep that read no files does not count');
    assert.doesNotMatch(status([sweep(3, 1), sweep(2, 0), sweep(1, 1)]), /startup line guarded/, 'a line that came back clears it');
    assert.doesNotMatch(status([sweep(2, 0), sweep(1, 0)]), /startup line guarded/, 'zero from the start was never a fix');
    assert.doesNotMatch(status([sweep(200, 1), sweep(199, 0)]), /startup line guarded/, 'a fix older than a week is not named');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-guarded-home-'));
    try {
      fs.writeFileSync(path.join(home, '.zshrc'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n');
      assert.match(status([sweep(3, 1), sweep(2, 0)], home), /startup line guarded/, 'a guarded file read now agrees with the log');
      fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
      assert.doesNotMatch(status([sweep(3, 1), sweep(2, 0)], home), /startup line guarded/, 'a file that starts an agent again wins over the log');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    const { readResourceHistory } = require('../lib/engine-resource');
    assert.strictEqual(readResourceHistory(root).start_lines_guarded.before, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the guarded startup line names how fast ssh-agents leaked in the day before and since', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-guard-rate-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const start = (h, count) => JSON.stringify({ at: at(h), phase: 'start', engine: 'claude', leaked_ssh_agents: count });
  const sweep = (h, count, lines) => JSON.stringify({ at: at(h), phase: 'sweep', stopped: [1], failed: [], skipped: [], leaked_ssh_agents: count, unguarded_start_lines: lines });
  const status = (lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { readSshAgents: () => ({ agents: [], referenced: new Set() }), uid: 501 });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    // Before: rises of 40 and 80 over the 6 hours up to the fix, and the
    // sweep in between adds nothing. Since: rises of 4 and 3 over 3.5 hours.
    const slowed = status([start(30, 5000), start(10, 100), start(8, 140), sweep(6, 0, 1), start(5, 80), sweep(4, 0, 0), start(2, 4), start(0.5, 7)]);
    assert.match(slowed, /startup line guarded: [^\n]*found 1; leaked ssh-agents in the day before: about 20 new an hour, since: about 2 new an hour/, 'a reading older than a day before the fix is left out');
    const early = status([sweep(3, 0, 1), sweep(2, 0, 0)]);
    assert.match(early, /in the day before: about 0 new an hour, since: too few readings to say/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status warns when ssh-agents keep leaking after the startup line was guarded', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-still-leaking-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const start = (h, count) => JSON.stringify({ at: at(h), phase: 'start', engine: 'claude', leaked_ssh_agents: count });
  const sweep = (h, count, lines) => JSON.stringify({ at: at(h), phase: 'sweep', stopped: [1], failed: [], skipped: [], leaked_ssh_agents: count, unguarded_start_lines: lines });
  const status = (lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { readSshAgents: () => ({ agents: [], referenced: new Set() }), uid: 501 });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const leaking = status([sweep(6, 0, 1), sweep(4, 0, 0), start(2, 10), start(0, 20)]);
    assert.match(leaking, /startup line guarded: [^\n]*since: about 5 new an hour\n {4}still leaking after the fix: about 5 new ssh-agents an hour, so something other than the shell startup line is starting them/);
    const settled = status([sweep(6, 0, 1), sweep(4, 0, 0), start(2, 4), start(0, 8)]);
    assert.match(settled, /since: about 2 new an hour/);
    assert.doesNotMatch(settled, /still leaking/, 'a few stray leaks are not a second source');
    assert.doesNotMatch(status([sweep(6, 0, 1), sweep(4, 0, 0)]), /still leaking/, 'too few readings since is no warning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status splits leaked ssh-agents by the engine runs open when they started', () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-leak-runs-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const agent = (pid, h) => ({ pid, ppid: 1, uid: 501, age_sec: Math.round(h * 3600), args: 'ssh-agent -s' });
  const status = (lines, agents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { readSshAgents: () => ({ agents, referenced: new Set() }), uid: 501, pathAtrisRecordsRuns: true });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const log = [
      JSON.stringify({ at: at(6), phase: 'sweep', stopped: [], failed: [], skipped: [] }),
      JSON.stringify({ at: at(5), phase: 'start', engine: 'claude', run_id: 'a' }),
      JSON.stringify({ at: at(4.5), phase: 'start', engine: 'cursor', run_id: 'b' }),
      JSON.stringify({ at: at(3.5), phase: 'end', engine: 'cursor', run_id: 'b' }),
      JSON.stringify({ at: at(3), phase: 'end', engine: 'claude', run_id: 'a' }),
      JSON.stringify({ at: at(1), phase: 'start', engine: 'codex', run_id: 'c' }),
    ];
    // 4h ago both claude and cursor were open, so the newer cursor run is
    // named; 3.2h ago only claude; 2h ago nothing; 0.5h ago codex, still
    // open; 8h ago is before the log begins.
    const split = status(log, [agent(200, 4), agent(201, 3.2), agent(202, 2), agent(203, 0.5), agent(204, 8)]);
    assert.match(split, /leaked ssh-agents on this machine: 5;[^\n]*\n {4}when the leaked ssh-agents started: 3 started while an engine run was open \(cursor 1, claude 1, codex 1\), 1 with no engine run open, 1 before the run log begins/);
    const outside = status(log, [agent(202, 2)]);
    assert.match(outside, /when the leaked ssh-agents started: 0 started while an engine run was open, 1 with no engine run open\n/);
    assert.doesNotMatch(status(log, []), /when the leaked ssh-agents started/, 'no leak, no split');
    assert.doesNotMatch(status(log, [agent(204, 8)]), /when the leaked ssh-agents started/, 'agents older than the whole log say nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a leaked ssh-agent that started during a run whose start fell before the read part of a big log is named with that run', () => {
  const { showStatus } = require('../commands/autoland');
  const { MAX_LOG_BYTES } = require('../lib/engine-resource');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-leak-cut-start-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const agent = (pid, h) => ({ pid, ppid: 1, uid: 501, age_sec: Math.round(h * 3600), args: 'ssh-agent -s' });
  const status = (agents) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { readSshAgents: () => ({ agents, referenced: new Set() }), uid: 501, pathAtrisRecordsRuns: true });
    } finally {
      console.log = original;
    }
    return out.join('\n');
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A pad line the size of the read part pushes LOST's start out of it,
    // so the read part begins with cursor run B 5h ago.
    fs.writeFileSync(file, [
      JSON.stringify({ at: at(6), phase: 'start', engine: 'codex', run_id: 'LOST' }),
      'x'.repeat(MAX_LOG_BYTES),
      JSON.stringify({ at: at(5), phase: 'start', engine: 'cursor', run_id: 'B' }),
      JSON.stringify({ at: at(4.5), phase: 'end', engine: 'cursor', run_id: 'B' }),
      JSON.stringify({ at: at(2), phase: 'end', engine: 'codex', run_id: 'LOST' }),
      '',
    ].join('\n'));
    // 3h ago only LOST was open; 1h ago nothing; 5.5h ago is before the
    // read part begins.
    const agents = [agent(300, 3), agent(301, 1), agent(302, 5.5)];
    const split = status(agents);
    const line = split.split('\n').find((l) => l.includes('when the leaked ssh-agents started'));
    console.log(`real cut start leak split: ${line && line.trim()}`);
    assert.match(split, /when the leaked ssh-agents started: 1 started while an engine run was open \(codex 1\), 1 with no engine run open, 1 before the run log begins/, split);

    // The sweep listing reads the same log and prints the same split.
    const { engineCommand } = require('../commands/engine');
    const out = [];
    const original = console.log;
    console.log = (l = '') => out.push(String(l));
    try {
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents, referenced: new Set() }), uid: 501, pathAtrisRecordsRuns: true } });
    } finally {
      console.log = original;
    }
    const sweepLine = out.join('\n').split('\n').find((l) => l.includes('when the leaked ssh-agents started'));
    console.log(`real cut start sweep split: ${sweepLine}`);
    assert.strictEqual(sweepLine, line.trim(), 'the sweep listing and the landing status agree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the sweep listing does not blame the startup line for agents that started during a run whose start was cut from a big log', () => {
  const { engineCommand } = require('../commands/engine');
  const { MAX_LOG_BYTES } = require('../lib/engine-resource');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-cut-start-blame-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-cut-start-blame-home-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const agent = (pid, h) => ({ pid, ppid: 1, uid: 501, age_sec: Math.round(h * 3600), args: 'ssh-agent -s' });
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    // LOST's start falls before the read part, which begins with cursor run
    // B 5h ago; LOST ends 1.5h ago.
    fs.writeFileSync(file, [
      JSON.stringify({ at: at(6), phase: 'start', engine: 'codex', run_id: 'LOST' }),
      'x'.repeat(MAX_LOG_BYTES),
      JSON.stringify({ at: at(5), phase: 'start', engine: 'cursor', run_id: 'B' }),
      JSON.stringify({ at: at(4.8), phase: 'end', engine: 'cursor', run_id: 'B' }),
      JSON.stringify({ at: at(1.5), phase: 'end', engine: 'codex', run_id: 'LOST' }),
      '',
    ].join('\n'));
    // Two agents start while LOST is open and one after it ends, none in
    // the last hour, so most started during an engine run.
    const out = [];
    const original = console.log;
    console.log = (l = '') => out.push(String(l));
    try {
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [agent(400, 3), agent(401, 2.5), agent(402, 1.2)], referenced: new Set() }), uid: 501, home, pathAtrisRecordsRuns: true } });
    } finally {
      console.log = original;
    }
    const listing = out.join('\n');
    console.log(`real cut start sweep blame: ${listing.split('\n').find((l) => l.includes('when the leaked ssh-agents started'))}`);
    assert.match(listing, /\nwhen the leaked ssh-agents started: 2 started while an engine run was open \(codex 2\), 1 with no engine run open\nlikely source: ~\/\.zshrc line 1/, listing);
    assert.doesNotMatch(listing, /the startup line below is the one to fix, not an engine/, 'agents during the cut-off run do not point the blame at the startup line');
    const landing = [];
    console.log = (line = '') => landing.push(String(line));
    try {
      require('../commands/autoland').showStatus(root, [], {
        readSshAgents: () => ({ agents: [agent(400, 3), agent(401, 2.5), agent(402, 1.2)], referenced: new Set() }),
        uid: 501, home, pathAtrisRecordsRuns: true,
      });
    } finally {
      console.log = original;
    }
    const status = landing.join('\n');
    const split = status.split('\n').find((line) => line.includes('when the leaked ssh-agents started'));
    console.log(`real cut start landing advice: ${split && split.trim()}`);
    assert.strictEqual(split && split.trim(), listing.split('\n').find((line) => line.includes('when the leaked ssh-agents started')));
    assert.doesNotMatch(status, /the startup line below is the one to fix, not an engine/);
    assert.match(status, /likely source: ~\/\.zshrc line 1/);
    assert.match(status, /engine sweep --fix-startup/, 'the repair command remains available without assigning blame');

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the sweep listing splits leaked ssh-agents by engine runs and points to the startup line when most started outside them', () => {
  const { engineCommand } = require('../commands/engine');
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-leak-runs-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-leak-runs-home-'));
  const file = path.join(root, RESOURCE_LOG);
  const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const agent = (pid, h) => ({ pid, ppid: 1, uid: 501, age_sec: Math.round(h * 3600), args: 'ssh-agent -s' });
  const capture = (fn) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try { fn(); } finally { console.log = original; }
    return out.join('\n');
  };
  const sweep = (agents, more = {}) => capture(() => engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents, referenced: new Set() }), uid: 501, home, pathAtrisRecordsRuns: true, ...more } }));
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ at: at(6), phase: 'start', engine: 'claude', run_id: 'a' }),
      JSON.stringify({ at: at(5), phase: 'end', engine: 'claude', run_id: 'a' }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    const outside = sweep([agent(200, 5.5), agent(201, 3), agent(202, 2)]);
    const blind = sweep([agent(200, 5.5), agent(201, 3), agent(202, 2)], { pathAtrisRecordsRuns: false });
    assert.match(blind, /2 with no engine run open; the atris on your PATH does not record engine runs, so agents from the runs it starts count as none open\nlikely source/, 'an atris that leaves no run lines makes the outside count unreliable, so no claim is made');
    const blindStatus = capture(() => showStatus(root, [], {
      readSshAgents: () => ({ agents: [agent(200, 5.5), agent(201, 3), agent(202, 2)], referenced: new Set() }),
      uid: 501, home, pathAtrisRecordsRuns: false,
    }));
    const blindSplit = blind.split('\n').find((line) => line.includes('when the leaked ssh-agents started'));
    const landingSplit = blindStatus.split('\n').find((line) => line.includes('when the leaked ssh-agents started'));
    console.log(`real missing run recording landing advice: ${landingSplit && landingSplit.trim()}`);
    assert.strictEqual(landingSplit && landingSplit.trim(), blindSplit, 'landing status repeats the sweep warning about missing run records');
    assert.doesNotMatch(blindStatus, /the startup line below is the one to fix, not an engine/);
    assert.match(blindStatus, /likely source: ~\/\.zshrc line 1/);
    assert.match(blindStatus, /engine sweep --fix-startup/, 'missing run records do not hide the repair command');
    assert.match(outside, /\nwhen the leaked ssh-agents started: 1 started while an engine run was open \(claude 1\), 2 with no engine run open; most started with no engine run open, so the startup line below is the one to fix, not an engine\nlikely source: ~\/\.zshrc line 1/);
    const during = sweep([agent(200, 5.5), agent(201, 5.2), agent(202, 2)]);
    assert.match(during, /when the leaked ssh-agents started: 2 started while an engine run was open \(claude 2\), 1 with no engine run open\n/, 'mostly during runs names no single fix');
    fs.writeFileSync(path.join(home, '.zshrc'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n');
    assert.match(sweep([agent(201, 3), agent(202, 2)]), /2 with no engine run open\n/, 'no startup line found, no pointer to one');
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    const status = capture(() => showStatus(root, [], { readSshAgents: () => ({ agents: [agent(201, 3), agent(202, 2)], referenced: new Set() }), uid: 501, home, pathAtrisRecordsRuns: true }));
    assert.match(status, /\n {4}when the leaked ssh-agents started: [^\n]*so the startup line below is the one to fix, not an engine\n {4}likely source: ~\/\.zshrc line 1/);
    fs.appendFileSync(file, `${JSON.stringify({ at: at(0.8), phase: 'start', engine: 'codex', run_id: 'b' })}\n`);
    const turned = sweep([agent(201, 3), agent(202, 2), agent(203, 2.5), agent(204, 0.5)]);
    assert.match(turned, /\nwhen the leaked ssh-agents started: 1 started while an engine run was open \(codex 1\), 3 with no engine run open; in the last hour: 1 while an engine run was open, 0 with none open\nlikely source/, 'a last hour mostly inside engine runs drops the claim that the engines are not the source');
    assert.match(sweep([agent(201, 3), agent(202, 2), agent(205, 0.9)]), /; in the last hour: 0 while an engine run was open, 1 with none open; most started with no engine run open, so the startup line below is the one to fix, not an engine\n/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('copied startup repair commands preserve shell punctuation in checkout paths', () => {
  const { atrisCommand } = require('../lib/engine-resource');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-command-shell-')));
  try {
    for (const name of ['my checkout', '$HOME', '`printf changed`', "a'b", 'a"b', 'a;b', 'a\nb']) {
      const bin = path.join(root, name, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'atris.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const command = `${atrisCommand({ pathEnv: root, binDir: bin, home: root })} engine sweep --fix-startup`;
      const shells = ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
      for (const shell of shells) {
        const run = spawnSync(shell, ['-c', command], { encoding: 'utf8' });
        assert.strictEqual(run.status, 0, `${name}: ${run.stderr}`);
        assert.strictEqual(run.stdout, '["engine","sweep","--fix-startup"]', `${shell}: ${name}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('startup repair command lookup skips PATH entries that the shell cannot run', () => {
  const { atrisCommand, pathAtrisRecordsRuns } = require('../lib/engine-resource');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-command-executable-')));
  try {
    const bin = path.join(root, 'checkout', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'atris.js');
    fs.writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write(process.argv[2] === "version" ? "atris v0.0.0" : JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 });
    fs.symlinkSync(script, path.join(bin, 'atris'));
    fs.mkdirSync(path.join(root, 'checkout', 'lib'));
    fs.writeFileSync(path.join(root, 'checkout', 'lib', 'engine-resource.js'), '');
    for (const kind of ['file', 'directory', 'broken-link', 'non-executable-link']) {
      const blocked = path.join(root, kind);
      fs.mkdirSync(blocked);
      const entry = path.join(blocked, 'atris');
      if (kind === 'file') fs.writeFileSync(entry, '', { mode: 0o644 });
      if (kind === 'directory') fs.mkdirSync(entry);
      if (kind === 'broken-link') fs.symlinkSync(path.join(root, 'missing'), entry);
      if (kind === 'non-executable-link') {
        const target = path.join(blocked, 'target');
        fs.writeFileSync(target, '', { mode: 0o644 });
        fs.symlinkSync(target, entry);
      }
      const pathEnv = [blocked, bin, path.dirname(process.execPath)].join(path.delimiter);
      const env = { ...process.env, PATH: pathEnv };
      const lookup = spawnSync('/bin/sh', ['-c', 'command -v atris'], { env, encoding: 'utf8' });
      assert.strictEqual(lookup.status, 0, lookup.stderr);
      assert.strictEqual(lookup.stdout.trim(), path.join(bin, 'atris'), kind);
      const command = atrisCommand({ pathEnv, binDir: bin, home: '' });
      assert.strictEqual(command, 'atris', kind);
      assert.strictEqual(pathAtrisRecordsRuns({ pathEnv }), true, kind);
      const run = spawnSync('/bin/sh', ['-c', `${command} engine sweep --fix-startup`], { env, encoding: 'utf8' });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.strictEqual(run.stdout, '["engine","sweep","--fix-startup"]', kind);
      assert.strictEqual(atrisCommand({ pathEnv: blocked, binDir: bin, home: '' }), `${process.execPath} ${script}`, kind);
      assert.strictEqual(pathAtrisRecordsRuns({ pathEnv: blocked }), true, kind);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup repair lookup searches the current folder for empty PATH entries in shell order', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-command-empty-path-')));
  try {
    const bin = path.join(root, 'checkout', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'atris.js');
    fs.writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))`, { mode: 0o755 });
    fs.symlinkSync(script, path.join(bin, 'atris'));
    fs.mkdirSync(path.join(root, 'checkout', 'lib'));
    fs.writeFileSync(path.join(root, 'checkout', 'lib', 'engine-resource.js'), '');
    // An older command in the current folder must not be offered as the repair.
    fs.writeFileSync(path.join(root, 'atris'), '#!/bin/sh\nprintf old-install', { mode: 0o755 });
    const probe = `
      const { atrisCommand, pathAtrisRecordsRuns } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'engine-resource'))});
      process.stdout.write(JSON.stringify({
        command: atrisCommand({ binDir: ${JSON.stringify(bin)}, home: '' }),
        records: pathAtrisRecordsRuns()
      }));
    `;
    for (const entries of [[], ['', bin], [path.join(root, 'missing'), '', bin], [path.join(root, 'missing'), ''], [bin, '']]) {
      const env = { ...process.env, PATH: entries.join(path.delimiter) };
      const currentFirst = entries[0] !== bin;
      const read = spawnSync(process.execPath, ['-e', probe], { cwd: root, env, encoding: 'utf8' });
      assert.strictEqual(read.status, 0, read.stderr);
      const hint = JSON.parse(read.stdout);
      assert.strictEqual(hint.command, `${process.execPath} ${script}`, env.PATH);
      assert.strictEqual(hint.records, !currentFirst, env.PATH);
      for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
        const lookup = spawnSync(shell, ['-c', 'atris'], { cwd: root, env, encoding: 'utf8' });
        assert.strictEqual(lookup.status, 0, lookup.stderr);
        assert.strictEqual(lookup.stdout, currentFirst ? 'old-install' : '[]', `${shell}: ${env.PATH}`);
        const run = spawnSync(shell, ['-c', `${hint.command} engine sweep --fix-startup`], {
          cwd: root, env: { ...env, PATH: `${env.PATH}${path.delimiter}${path.dirname(process.execPath)}` }, encoding: 'utf8'
        });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.strictEqual(run.stdout, '["engine","sweep","--fix-startup"]', `${shell}: ${env.PATH}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copied startup repair commands run without node on PATH', () => {
  const { atrisCommand } = require('../lib/engine-resource');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-command-no-node-')));
  try {
    const bin = path.join(root, 'my checkout', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'atris.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const command = `${atrisCommand({ pathEnv: '', binDir: bin, home: '' })} engine sweep --fix-startup`;
    for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
      const run = spawnSync(shell, ['-c', command], { cwd: root, env: { ...process.env, PATH: '' }, encoding: 'utf8' });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.strictEqual(run.stdout, '["engine","sweep","--fix-startup"]', shell);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('same-checkout startup repair commands bypass a launcher with no usable node on PATH', () => {
  const { atrisCommand } = require('../lib/engine-resource');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-command-local-no-node-')));
  try {
    const bin = path.join(root, 'my checkout', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'atris.js');
    fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2] === "version" ? "atris v0.0.0" : JSON.stringify(process.argv.slice(2)))', { mode: 0o755 });
    fs.symlinkSync(script, path.join(bin, 'atris'));
    for (const kind of ['missing', 'file', 'directory', 'broken-link']) {
      const blocked = path.join(root, kind);
      fs.mkdirSync(blocked);
      const node = path.join(blocked, 'node');
      if (kind === 'file') fs.writeFileSync(node, '', { mode: 0o644 });
      if (kind === 'directory') fs.mkdirSync(node);
      if (kind === 'broken-link') fs.symlinkSync(path.join(root, 'absent'), node);
      const pathEnv = [blocked, bin].join(path.delimiter);
      const command = atrisCommand({ pathEnv, binDir: bin, home: '' });
      assert.notStrictEqual(command, 'atris', kind);
      for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
        const env = { ...process.env, PATH: pathEnv };
        const direct = spawnSync(shell, ['-c', 'atris engine sweep --fix-startup'], { env, encoding: 'utf8' });
        assert.notStrictEqual(direct.status, 0, `${shell}: ${kind}: launcher needs node`);
        const run = spawnSync(shell, ['-c', `${command} engine sweep --fix-startup`], { env, encoding: 'utf8' });
        assert.strictEqual(run.status, 0, `${shell}: ${kind}: ${run.stderr}`);
        assert.strictEqual(run.stdout, '["engine","sweep","--fix-startup"]', `${shell}: ${kind}`);
      }
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    assert.strictEqual(atrisCommand({ pathEnv: bin, binDir: bin, home: '' }), 'atris');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status repair hint runs with this checkout launcher on PATH and no node', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-local-no-node-')));
  try {
    const work = path.join(root, 'work');
    const home = path.join(root, 'home');
    const onlyLauncher = path.join(root, 'only-launcher');
    for (const dir of [work, home, onlyLauncher]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(onlyLauncher, 'atris'));
    // The real hint is built in a process whose PATH holds only this
    // checkout launcher, and the copied command runs outside the test runner
    // so it edits the fixture home.
    const env = { ...process.env, PATH: onlyLauncher, HOME: home };
    delete env.NODE_TEST_CONTEXT;
    const probe = `
      const { showStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'autoland'))});
      const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
      showStatus(process.cwd(), [], { readSshAgents: () => ({ agents: [agent], referenced: new Set() }), uid: 501, home: ${JSON.stringify(home)} });
    `;
    const status = spawnSync(process.execPath, ['-e', probe], { cwd: work, env, encoding: 'utf8' });
    assert.strictEqual(status.status, 0, status.stderr);
    const hint = status.stdout.match(/\n {4}to make that change, run (.+) engine sweep --fix-startup; it saves the old file beside it first/);
    assert.ok(hint, status.stdout);
    assert.strictEqual(hint[1], `${process.execPath} ${fs.realpathSync(path.join(__dirname, '..', 'bin', 'atris.js'))}`);
    for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
      // A fresh home per shell, since a second fix in the same second
      // refuses to overwrite the first saved copy.
      const shellHome = fs.mkdtempSync(path.join(root, 'home-'));
      fs.writeFileSync(path.join(shellHome, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
      const shellEnv = { ...env, HOME: shellHome };
      const direct = spawnSync(shell, ['-c', 'atris engine sweep --fix-startup'], { cwd: work, env: shellEnv, encoding: 'utf8' });
      assert.notStrictEqual(direct.status, 0, `${shell}: the launcher alone needs node`);
      const run = spawnSync(shell, ['-c', `${hint[1]} engine sweep --fix-startup`], { cwd: work, env: shellEnv, encoding: 'utf8' });
      assert.strictEqual(run.status, 0, `${shell}: ${run.stdout}${run.stderr}`);
      assert.match(run.stdout, /changed ~\/\.zshrc line 1 to: /, shell);
      assert.strictEqual(fs.readFileSync(path.join(shellHome, '.zshrc'), 'utf8'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n', shell);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status repair hint runs when a node entry is on PATH but cannot run', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-bad-node-')));
  try {
    const work = path.join(root, 'work');
    const launcher = path.join(root, 'launcher');
    for (const dir of [work, launcher]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(launcher, 'atris'));
    const script = fs.realpathSync(path.join(__dirname, '..', 'bin', 'atris.js'));
    for (const kind of ['file', 'directory', 'broken-link']) {
      const blocked = path.join(root, kind);
      fs.mkdirSync(blocked);
      const node = path.join(blocked, 'node');
      if (kind === 'file') fs.writeFileSync(node, '', { mode: 0o644 });
      if (kind === 'directory') fs.mkdirSync(node);
      if (kind === 'broken-link') fs.symlinkSync(path.join(root, 'absent'), node);
      const home = fs.mkdtempSync(path.join(root, 'home-'));
      fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
      // The listed node comes first, then this checkout launcher, and no
      // later entry can run Node. The copied command runs outside the test
      // runner so it edits the fixture home.
      const env = { ...process.env, PATH: [blocked, launcher].join(path.delimiter), HOME: home };
      delete env.NODE_TEST_CONTEXT;
      const probe = `
        const { showStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'autoland'))});
        const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
        showStatus(process.cwd(), [], { readSshAgents: () => ({ agents: [agent], referenced: new Set() }), uid: 501, home: ${JSON.stringify(home)} });
      `;
      const status = spawnSync(process.execPath, ['-e', probe], { cwd: work, env, encoding: 'utf8' });
      assert.strictEqual(status.status, 0, `${kind}: ${status.stderr}`);
      const hint = status.stdout.match(/\n {4}to make that change, run (.+) engine sweep --fix-startup; it saves the old file beside it first/);
      assert.ok(hint, `${kind}: ${status.stdout}`);
      assert.strictEqual(hint[1], `${process.execPath} ${script}`, kind);
      for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
        const shellHome = fs.mkdtempSync(path.join(root, 'home-'));
        fs.writeFileSync(path.join(shellHome, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
        const shellEnv = { ...env, HOME: shellHome };
        const direct = spawnSync(shell, ['-c', 'atris engine sweep --fix-startup'], { cwd: work, env: shellEnv, encoding: 'utf8' });
        assert.notStrictEqual(direct.status, 0, `${shell}: ${kind}: the listed node cannot run the launcher`);
        const run = spawnSync(shell, ['-c', `${hint[1]} engine sweep --fix-startup`], { cwd: work, env: shellEnv, encoding: 'utf8' });
        assert.strictEqual(run.status, 0, `${shell}: ${kind}: ${run.stdout}${run.stderr}`);
        assert.match(run.stdout, /changed ~\/\.zshrc line 1 to: /, `${shell}: ${kind}`);
        assert.strictEqual(fs.readFileSync(path.join(shellHome, '.zshrc'), 'utf8'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n', `${shell}: ${kind}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status repair hint stays the short command when an unusable node entry comes before a runnable node', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-node-later-')));
  try {
    const work = path.join(root, 'work');
    const launcher = path.join(root, 'launcher');
    const runnable = path.join(root, 'runnable');
    for (const dir of [work, launcher, runnable]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(launcher, 'atris'));
    fs.symlinkSync(process.execPath, path.join(runnable, 'node'));
    for (const kind of ['file', 'directory', 'broken-link']) {
      const blocked = path.join(root, kind);
      fs.mkdirSync(blocked);
      const node = path.join(blocked, 'node');
      if (kind === 'file') fs.writeFileSync(node, '', { mode: 0o644 });
      if (kind === 'directory') fs.mkdirSync(node);
      if (kind === 'broken-link') fs.symlinkSync(path.join(root, 'absent'), node);
      const home = fs.mkdtempSync(path.join(root, 'home-'));
      fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
      // The unusable node comes first, then a node that can run, then this
      // checkout launcher. System folders stay later so the launcher script
      // can run, without letting them hide the earlier node. The printed
      // command stays the short name, and the copied command runs outside
      // the test runner so it edits the fixture home.
      const env = { ...process.env, PATH: [blocked, runnable, launcher, '/bin', '/usr/bin'].join(path.delimiter), HOME: home };
      delete env.NODE_TEST_CONTEXT;
      const probe = `
        const { showStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'autoland'))});
        const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
        showStatus(process.cwd(), [], { readSshAgents: () => ({ agents: [agent], referenced: new Set() }), uid: 501, home: ${JSON.stringify(home)} });
      `;
      const status = spawnSync(process.execPath, ['-e', probe], { cwd: work, env, encoding: 'utf8' });
      assert.strictEqual(status.status, 0, `${kind}: ${status.stderr}`);
      const hint = status.stdout.match(/\n {4}to make that change, run (.+) engine sweep --fix-startup; it saves the old file beside it first/);
      assert.ok(hint, `${kind}: ${status.stdout}`);
      assert.strictEqual(hint[1], 'atris', kind);
      for (const shell of ['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])]) {
        const shellHome = fs.mkdtempSync(path.join(root, 'home-'));
        fs.writeFileSync(path.join(shellHome, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
        const shellEnv = { ...env, HOME: shellHome };
        const run = spawnSync(shell, ['-c', `${hint[1]} engine sweep --fix-startup`], { cwd: work, env: shellEnv, encoding: 'utf8' });
        assert.strictEqual(run.status, 0, `${shell}: ${kind}: ${run.stdout}${run.stderr}`);
        assert.match(run.stdout, /changed ~\/\.zshrc line 1 to: /, `${shell}: ${kind}`);
        assert.strictEqual(fs.readFileSync(path.join(shellHome, '.zshrc'), 'utf8'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n', `${shell}: ${kind}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status repair hint uses the checkout command when the first executable node rejects the launcher', async () => {
  const { spawnSync, execFile } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-node-later-')));
  try {
    const work = path.join(root, 'work');
    const launcher = path.join(root, 'launcher');
    const runnable = path.join(root, 'runnable');
    for (const dir of [work, launcher, runnable]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(launcher, 'atris'));
    fs.symlinkSync(process.execPath, path.join(runnable, 'node'));
    const run = (file, args, options) => new Promise((resolve) => execFile(file, args, { cwd: work, encoding: 'utf8', ...options }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    // Runs write only to their own fixture home, so every kind checks at once
    // and a hanging Node's waits overlap the other kinds instead of adding up.
    const checkKind = async (kind) => {
      const blocked = path.join(root, kind);
      fs.mkdirSync(blocked);
      const node = path.join(blocked, 'node');
      // Each start of this Node adds a line, so the test can count launcher checks.
      const runs = path.join(blocked, 'runs');
      fs.writeFileSync(node, kind === 'hanging-launcher'
        ? `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');\nsetInterval(() => {}, 1000);\n`
        : `#!/bin/sh\necho run >> '${runs}'\n${kind === 'chatty-launcher'
          ? 'echo v22.0.0\nexit 0\n'
          : kind === 'suffixed-launcher'
            ? 'echo "atris v3.70.0 is not installed for this node"\nexit 0\n'
            : `exit ${kind === 'silent-launcher' ? 0 : 42}\n`}`, { mode: 0o755 });
      const home = fs.mkdtempSync(path.join(root, 'home-'));
      fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
      // Shell lookup stops at this executable, even though a later Node works.
      const env = { ...process.env, PATH: [blocked, runnable, launcher, '/bin', '/usr/bin'].join(path.delimiter), HOME: home };
      delete env.NODE_TEST_CONTEXT;
      const probe = `
        const { showStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'autoland'))});
        const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
        showStatus(process.cwd(), [], { readSshAgents: () => ({ agents: [agent], referenced: new Set() }), uid: 501, home: ${JSON.stringify(home)} });
      `;
      const status = await run(process.execPath, ['-e', probe], { env, timeout: 10000 });
      assert.strictEqual(status.error, null, `${kind}: ${status.stderr}`);
      // A hanging Node costs one bounded wait per landing status, not one per line that names the command.
      assert.strictEqual(fs.readFileSync(runs, 'utf8'), 'run\n', `${kind}: one launcher check per landing status`);
      const hint = status.stdout.match(/\n {4}to make that change, run (.+) engine sweep --fix-startup; it saves the old file beside it first/);
      assert.ok(hint, `${kind}: ${status.stdout}`);
      assert.strictEqual(hint[1], `${process.execPath} ${fs.realpathSync(path.join(__dirname, '..', 'bin', 'atris.js'))}`, kind);
      // Both shells run at once; in each, the direct command finishes before
      // the printed one, so the unchanged file proves the direct one did nothing.
      await Promise.all(['/bin/sh', ...(fs.existsSync('/bin/zsh') ? ['/bin/zsh'] : [])].map(async (shell) => {
        const shellHome = fs.mkdtempSync(path.join(root, 'home-'));
        fs.writeFileSync(path.join(shellHome, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
        const shellEnv = { ...env, HOME: shellHome };
        const direct = await run(shell, ['-c', 'atris engine sweep --fix-startup'], { env: shellEnv, timeout: 500 });
        if (kind === 'hanging-launcher') assert.strictEqual(direct.error?.killed, true, shell);
        else assert.strictEqual(direct.error?.code, kind === 'rejecting-launcher' ? 42 : undefined, shell);
        if (kind === 'chatty-launcher') assert.strictEqual(direct.stdout, 'v22.0.0\n', shell);
        if (kind === 'suffixed-launcher') assert.strictEqual(direct.stdout, 'atris v3.70.0 is not installed for this node\n', shell);
        assert.strictEqual(fs.readFileSync(path.join(shellHome, '.zshrc'), 'utf8'), 'eval "$(ssh-agent -s)"\n', `${shell}: ${kind}: direct command did not repair startup`);
        const repair = await run(shell, ['-c', `${hint[1]} engine sweep --fix-startup`], { env: shellEnv });
        assert.strictEqual(repair.error, null, `${shell}: ${kind}: ${repair.stdout}${repair.stderr}`);
        assert.match(repair.stdout, /changed ~\/\.zshrc line 1 to: /, `${shell}: ${kind}`);
        assert.strictEqual(fs.readFileSync(path.join(shellHome, '.zshrc'), 'utf8'), '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"\n', `${shell}: ${kind}`);
      }));
    };
    await Promise.all(['rejecting-launcher', 'hanging-launcher', 'silent-launcher', 'chatty-launcher', 'suffixed-launcher'].map(checkKind));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real cleanup preview checks the launcher only when it prints a command', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-lazy-launcher-')));
  try {
    const work = path.join(root, 'work');
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    for (const dir of [work, bin, home]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(bin, 'atris'));
    // Each start of this Node adds a line, so the test can count launcher checks.
    const runs = path.join(root, 'runs');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho run >> '${runs}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: [bin, '/bin', '/usr/bin'].join(path.delimiter), HOME: home, ATRIS_AUTO_UPDATE: 'off' };
    delete env.NODE_TEST_CONTEXT;
    for (const leaked of [0, 1]) {
      const preload = path.join(root, `agents-${leaked}.cjs`);
      fs.writeFileSync(preload, `
        const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
        resource.readSshAgents = () => ({
          agents: ${leaked} ? [{ pid: 200, ppid: 1, uid: process.getuid(), age_sec: 3600, args: 'ssh-agent -s' }] : [],
          referenced: new Set(),
        });
      `);
      fs.rmSync(runs, { force: true });
      const ran = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '..', 'bin', 'atris.js'), 'engine', 'sweep'], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(ran.status, 0, ran.stderr);
      const checks = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0;
      if (leaked) {
        assert.strictEqual(checks, 1, ran.stdout);
        assert.match(ran.stdout, /nothing was stopped\. run atris engine sweep --apply to stop them\./);
      } else {
        // Nothing leaked and no startup line to fix, so no command is printed and no Node starts.
        assert.strictEqual(checks, 0, ran.stdout);
        assert.match(ran.stdout, /0 look leaked/);
        assert.match(ran.stdout, /\nnothing was stopped\.\n/);
      }
      console.log(`real cleanup preview with ${leaked} leaked: ${checks} launcher check, exit ${ran.status}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status checks the launcher only when it prints a command', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-lazy-launcher-')));
  try {
    const work = path.join(root, 'work');
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    for (const dir of [work, bin, home]) fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.symlinkSync(path.join(__dirname, '..', 'bin', 'atris'), path.join(bin, 'atris'));
    // Each start of this Node adds a line, so the test can count launcher checks.
    const runs = path.join(root, 'runs');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho run >> '${runs}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: [bin, '/bin', '/usr/bin'].join(path.delimiter), HOME: home };
    delete env.NODE_TEST_CONTEXT;
    const probe = `
      const { showStatus } = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'autoland'))});
      const agent = { pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' };
      showStatus(process.cwd(), [], { readSshAgents: () => ({ agents: [agent], referenced: new Set() }), uid: 501, home: ${JSON.stringify(home)} });
    `;
    for (const hourly of [false, true]) {
      if (hourly) {
        // A fresh receipt with a sweep result means the next hourly pass stops the agent.
        const runsDir = path.join(work, 'atris', 'runs');
        fs.mkdirSync(runsDir, { recursive: true });
        fs.writeFileSync(path.join(runsDir, 'autoland-tick-now.json'), JSON.stringify({ at: new Date().toISOString(), ssh_agent_sweep: { stopped: [], failed: [], skipped: [] } }));
      }
      fs.rmSync(runs, { force: true });
      const status = spawnSync(process.execPath, ['-e', probe], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(status.status, 0, status.stderr);
      const checks = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0;
      if (hourly) {
        // No line names the command, so no Node starts to pick its wording.
        assert.match(status.stdout, /leaked ssh-agents on this machine: 1; the next hourly pass stops them/);
        assert.strictEqual(checks, 0, status.stdout);
      } else {
        assert.match(status.stdout, /leaked ssh-agents on this machine: 1; stop them now: atris engine sweep --apply/);
        assert.strictEqual(checks, 1, status.stdout);
      }
      console.log(`real landing status with ${hourly ? 'a live' : 'no'} hourly pass: ${checks} launcher check, exit ${status.status}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const unread of [[], ['process environments'], ['agent sockets'], ['process environments', 'agent sockets']]) {
test(`landing repair advice survives unreadable history and ${unread.join(' and ') || 'a complete agent scan'}`, () => {
  const { showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-unread-repair-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-unread-home-'));
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, RESOURCE_LOG), { recursive: true });
    fs.writeFileSync(path.join(home, '.zshrc'), 'eval "$(ssh-agent -s)"\n');
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], {
        readSshAgents: () => ({ agents: [{ pid: 200, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' }], referenced: new Set(), unread }),
        uid: 501, home, atrisCommand: 'atris', pathAtrisRecordsRuns: true,
      });
    } finally {
      console.log = original;
    }
    const status = out.join('\n');
    assert.match(status, /engine run log: could not read it \(EISDIR\)/);
    assert.doesNotMatch(status, /the startup line below is the one to fix, not an engine/);
    if (unread.length) {
      assert.ok(status.includes(`could not read the ${unread.join(' or the ')}, so some ssh-agents went unchecked`));
      assert.match(status, /leaked ssh-agents on this machine: at least 1/);
    } else {
      assert.doesNotMatch(status, /some ssh-agents went unchecked/);
    }
    assert.match(status, /likely source: ~\/\.zshrc line 1/);
    assert.match(status, /to make that change, run atris engine sweep --fix-startup; it saves the old file beside it first/);
    console.log('real unreadable history repair advice: ' + out.filter((line) => /engine run log|to make that change/.test(line)).map((line) => line.trim()).join(' / '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
}

for (const unread of [['agent sockets'], ['process environments'], ['process list'], ['agent sockets', 'process environments']]) {
test(`the real cleanup command keeps an incomplete ${unread.join(' and ')} recheck count unknown in text, json, and history`, () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-recheck-count-'));
  const preload = path.join(root, 'partial-recheck.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  try {
    fs.writeFileSync(preload, `
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      let reads = 0;
      resource.readSshAgents = () => ({
        agents: [{ pid: 200, ppid: 1, uid: process.getuid(), age_sec: 3600, args: 'ssh-agent -s' }],
        referenced: new Set(++reads === 1 ? [] : [200]),
        unread: reads === 1 ? [] : ${JSON.stringify(unread)},
      });
      process.kill = () => { throw new Error('the referenced agent must never be signalled'); };
    `);
    for (const json of [false, true]) {
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', ...(json ? ['--json'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.status, 0, ran.stderr);
      if (json) {
        const report = JSON.parse(ran.stdout);
        assert.deepStrictEqual(report.stopped, []);
        assert.deepStrictEqual(report.skipped, [200]);
        assert.deepStrictEqual(report.unread, unread);
        assert.ok(!Object.hasOwn(report, 'left'));
        assert.equal(report.history.last_sweep.leaked_ssh_agents, null);
      } else {
        assert.match(ran.stdout, /stopped 0 leaked ssh-agents/);
        assert.match(ran.stdout, /1 skipped because they were in use or gone on the recheck/);
        assert.ok(ran.stdout.includes(`could not read the ${unread.join(' or the ')}`));
        assert.doesNotMatch(ran.stdout, /0 leaked ssh-agents still left/);
        console.log(`partial cleanup recheck exit ${ran.status}: ${ran.stdout.trim()}`);
      }
      const saved = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
      assert.equal(saved.leaked_ssh_agents, null);
      assert.deepStrictEqual(saved.unread, unread);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

for (const failedRead of [1, 2]) {
for (const existingHistory of [false, true]) {
test(`the real cleanup command stops safely when scan ${failedRead} throws with ${existingHistory ? "existing" : "no"} history`, () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-thrown-scan-'));
  const preload = path.join(root, 'thrown-scan.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const signalFile = path.join(root, 'signal-attempted');
  const historyFile = path.join(root, RESOURCE_LOG);
  const previousHistory = JSON.stringify({ at: '2026-10-15T10:00:00.000Z', phase: 'sweep', stopped: [123], failed: [], skipped: [], leaked_ssh_agents: 2 }) + '\n';
  try {
    if (existingHistory) {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(historyFile, previousHistory);
    }
    fs.writeFileSync(preload, `
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      let reads = 0;
      resource.readSshAgents = () => {
        if (++reads === ${failedRead}) throw new Error('process scan unavailable');
        return {
          agents: [{ pid: 200, ppid: 1, uid: process.getuid(), age_sec: 3600, args: 'ssh-agent -s' }],
          referenced: new Set(), unread: [],
        };
      };
      process.kill = () => {
        require('node:fs').writeFileSync(${JSON.stringify(signalFile)}, 'attempted');
        throw new Error('a failed scan must never signal an agent');
      };
    `);
    for (const json of [false, true]) {
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', ...(json ? ['--json'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.error, undefined);
      assert.equal(ran.status, 1, ran.stderr);
      assert.match(ran.stderr, /process scan unavailable/);
      assert.doesNotMatch(ran.stdout, /stopped \d+ leaked ssh-agent|leaked ssh-agents? still left|"left"\s*:/);
      assert.equal(fs.existsSync(signalFile), false);
      if (existingHistory) assert.equal(fs.readFileSync(historyFile, 'utf8'), previousHistory);
      else assert.equal(fs.existsSync(historyFile), false);
      console.log(`failed cleanup scan ${failedRead}, ${json ? 'json' : 'text'}, exit ${ran.status}: ${ran.stderr.trim()}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}
}

test('the real cleanup command preserves history and records rejected stop signals', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-rejected-signal-'));
  const preload = path.join(root, 'rejected-signal.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const historyFile = path.join(root, RESOURCE_LOG);
  const previousHistory = JSON.stringify({ at: '2026-10-15T10:00:00.000Z', phase: 'sweep', stopped: [123], failed: [], skipped: [], leaked_ssh_agents: 2 }) + '\n';
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(preload, `
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      resource.readSshAgents = () => ({
        agents: [{ pid: 200, ppid: 1, uid: process.getuid(), age_sec: 3600, args: 'ssh-agent -s' }],
        referenced: new Set(), unread: [],
      });
      process.kill = (pid, signal) => {
        if (pid !== 200 || signal !== 'SIGTERM') throw new Error('unexpected signal');
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      };
    `);
    for (const json of [false, true]) {
      fs.writeFileSync(historyFile, previousHistory);
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', ...(json ? ['--json'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.error, undefined);
      assert.equal(ran.status, 1, ran.stderr);
      if (json) {
        const report = JSON.parse(ran.stdout);
        assert.deepStrictEqual(report.stopped, []);
        assert.deepStrictEqual(report.failed, [{ pid: 200, code: 'EPERM' }]);
        assert.equal(report.left, 1);
        assert.deepStrictEqual(report.history.last_sweep.failed, [200]);
      } else {
        assert.match(ran.stdout, /stopped 0 leaked ssh-agents/);
        assert.match(ran.stdout, /could not stop pid 200: EPERM/);
        assert.match(ran.stdout, /1 leaked ssh-agent still left/);
      }
      const saved = fs.readFileSync(historyFile, 'utf8');
      assert.equal(saved.slice(0, previousHistory.length), previousHistory);
      const appended = saved.slice(previousHistory.length).trim().split('\n').map(JSON.parse);
      assert.equal(appended.length, 1);
      assert.equal(appended[0].phase, 'sweep');
      assert.deepStrictEqual(appended[0].stopped, []);
      assert.deepStrictEqual(appended[0].failed, [200]);
      assert.equal(appended[0].leaked_ssh_agents, 1);
      console.log(`rejected cleanup signal, ${json ? 'json' : 'text'}, exit ${ran.status}: ${ran.stdout.trim()}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real cleanup command keeps both outcomes when one stop works and one is rejected', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-mixed-signal-'));
  const preload = path.join(root, 'mixed-signal.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const historyFile = path.join(root, RESOURCE_LOG);
  const signalFile = path.join(root, 'signals');
  const previousHistory = JSON.stringify({ at: '2026-10-15T10:00:00.000Z', phase: 'sweep', stopped: [123], failed: [], skipped: [], leaked_ssh_agents: 2 }) + '\n';
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      resource.readSshAgents = () => ({
        agents: [
          { pid: 200, ppid: 1, uid: process.getuid(), age_sec: 3600, args: 'ssh-agent -s' },
          { pid: 201, ppid: 1, uid: process.getuid(), age_sec: 1800, args: 'ssh-agent -s' },
        ],
        referenced: new Set(), unread: [],
      });
      process.kill = (pid, signal) => {
        fs.appendFileSync(${JSON.stringify(signalFile)}, pid + ' ' + signal + '\\n');
        if (pid === 200 && signal === 'SIGTERM') return true;
        if (pid === 201 && signal === 'SIGTERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        throw new Error('unexpected signal');
      };
    `);
    for (const json of [false, true]) {
      fs.writeFileSync(historyFile, previousHistory);
      fs.rmSync(signalFile, { force: true });
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', ...(json ? ['--json'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.error, undefined);
      assert.equal(ran.status, 1, ran.stderr);
      assert.equal(fs.readFileSync(signalFile, 'utf8'), '200 SIGTERM\n201 SIGTERM\n');
      if (json) {
        const report = JSON.parse(ran.stdout);
        assert.deepStrictEqual(report.stopped, [200]);
        assert.deepStrictEqual(report.failed, [{ pid: 201, code: 'EPERM' }]);
        assert.equal(report.left, 1);
        assert.deepStrictEqual(report.history.last_sweep.stopped, [200]);
        assert.deepStrictEqual(report.history.last_sweep.failed, [201]);
      } else {
        assert.match(ran.stdout, /stopped 1 leaked ssh-agent\b/);
        assert.match(ran.stdout, /could not stop pid 201: EPERM/);
        assert.doesNotMatch(ran.stdout, /could not stop pid 200/);
        assert.match(ran.stdout, /^1 leaked ssh-agent still left on this machine$/m);
      }
      const saved = fs.readFileSync(historyFile, 'utf8');
      assert.equal(saved.slice(0, previousHistory.length), previousHistory);
      const appended = saved.slice(previousHistory.length).trim().split('\n').map(JSON.parse);
      assert.equal(appended.length, 1);
      assert.equal(appended[0].phase, 'sweep');
      assert.deepStrictEqual(appended[0].stopped, [200]);
      assert.deepStrictEqual(appended[0].failed, [201]);
      assert.deepStrictEqual(appended[0].skipped, []);
      assert.equal(appended[0].leaked_ssh_agents, 1);
      console.log(`mixed cleanup signals, ${json ? 'json' : 'text'}, exit ${ran.status}: ${ran.stdout.trim()}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly cleanup summary names a stop and a refused stop from one mixed pass', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-ssh-mixed-'));
  try {
    const agent = (pid, age_sec) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
    const agents = [agent(200, 3600), agent(201, 1800)];
    const signals = [];
    const receipt = {};
    runSshAgentSweep(root, receipt, {
      read: () => ({ agents, referenced: new Set(), unread: [] }),
      uid: 501,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 201) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      },
    });
    assert.deepStrictEqual(signals, [[200, 'SIGTERM'], [201, 'SIGTERM']]);
    assert.deepStrictEqual(receipt.ssh_agent_sweep, { stopped: [200], failed: [{ pid: 201, code: 'EPERM' }], skipped: [], left: 1 });
    assert.equal(receipt.ssh_agent_sweep_error, undefined);
    assert.strictEqual(sshAgentSweepNote(receipt), ', stopped 1 leaked ssh-agent, could not stop 1 leaked ssh-agent');
    const saved = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(saved.length, 1);
    assert.deepStrictEqual(saved[0].stopped, [200]);
    assert.deepStrictEqual(saved[0].failed, [201]);
    assert.equal(saved[0].leaked_ssh_agents, 1);
    console.log('mixed hourly cleanup: ' + sshAgentSweepNote(receipt).slice(2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status counts one agent left after a mixed hourly cleanup and says the hourly pass could not stop it', () => {
  const { runSshAgentSweep, showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-mixed-'));
  const agent = (pid, age_sec) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    const receipt = { at: new Date().toISOString() };
    runSshAgentSweep(root, receipt, {
      read: () => ({ agents: [agent(200, 3600), agent(201, 1800)], referenced: new Set(), unread: [] }),
      uid: 501,
      kill: (pid) => {
        if (pid === 201) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      },
    });
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, `autoland-tick-${receipt.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(receipt));
    const leakLine = (agents) => {
      const out = [];
      const original = console.log;
      console.log = (line = '') => out.push(String(line));
      try {
        showStatus(root, [], { atrisCommand: 'atris', readSshAgents: () => ({ agents, referenced: new Set() }), uid: 501 });
      } finally {
        console.log = original;
      }
      return out.find((text) => /leaked ssh-agents on this machine/.test(text));
    };
    // The refused agent is still there; the stopped one is gone.
    const line = leakLine([agent(201, 1800)]);
    assert.ok(line, 'the landing status names the agent left after the mixed pass');
    assert.match(line, /leaked ssh-agents on this machine: 1[;,\s]/);
    assert.match(line, /the last hourly pass could not stop it, so stop it now: atris engine sweep --apply/);
    assert.doesNotMatch(line, /the next hourly pass stops/, 'a refused agent is never promised to the next pass');
    // A new leak since the pass is counted too, and only the refused one is named as refused.
    assert.match(leakLine([agent(201, 1800), agent(202, 1200)]), /on this machine: 2, up from 1 left by the sweep[^;]*; the last hourly pass could not stop 1 of them, so stop them now: atris engine sweep --apply/);
    // Once the refused agent is gone, a new leak goes back to the next pass.
    assert.match(leakLine([agent(202, 1200)]), /on this machine: 1[^;]*; the next hourly pass stops them/);
    const saved = fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(saved.at(-1).leaked_ssh_agents, 1, 'the saved pass and the landing status agree on one left');
    console.log(`landing status after a mixed hourly cleanup: ${line.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the cleanup listing names the agent the last hourly pass could not stop, as the landing status does', () => {
  const { runSshAgentSweep } = require('../commands/autoland');
  const { engineCommand } = require('../commands/engine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-sweep-refused-'));
  const agent = (pid, age_sec) => ({ pid, ppid: 1, uid: 501, age_sec, args: 'ssh-agent -s' });
  try {
    runSshAgentSweep(root, {}, {
      read: () => ({ agents: [agent(200, 3600), agent(201, 1800)], referenced: new Set(), unread: [] }),
      uid: 501,
      kill: (pid) => {
        if (pid === 201) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      },
    });
    const out = [];
    const original = console.log;
    console.log = (line) => out.push(String(line));
    try {
      // The refused agent is still there, and a new one leaked since.
      engineCommand(['sweep'], { root, engineSweep: { read: () => ({ agents: [agent(201, 1800), agent(202, 1200)], referenced: new Set() }), uid: 501, atrisCommand: 'atris' } });
    } finally {
      console.log = original;
    }
    const text = out.join('\n');
    const row = (pid) => text.split('\n').find((line) => line.trim().startsWith(`pid ${pid} `));
    assert.match(row(201), /, the last sweep could not stop it$/);
    assert.doesNotMatch(row(202), /could not stop/, 'a new leak is not named as refused');
    assert.match(text, /last sweep: \d{4}-\d\d-\d\d \d\d:\d\d UTC, stopped 1, could not stop 1/);
    console.log(`cleanup listing after a refused hourly stop:\n${[row(201), row(202), text.split('\n').find((line) => line.startsWith('last sweep:'))].join('\n')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real cleanup command says when the agent it could not stop was also refused by the last sweep', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-repeat-refusal-'));
  const preload = path.join(root, 'repeat-refusal.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const historyFile = path.join(root, RESOURCE_LOG);
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(preload, `
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      resource.readSshAgents = () => ({
        agents: [{ pid: 201, ppid: 1, uid: process.getuid(), age_sec: 1800, args: 'ssh-agent -s' }],
        referenced: new Set(), unread: [],
      });
      process.kill = (pid, signal) => {
        if (pid === 201 && signal === 'SIGTERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        throw new Error('unexpected signal');
      };
    `);
    const sweepAfter = (failed) => {
      fs.writeFileSync(historyFile, JSON.stringify({ at: '2026-10-15T10:00:00.000Z', phase: 'sweep', stopped: [200], failed, skipped: [], leaked_ssh_agents: 1 }) + '\n');
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply'], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.error, undefined);
      assert.equal(ran.status, 1, ran.stderr);
      return ran.stdout;
    };
    const stuck = sweepAfter([201]);
    assert.match(stuck, /^could not stop pid 201: EPERM; the last sweep at 2026-10-15 10:00 UTC could not stop it either$/m);
    const fresh = sweepAfter([]);
    assert.match(fresh, /^could not stop pid 201: EPERM$/m, 'a first refusal is not called a repeat');
    const otherPid = sweepAfter([999]);
    assert.match(otherPid, /^could not stop pid 201: EPERM$/m, 'a refusal of another agent is not this one');
    console.log(`repeat refusal, exit 1:\n${stuck.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cleanup saves the agents the last sweep also could not stop, in its report, its saved line, and the hourly receipt', () => {
  const { spawnSync } = require('node:child_process');
  const { runSshAgentSweep } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-refused-again-'));
  const preload = path.join(root, 'refused-again.cjs');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const historyFile = path.join(root, RESOURCE_LOG);
  const lines = () => fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(JSON.parse);
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(preload, `
      const resource = require(${JSON.stringify(require.resolve('../lib/engine-resource'))});
      resource.readSshAgents = () => ({
        agents: [{ pid: 201, ppid: 1, uid: process.getuid(), age_sec: 1800, args: 'ssh-agent -s' }],
        referenced: new Set(), unread: [],
      });
      process.kill = (pid, signal) => {
        if (pid === 201 && signal === 'SIGTERM') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        throw new Error('unexpected signal');
      };
    `);
    const sweepAfter = (failed) => {
      fs.writeFileSync(historyFile, JSON.stringify({ at: '2026-10-15T10:00:00.000Z', phase: 'sweep', stopped: [], failed, skipped: [], leaked_ssh_agents: 1 }) + '\n');
      const ran = spawnSync(process.execPath, ['--require', preload, cli, 'engine', 'sweep', '--apply', '--json'], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ATRIS_AUTO_UPDATE: 'off' },
      });
      assert.equal(ran.status, 1, ran.stderr);
      return { report: JSON.parse(ran.stdout), saved: lines().at(-1) };
    };
    const stuck = sweepAfter([201]);
    assert.deepStrictEqual(stuck.report.refused_again, [201]);
    assert.deepStrictEqual(stuck.saved.refused_again, [201]);
    const fresh = sweepAfter([]);
    assert.equal(fresh.report.refused_again, undefined, 'a first refusal is not saved as a repeat');
    assert.equal(fresh.saved.refused_again, undefined);
    // The hourly pass carries it into its receipt, where the landing status reads.
    fs.rmSync(historyFile);
    const agent = { pid: 201, ppid: 1, uid: 501, age_sec: 1800, args: 'ssh-agent -s' };
    const hourly = () => {
      const receipt = {};
      runSshAgentSweep(root, receipt, {
        read: () => ({ agents: [agent], referenced: new Set(), unread: [] }),
        uid: 501,
        kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
      });
      return receipt.ssh_agent_sweep;
    };
    assert.equal(hourly().refused_again, undefined);
    assert.deepStrictEqual(hourly().refused_again, [201]);
    assert.deepStrictEqual(lines().map((line) => line.refused_again || null), [null, [201]]);
    console.log(`refused again: cli report ${JSON.stringify(stuck.report.refused_again)}, saved ${JSON.stringify(stuck.saved.refused_again)}; hourly lines ${JSON.stringify(lines().map((line) => line.refused_again || null))}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the landing status says the last two hourly passes could not stop an agent refused twice in a row', () => {
  const { runSshAgentSweep, showStatus } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-status-refused-twice-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  const runsDir = path.join(root, 'atris', 'runs');
  let hour = 0;
  // One real hourly pass where every stop is refused, saved as the newest receipt.
  const pass = (pids) => {
    const receipt = { at: new Date().toISOString() };
    runSshAgentSweep(root, receipt, {
      read: () => ({ agents: pids.map(agent), referenced: new Set(), unread: [] }),
      uid: 501,
      kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    });
    hour += 1;
    fs.writeFileSync(path.join(runsDir, `autoland-tick-2026-10-15T${String(hour).padStart(2, '0')}.json`), JSON.stringify(receipt));
  };
  const leakLine = (pids) => {
    const out = [];
    const original = console.log;
    console.log = (line = '') => out.push(String(line));
    try {
      showStatus(root, [], { atrisCommand: 'atris', readSshAgents: () => ({ agents: pids.map(agent), referenced: new Set() }), uid: 501 });
    } finally {
      console.log = original;
    }
    return out.find((text) => /leaked ssh-agents on this machine/.test(text));
  };
  try {
    require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(runsDir, { recursive: true });
    pass([201]);
    assert.match(leakLine([201]), /; the last hourly pass could not stop it, so stop it now: atris engine sweep --apply/);
    pass([201]);
    const twice = leakLine([201]);
    assert.match(twice, /; the last two hourly passes could not stop it, so stop it now: atris engine sweep --apply/);
    // A newly refused agent beside the stuck one is counted apart.
    pass([201, 203]);
    const mixed = leakLine([201, 203]);
    assert.match(mixed, /; the last hourly pass could not stop them \(1 of them twice in a row\), so stop them now: atris engine sweep --apply/);
    console.log(`landing status after two refused hourly passes: ${twice.trim()}\nwith a new refusal beside it: ${mixed.trim()}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the hourly cleanup summary says an agent could not be stopped twice in a row, as the landing status does', () => {
  const { runSshAgentSweep, sshAgentSweepNote } = require('../commands/autoland');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-summary-refused-twice-'));
  const agent = (pid) => ({ pid, ppid: 1, uid: 501, age_sec: 3600, args: 'ssh-agent -s' });
  // One real hourly pass where every stop is refused.
  const pass = (pids) => {
    const receipt = {};
    runSshAgentSweep(root, receipt, {
      read: () => ({ agents: pids.map(agent), referenced: new Set(), unread: [] }),
      uid: 501,
      kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    });
    return sshAgentSweepNote(receipt);
  };
  try {
    assert.strictEqual(pass([201]), ', could not stop 1 leaked ssh-agent');
    const twice = pass([201]);
    assert.strictEqual(twice, ', could not stop 1 leaked ssh-agent twice in a row');
    const mixed = pass([201, 203]);
    assert.strictEqual(mixed, ', could not stop 2 leaked ssh-agents (1 of them twice in a row)');
    console.log(`hourly summary after two refused passes: ${twice.slice(2)}\nwith a new refusal beside it: ${mixed.slice(2)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
