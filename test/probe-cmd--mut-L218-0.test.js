'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeCommand } = require('../commands/probe');

test('calendar followed by help prints usage and exits before checking login', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-calendar-help-'));
  const savedEnv = { ...process.env };
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const stdout = [];
  const stderr = [];
  const exits = [];
  const stopped = new Error('help exited');
  t.after(() => {
    process.env = savedEnv;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env = { HOME: home };
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  process.exit = (code) => {
    exits.push(code);
    throw stopped;
  };

  // If help is swallowed, stop parsing before credentials or transport run.
  const argv = ['--calendar', '--help'];
  Object.defineProperty(argv, 2, {
    get() { throw new Error('parsing continued past help'); },
  });

  let caught;
  try {
    await probeCommand(argv);
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(stdout, [
    'Usage: atris probe [--calendar] [--business <id>] [--model atris:fast] [--member-slug <slug>] [--member-id <id>] [--message "..."]',
  ]);
  assert.deepEqual(stderr, []);
  assert.deepEqual(exits, [0]);
  assert.equal(caught, stopped);
});
