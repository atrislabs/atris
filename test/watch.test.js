const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {}, timeout = 15000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function readLatestMission(dir) {
  const file = path.join(dir, '.atris', 'state', 'missions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('watch is a known command with proactive agent help', () => {
  const dir = makeTempDir();
  try {
    assert.ok(knownCommands.includes('watch'));
    const res = runCli(['watch', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /atris watch "<sentence>"/);
    assert.match(res.stdout, /atris watch list/);
    assert.match(res.stdout, /atris watch stop/);
    assert.doesNotMatch(res.stdout, /atris sync --watch/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('watch create, list, and stop manage always-on watch-lane missions', () => {
  const dir = makeTempDir();
  try {
    const create = runCli([
      'watch',
      'prod error rate in logs',
      '--every',
      '15m',
      '--name',
      'prod-errors',
    ], { cwd: dir });
    assert.equal(create.status, 0, create.stderr || create.stdout);
    assert.match(create.stdout, /watching prod error rate in logs every 15m\./);
    assert.match(create.stdout, /today's journal under ## Notes/);
    assert.match(create.stdout, /\.atris\/state\/watch\/prod-errors\.json/);

    const mission = readLatestMission(dir);
    assert.equal(mission.lane, 'watch');
    assert.equal(mission.runner, 'claude');
    assert.equal(mission.cadence, '15m');
    assert.equal(mission.always_on, true);
    assert.equal(mission.owner, 'watcher');
    assert.equal(mission.metadata?.watch_slug, 'prod-errors');
    assert.equal(mission.metadata?.notify, 'journal');
    assert.match(mission.objective, /compare to last tick state under \.atris\/state\/watch\/prod-errors\.json/);

    const list = runCli(['watch', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /prod-errors/);
    assert.match(list.stdout, /15m/);
    assert.match(list.stdout, /never/);

    const stop = runCli(['watch', 'stop', 'prod-errors'], { cwd: dir });
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);
    assert.match(stop.stdout, /stopped watch prod-errors\./);

    const listAfter = runCli(['watch', 'list'], { cwd: dir });
    assert.equal(listAfter.status, 0, listAfter.stderr || listAfter.stdout);
    assert.match(listAfter.stdout, /no active watches\./);

    const stopped = readLatestMission(dir);
    assert.equal(stopped.status, 'stopped');
  } finally {
    cleanupTempDir(dir);
  }
});
