'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchAtris } = require('../commands/watch');

function runWatchInDir(args, tmpDir) {
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
    process.argv = ['node', 'atris', 'watch', ...args];
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

  return {
    code: exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

test('watch stop outputs stderr when mission stop child process fails with stderr', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-stop-test-'));
  try {
    const stateDir = path.join(tmpDir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const mission = {
      id: 'watch-mission-id-1',
      slug: 'my-watch',
      lane: 'watch',
      status: 'running',
      metadata: { watch_slug: 'my-watch' },
    };
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify(mission) + '\n');
    fs.mkdirSync(path.join(stateDir, 'mission_events.jsonl'));

    const result = runWatchInDir(['stop', 'my-watch'], tmpDir);

    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /EISDIR/);
    assert.doesNotMatch(result.stderr, /^failed to stop watch "my-watch"\.$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
