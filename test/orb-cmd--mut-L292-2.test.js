'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

const mod = require('../commands/orb');

test('dispatch rejects when running jobs reach the concurrency limit', async () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-')));
  fs.mkdirSync(path.join(tmpDir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'atris.md'), '# atris\n');
  fs.writeFileSync(path.join(tmpDir, 'now.md'), '# Now\n');

  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const origSpawn = cp.spawn;
  const origStdin = process.stdin;
  const origStdout = process.stdout;
  const origLog = console.log;

  process.chdir(tmpDir);
  process.env.HOME = tmpDir;

  const stdinMock = new PassThrough();
  stdinMock.isTTY = true;
  const stdoutMock = new PassThrough();
  stdoutMock.isTTY = true;

  Object.defineProperty(process, 'stdin', { value: stdinMock, configurable: true, writable: true });
  Object.defineProperty(process, 'stdout', { value: stdoutMock, configurable: true, writable: true });

  let spawnCount = 0;
  cp.spawn = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.pid = 1000 + spawnCount;
    child.unref = () => {};
    return child;
  };

  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));

  async function waitFor(predicate) {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const runCommand = mod[Object.keys(mod)[0]];

  try {
    const runnerPromise = runCommand([]);
    await waitFor(() => logs.length > 0);
    stdinMock.write('task1\n');
    await waitFor(() => logs.some((l) => l.includes('task1')));
    stdinMock.write('task2\n');
    await waitFor(() => logs.some((l) => l.includes('task2')));
    stdinMock.write('task3\n');
    await waitFor(() => logs.some((l) => l.includes('task3')));
    stdinMock.write('task4\n');
    await waitFor(() => logs.some((l) => l.includes('task4') || l.includes('that will have to wait')));
    stdinMock.write('q\n');
    await runnerPromise;

    assert.equal(logs.some((line) => line.includes('that will have to wait - 3 jobs running')), true);
  } finally {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true, writable: true });
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true, writable: true });
    console.log = origLog;
    cp.spawn = origSpawn;
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
