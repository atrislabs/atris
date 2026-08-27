'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { ACCOUNT_GLOBAL_MESSAGE } = require('../lib/account-bound');
const { requestStop, watchStopFile, writeState } = require('../commands/autopilot-front');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-dogfood-pass4-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function titlesFromTodo(dir) {
  const todo = path.join(dir, 'atris', 'TODO.md');
  if (!fs.existsSync(todo)) return '';
  return fs.readFileSync(todo, 'utf8');
}

test('29: start --help in a temp init dir prints usage and files no task', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    const before = titlesFromTodo(dir);
    assert.doesNotMatch(before, /First useful step: start --help/);

    for (const args of [['start', '--help'], ['start', '-h'], ['start', 'help'], ['go', '--help']]) {
      const res = runCli(args, { cwd: dir });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris /i);
      assert.doesNotMatch(res.stdout + res.stderr, /First useful step|Got it\. I saved/i);
    }

    const after = titlesFromTodo(dir);
    assert.doesNotMatch(after, /First useful step: (start|go) --help/);
    const listed = runCli(['task', 'list', '--json'], { cwd: dir });
    if (listed.status === 0 && listed.stdout.trim()) {
      const body = JSON.parse(listed.stdout);
      const titles = (body.tasks || []).map((row) => row.title);
      assert.ok(!titles.some((title) => /(start|go) --help/.test(title)), titles.join(' | '));
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('30: autopilot --json prints status and does not spawn', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);

    for (const args of [
      ['autopilot', '--json'],
      ['autopilot', '--json', '--once'],
    ]) {
      const res = runCli(args, { cwd: dir, timeout: 5000 });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      const body = JSON.parse(res.stdout);
      assert.equal(body.ok, false);
      assert.equal(body.command, 'autopilot');
      assert.equal(body.running, false);
      assert.match(String(body.error || body.usage || ''), /--yes|usage/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Autopilot on|Takeoff|mission_started/i);
    }

    const once = runCli(['autopilot', '--once'], { cwd: dir, timeout: 5000 });
    assert.equal(once.status, 2, once.stdout + once.stderr);
    assert.match(once.stderr + once.stdout, /keep working until you stop|next: atris autopilot --yes/i);
    assert.doesNotMatch(once.stderr + once.stdout, /Usage: atris autopilot/);
    assert.doesNotMatch(once.stdout + once.stderr, /Autopilot on|Takeoff|mission_started/i);

    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'autopilot.json')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('30: autopilot stop kills the current-leg child', async () => {
  const dir = makeTempDir();
  const live = [];
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
    });
    live.push(child);
    const stopWatch = watchStopFile(dir, child, { intervalMs: 20 });
    requestStop(dir);
    const watched = await new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    stopWatch();
    assert.ok(watched.signal === 'SIGTERM' || watched.exitCode !== 0);

    const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
    });
    live.push(orphan);
    writeState(dir, {
      pid: 999999999,
      child_pid: orphan.pid,
      started_at: new Date().toISOString(),
      legs: 1,
      current_leg: 'test sleeper',
    });
    const res = runCli(['autopilot', 'stop'], { cwd: dir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Stopping autopilot/);
    const stopped = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 3000);
      orphan.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal });
      });
    });
    assert.equal(stopped.timeout, undefined, 'current-leg child still alive after stop');
    assert.ok(stopped.signal === 'SIGTERM' || stopped.exitCode !== 0);
  } finally {
    for (const proc of live) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    cleanupTempDir(dir);
  }
});

test('31/32: unbound live writes and chat scan do not network or read home runs', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.atris', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'runs', 'ax-play-home-canary.log'), [
    'pro › home canary prompt',
    'error: home canary should stay unread',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
    token: 'test-token',
    email: 'dogfood@example.com',
  }));

  try {
    const ship = runCli(['business', 'ship', 'A neighborhood coffee cart'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_HOME: home,
        ATRIS_API_URL: 'http://127.0.0.1:9',
        ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(ship.status, 2, ship.stdout + ship.stderr);
    assert.match(`${ship.stderr}${ship.stdout}`, /account-global; pass --account to continue/);
    assert.doesNotMatch(`${ship.stderr}${ship.stdout}`, /Shipping business|ECONNREFUSED/);

    const terminal = runCli(['terminal', '--json'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_HOME: home,
        ATRIS_API_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(terminal.status, 2, terminal.stdout + terminal.stderr);
    const terminalBody = JSON.parse(terminal.stdout);
    assert.equal(terminalBody.ok, false);
    assert.match(String(terminalBody.usage || ''), /atris terminal/);
    assert.doesNotMatch(terminal.stdout + terminal.stderr, /Waking EC2|ECONNREFUSED|--json not found/);

    const site = runCli(['site', 'deploy', 'dist', '--name', 'demo-site'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_HOME: home,
        ATRIS_API_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(site.status, 2, site.stdout + site.stderr);
    assert.match(`${site.stderr}${site.stdout}`, /account-global; pass --account to continue/);
    assert.doesNotMatch(`${site.stderr}${site.stdout}`, /deploying|ECONNREFUSED|live at/);

    const fleet = runCli(['fleet-report', '--help'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_HOME: home,
        ATRIS_API_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(fleet.status, 2, fleet.stdout + fleet.stderr);
    assert.match(fleet.stdout + fleet.stderr, /Usage: atris fleet-report/);
    assert.doesNotMatch(fleet.stdout + fleet.stderr, /Not logged in|ECONNREFUSED|Fleet daily report/);

    const scan = runCli(['chat', 'scan', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.notEqual(scan.status, 0);
    assert.doesNotMatch(scan.stdout + scan.stderr, /home canary|ax-play-home-canary/);

    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'ax-play-local.log'), 'pro › local only\n');

    const scoped = runCli(['chat', 'scan', '--json', '--no-write'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.equal(scoped.status, 0, scoped.stderr + scoped.stdout);
    const scopedBody = JSON.parse(scoped.stdout);
    assert.equal(scopedBody.scope, 'workspace');
    const dirs = (scopedBody.sources && scopedBody.sources.ax_dirs) || [];
    assert.ok(dirs.some((item) => item.includes(path.join(dir, 'atris', 'runs'))));
    assert.ok(!dirs.some((item) => item.includes(path.join(home, '.atris', 'runs'))));
    assert.doesNotMatch(scoped.stdout, /home canary/);

    const homeScan = runCli(['chat', 'scan', '--json', '--global', '--no-write'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.equal(homeScan.status, 2, homeScan.stdout + homeScan.stderr);
    assert.match(`${homeScan.stderr}${homeScan.stdout}`, /account-global; pass --account to continue/);
    assert.equal(`${homeScan.stderr}${homeScan.stdout}`.includes(ACCOUNT_GLOBAL_MESSAGE), true);
    assert.doesNotMatch(homeScan.stdout + homeScan.stderr, /home canary/);
  } finally {
    cleanupTempDir(dir);
  }
});
