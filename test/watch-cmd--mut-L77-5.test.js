'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchAtris } = require('../commands/watch');

function runList(tmpDir) {
  const origArgv = process.argv;
  const origExit = process.exit;
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origLog = console.log;
  const origError = console.error;

  const stdout = [];
  const stderr = [];
  let exitCode = null;

  class ExitSignal extends Error {
    constructor(code) {
      super(`exit ${code}`);
      this.code = code;
    }
  }

  try {
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    process.argv = ['node', 'atris', 'watch', 'list'];
    process.exit = (code) => {
      exitCode = code;
      throw new ExitSignal(code);
    };
    console.log = (...items) => stdout.push(items.join(' '));
    console.error = (...items) => stderr.push(items.join(' '));

    try {
      watchAtris();
    } catch (err) {
      if (!(err instanceof ExitSignal)) {
        throw err;
      }
    }
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    process.argv = origArgv;
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
  }

  return { code: exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('list shows one minute ago for a tick 90 seconds old, not just now', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-mut-'));
  try {
    const stateDir = path.join(tmpDir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const mission = {
      schema: 'atris.mission.v1',
      id: 'm1',
      slug: 'probe',
      objective: 'x',
      owner: 'watcher',
      status: 'active',
      cadence: '15m',
      lane: 'watch',
      always_on: true,
      last_tick_at: new Date(Date.now() - 90 * 1000).toISOString(),
      metadata: {
        watch: true,
        watch_slug: 'probe',
        watch_sentence: 'check something',
        watch_state_path: '.atris/state/watch/probe.json',
        notify: 'journal',
      },
    };
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify(mission) + '\n');

    const result = runList(tmpDir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /probe\s+15m\s+1m ago/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
