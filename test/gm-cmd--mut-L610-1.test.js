'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gmCommand: runCommand } = require('../commands/gm');

test('watch mode polls and announces new durable missions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-'));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origSetInterval = global.setInterval;
  const origLog = console.log;
  const logs = [];

  let capturedPoll;
  global.setInterval = (fn) => {
    capturedPoll = fn;
    return { unref() {} };
  };
  console.log = (...args) => logs.push(args.join(' '));

  try {
    process.env.HOME = tmp;
    process.chdir(tmp);

    const watchPromise = runCommand('--watch', '--no-seed');
    setImmediate(() => {
      process.emit('SIGINT');
    });
    await watchPromise;

    const stateDir = path.join(tmp, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const mission = {
      id: 'm-watch-1',
      status: 'active',
      objective: 'verify durable mission event',
      created_at: '2026-10-23T12:00:00.000Z',
    };
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify(mission) + '\n');

    logs.length = 0;
    await capturedPoll();

    assert.ok(logs.some(line => line.includes('[mission]') && line.includes('m-watch-1')));
  } finally {
    global.setInterval = origSetInterval;
    console.log = origLog;
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
