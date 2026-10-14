const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { stopMember, readBoard, isAlive } = require('../lib/member-board');
const { withMissionFullJson } = require('./helpers/mission-json');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const RUNNER_ENV = [
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];
const TOKEN = '0123456789abcdef';

function cliEnv(dir, extra) {
  const clean = scrubAgentEnv(process.env);
  for (const name of RUNNER_ENV) delete clean[name];
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...clean,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db'),
    CODEX_HOME: path.join(home, '.codex'),
    ATRIS_MACHINE_ROSTER_PATH: path.join(home, 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, 'roster.md'),
    ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'roster-sessions'),
    ...extra,
  };
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

test('member stop ends a live codex mission run started by the real runner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stop-codex-'));
  const binDir = path.join(dir, 'bin');
  const pidFile = path.join(dir, 'codex.pid');
  const progress = path.join(dir, 'progress');
  fs.mkdirSync(binDir, { recursive: true });
  // A codex that takes the event flags, then works until it is stopped.
  fs.writeFileSync(path.join(binDir, 'codex'), [
    '#!/bin/sh',
    'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "      --json"; echo "  -o, --output-last-message <FILE>"; exit 0; fi',
    `echo $$ > "${pidFile}"`,
    'sleep 60',
  ].join('\n'), { mode: 0o755 });
  const env = cliEnv(dir, {
    PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    ATRIS_PROGRESS_DIR: progress,
  });
  const start = spawnSync(process.execPath, [cliPath, ...withMissionFullJson([
    'mission', 'start', 'tidy the readme', '--owner', 'growth', '--runner', 'codex', '--no-verify', '--json',
  ])], { cwd: dir, encoding: 'utf8', timeout: 30000, env });
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const mission = JSON.parse(start.stdout).mission;

  const runner = spawn(process.execPath, [cliPath, ...withMissionFullJson([
    'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json',
  ])], { cwd: dir, env, stdio: 'ignore' });
  const exited = new Promise((resolve) => runner.on('exit', resolve));
  const logFile = path.join(progress, 'growth.log');
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  let leader = null;
  try {
    assert.ok(await waitFor(() => fs.existsSync(pidFile)), `codex never started:\n${readLog()}`);
    const m = /started: \[pid (\d+) engine codex run [0-9a-f]{16}\] tidy the readme/.exec(readLog());
    assert.ok(m, `the started line names the codex run:\n${readLog()}`);
    leader = Number(m[1]);
    const codexPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.equal(readBoard({ dir: progress })[0].state, 'working');

    const result = await stopMember('growth', { dir: progress, graceMs: 3000 });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /^stopped growth after \d+s of work/);
    assert.ok(await waitFor(() => !isAlive(codexPid)), 'codex itself is gone');
    assert.ok(await waitFor(() => !isAlive(leader)), 'the shell that led the run is gone');
    await exited;
    assert.match(readLog(), /finished: stopped/);
    assert.equal(readBoard({ dir: progress, all: true })[0].state, 'stopped');
    assert.equal((await stopMember('growth', { dir: progress })).message, 'nothing running', 'second stop finds nothing');
  } finally {
    if (leader) killGroup(leader);
    try { runner.kill('SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A detached shell standing in for a run, checked against the real process list.
async function shellRun(script) {
  const child = spawn('sh', ['-lc', script], { detached: true, stdio: 'ignore' });
  // ps reports start times to the second; let the clock pass the spawn.
  await new Promise((r) => setTimeout(r, 200));
  return child;
}

function logDir(member, line) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stop-codex-shape-'));
  fs.writeFileSync(path.join(dir, `${member}.log`), `${new Date().toISOString()} m-1 ${line}\n`);
  return dir;
}

test('member stop leaves a shell alone unless the codex marker opens its script', async () => {
  const cases = [
    ['marker not first', `echo atris-run builder ${TOKEN}; sleep 60; exit $?`, 'codex'],
    ['other member', `: atris-run someone ${TOKEN}; sleep 60; exit $?`, 'codex'],
    ['claude run never leads with a shell', `: atris-run builder ${TOKEN}; sleep 60; exit $?`, 'claude'],
  ];
  for (const [label, script, engine] of cases) {
    const child = await shellRun(script);
    const dir = logDir('builder', `started: [pid ${child.pid} engine ${engine} run ${TOKEN}] x`);
    try {
      const result = await stopMember('builder', { dir, graceMs: 50 });
      assert.equal(result.message, 'nothing running', label);
      assert.ok(isAlive(child.pid), `${label}: the shell keeps running`);
    } finally {
      killGroup(child.pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
