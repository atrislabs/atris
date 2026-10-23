'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchAtris, slugify } = require('../commands/watch');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-cmd-test-'));
}

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

test('slugify transforms strings into clean identifiers with length and fallback bounds', () => {
  assert.strictEqual(slugify('Hello World!'), 'hello-world');
  assert.strictEqual(slugify('---multiple---dashes---'), 'multiple-dashes');
  assert.strictEqual(slugify('Error Rate in Production Logs (API)'), 'error-rate-in-production-logs-api');
  assert.strictEqual(slugify('a'.repeat(60)), 'a'.repeat(48));
  assert.strictEqual(slugify(''), 'watch');
  assert.strictEqual(slugify(null), 'watch');
  assert.strictEqual(slugify(undefined), 'watch');
  assert.strictEqual(slugify('!@#$%^&*()'), 'watch');
});

test('watchAtris displays command help and options on help flags', () => {
  const tmpDir = makeTempDir();
  try {
    for (const flag of ['--help', '-h', 'help']) {
      const result = runWatchInDir([flag], tmpDir);
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stderr, '');
      assert.match(result.stdout, /usage: atris watch "<sentence>"/);
      assert.match(result.stdout, /atris watch list/);
      assert.match(result.stdout, /atris watch stop <slug>/);
      assert.match(result.stdout, /turn one sentence into an always-on claude watch mission\./);
      assert.match(result.stdout, /--every cadence\s+how often to check/);
      assert.match(result.stdout, /--name slug\s+stable watch name/);
      assert.match(result.stdout, /--notify channel\s+journal \(default\) or imessage/);
      assert.match(result.stdout, /looking for the old file-sync watcher\? use: atris sync --watch/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('watchAtris validates arguments and rejects missing or invalid inputs', () => {
  const tmpDir = makeTempDir();
  try {
    const missingSentence = runWatchInDir([], tmpDir);
    assert.strictEqual(missingSentence.code, 2);
    assert.match(missingSentence.stderr, /^usage: atris watch "<sentence>"/);

    const invalidEvery = runWatchInDir(['check latency', '--every', '2h'], tmpDir);
    assert.strictEqual(invalidEvery.code, 2);
    assert.match(invalidEvery.stderr, /--every must be one of: 15m, 1h, 4h/);

    const invalidNotify = runWatchInDir(['check latency', '--notify', 'webhook'], tmpDir);
    assert.strictEqual(invalidNotify.code, 2);
    assert.match(invalidNotify.stderr, /--notify must be one of: journal, imessage/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('watchAtris creates a watch mission and lists active watches', () => {
  const tmpDir = makeTempDir();
  try {
    const initialList = runWatchInDir(['list'], tmpDir);
    assert.strictEqual(initialList.code, 0);
    assert.match(initialList.stdout, /no active watches\./);

    const created = runWatchInDir([
      'api error spike',
      '--every', '15m',
      '--name', 'api-errors',
      '--notify', 'imessage',
    ], tmpDir);

    assert.strictEqual(created.code, 0);
    assert.match(created.stdout, /watching api error spike every 15m\./);
    assert.match(created.stdout, /reports land in imessage when the pulse picks it up\./);
    assert.match(created.stdout, /state file: \.atris\/state\/watch\/api-errors\.json/);
    assert.match(created.stdout, /stop with: atris watch stop api-errors/);
    assert.ok(fs.existsSync(path.join(tmpDir, '.atris', 'state', 'watch')));

    const activeList = runWatchInDir(['list'], tmpDir);
    assert.strictEqual(activeList.code, 0);
    assert.match(activeList.stdout, /name\s+cadence\s+last tick\s+last report/);
    assert.match(activeList.stdout, /api-errors\s+15m\s+never\s+none yet/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
