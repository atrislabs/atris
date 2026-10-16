'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const agentPid = 463001;
const megabyte = 1024 * 1024;

// The production reader still launches real children with its own options.
// Only their input program is synthetic, so no host environment is captured.
function readerFixture(t, scenario = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-output-buffer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'safe-readers.cjs');
  const metadata = path.join(root, 'reader-metadata.json');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const real = cp.spawnSync;
    const scenario = ${JSON.stringify(scenario)};
    const readings = [];
    cp.spawnSync = (command, args, options) => {
      const tool = path.basename(command);
      if (tool !== 'ps' && tool !== 'lsof') return real(command, args, options);
      const stage = tool === 'lsof' ? 'sockets' : args.includes('-E') ? 'environments' : 'processes';
      const failure = stage === (scenario.failStage || 'environments') ? scenario.failure : null;
      let program;
      if (failure === 'nonzero') program = 'process.exit(7)';
      else if (failure === 'signal') program = "process.kill(process.pid, 'SIGTERM')";
      else {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
        const head = stage === 'processes'
          ? '${agentPid} 1 ' + uid + ' 01:00:00 ssh-agent -s\\n'
          : stage === 'environments' ? '463002 fixture SAFE_MARKER=fixture\\n'
          : 'p${agentPid}\\nn/owned-fixture/agent.sock\\n';
        const padding = failure === 'overflow' ? 9 * ${megabyte}
          : scenario.large === stage ? 2 * ${megabyte} : 0;
        const tail = stage === 'environments' && scenario.large === stage
          ? '\\n463003 fixture SSH_AGENT_PID=463004\\n' : head;
        program = "process.stdout.write(' '.repeat(" + padding + '));' +
          'process.stdout.write(' + JSON.stringify(tail) + ');';
      }
      const executable = failure === 'launch' ? ${JSON.stringify(path.join(root, 'missing-node'))} : process.execPath;
      const reading = real(executable, ['-e', program], options);
      readings.push({ stage, status: reading.status, signal: reading.signal,
        error_code: reading.error?.code || null, stdout_bytes: Buffer.byteLength(reading.stdout || ''),
        timeout: options.timeout, maxBuffer: options.maxBuffer ?? null });
      return reading;
    };
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(metadata)}, JSON.stringify(readings)));
  `);
  const env = { ...process.env, ATRIS_TEST_STATE_DIR: path.join(root, 'state'),
    ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db'),
    ATRIS_RSI_STATE: path.join(root, 'rsi'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_TEST_REAL_HOME;
  delete env.SSH_AGENT_PID;
  delete env.SSH_AUTH_SOCK;
  function run(args) {
    const child = spawnSync(process.execPath, ['--require', preload, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return { stdout: child.stdout, readings: JSON.parse(fs.readFileSync(metadata, 'utf8')) };
  }
  return {
    probe() {
      const child = run(['-e', `
        const { readSshAgents } = require(${JSON.stringify(path.join(repo, 'lib', 'engine-resource.js'))});
        const scan = readSshAgents();
        process.stdout.write(JSON.stringify({ ...scan, referenced: [...scan.referenced] }));
      `]);
      return { scan: JSON.parse(child.stdout), readings: child.readings };
    },
    cli(...args) {
      return run([path.join(repo, 'bin', 'atris.js'), 'engine', 'sweep', ...args]);
    },
  };
}

test('a real child can provide more than one MiB of process environments', (t) => {
  const { scan, readings } = readerFixture(t, { large: 'environments' }).probe();
  assert.deepEqual(scan.unread, []);
  assert.equal(scan.agents.length, 1);
  assert.equal(scan.agents[0].pid, agentPid);
  assert.deepEqual(scan.referenced, [463004]);
  const environment = readings.find((reading) => reading.stage === 'environments');
  assert.ok(environment.stdout_bytes > megabyte);
  assert.equal(environment.status, 0);
  assert.equal(environment.timeout, 3000);
});

test('the complete process list also retains rows beyond the old output allowance', (t) => {
  const { scan, readings } = readerFixture(t, { large: 'processes' }).probe();
  assert.deepEqual(scan.unread, []);
  assert.equal(scan.agents.length, 1);
  assert.equal(scan.agents[0].pid, agentPid);
  assert.ok(readings.find((reading) => reading.stage === 'processes').stdout_bytes > megabyte);
});

test('the actual CLI keeps a large complete scan available', (t) => {
  const { stdout } = readerFixture(t, { large: 'environments' }).cli('--json');
  const report = JSON.parse(stdout);
  assert.equal(report.running, 1);
  assert.deepEqual(report.unread, []);
});

test('output beyond the new finite allowance leaves the process list unknown', (t) => {
  const { scan, readings } = readerFixture(t, { failure: 'overflow', failStage: 'processes' }).probe();
  assert.deepEqual(scan.unread, ['process list']);
  assert.deepEqual(scan.agents, []);
  assert.equal(readings[0].error_code, 'ENOBUFS');
  assert.ok(readings[0].stdout_bytes < 9 * megabyte);
  assert.equal(readings[0].timeout, 3000);
});

test('the actual CLI warns when a process-environment read exceeds the cap', (t) => {
  const { stdout, readings } = readerFixture(t, { failure: 'overflow' }).cli();
  assert.match(stdout, /could not read the process environments for every process/);
  assert.match(stdout, /the leak count may be incomplete/);
  assert.match(stdout, /nothing was stopped/);
  assert.equal(readings.find((reading) => reading.stage === 'environments').error_code, 'ENOBUFS');
});

test('a real nonzero child keeps process environments unknown', (t) => {
  const { scan, readings } = readerFixture(t, { failure: 'nonzero' }).probe();
  assert.deepEqual(scan.unread, ['process environments']);
  assert.ok(scan.referenced.includes(agentPid));
  assert.equal(readings.find((reading) => reading.stage === 'environments').status, 7);
});

test('a real launch failure keeps process environments unknown', (t) => {
  const { scan, readings } = readerFixture(t, { failure: 'launch' }).probe();
  assert.deepEqual(scan.unread, ['process environments']);
  assert.ok(scan.referenced.includes(agentPid));
  assert.equal(readings.find((reading) => reading.stage === 'environments').error_code, 'ENOENT');
});

test('a signaled child keeps process environments unknown', (t) => {
  const { scan, readings } = readerFixture(t, { failure: 'signal' }).probe();
  assert.deepEqual(scan.unread, ['process environments']);
  assert.ok(scan.referenced.includes(agentPid));
  assert.equal(readings.find((reading) => reading.stage === 'environments').signal, 'SIGTERM');
});
