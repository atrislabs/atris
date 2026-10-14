'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Each test boots a fresh node parent that loads lib/fleet.js and then a
// shell engine. On a loaded machine that can take several seconds, so every
// wait gets a slow-machine budget; a fast machine still finishes in
// milliseconds because the polls return as soon as the condition holds.
const SLOW_MACHINE_MS = 15000;

function waitUntil(predicate, timeoutMs = SLOW_MACHINE_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

// The shell creates the pid file before echo fills it, so an existing file
// can still be empty. Only count pids that were fully written.
function readPids(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(Number).filter((pid) => pid > 0);
}

function waitForClose(child) {
  return new Promise((resolve) => {
    const bail = setTimeout(() => resolve(null), SLOW_MACHINE_MS);
    child.once('close', (code, sig) => {
      clearTimeout(bail);
      resolve({ code, sig });
    });
  });
}

function waitForDeath(pid) {
  return waitUntil(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  });
}

function writeFakeCursor(binDir, pidFile) {
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, ['#!/bin/sh', 'sleep 30 &', `echo $! >> "${pidFile}"`, 'wait', ''].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
}

// A detached dispatch child leads its own group, so Ctrl-C on the parent
// never reaches the engine; the guard must kill the group and re-raise.
test('ctrl-c on a dispatch kills the engine process group too', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const repoRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-wt-'));
  const binDir = path.join(root, 'bin');
  const pidFile = path.join(root, 'grandchild.pid');
  const parentScript = path.join(root, 'parent.js');
  writeFakeCursor(binDir, pidFile);
  fs.writeFileSync(parentScript, [
    'const path = require("path");',
    'const fleet = require(process.argv[2]);',
    'const [binDir, wt, liveLog] = process.argv.slice(3);',
    'fleet.dispatchToEngine({',
    '  task: { display_id: "CLI-SIGINT", status: "open", title: "x Done: x. Check: y." },',
    '  engine: "cursor",',
    '  worktreePath: wt,',
    '  skipBriefCapture: true,',
    '  liveLogPath: liveLog,',
    '  environment: { PATH: binDir + path.delimiter + process.env.PATH },',
    '});',
    '',
  ].join('\n'));
  const parent = spawn(process.execPath, [
    parentScript,
    path.join(repoRoot, 'lib', 'fleet.js'),
    binDir,
    wt,
    path.join(root, 'dispatch.live.log'),
  ], { cwd: repoRoot, stdio: 'inherit' });
  try {
    await waitUntil(() => readPids(pidFile).length === 1);
    const [pid] = readPids(pidFile);
    parent.kill('SIGINT');
    const closed = await waitForClose(parent);
    assert.ok(closed, 'the parent should exit on SIGINT');
    assert.equal(closed.sig, 'SIGINT');
    await waitForDeath(pid);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
    for (const pid of readPids(pidFile)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

// A handler registered with process.once removes itself before its async
// cleanup runs; the dispatch guard must not re-raise and cut that cleanup short.
test('ctrl-c during a dispatch lets another once handler finish its async cleanup, and still kills the engine', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const repoRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-once-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-once-wt-'));
  const binDir = path.join(root, 'bin');
  const pidFile = path.join(root, 'grandchild.pid');
  const doneFile = path.join(root, 'cleanup.done');
  const parentScript = path.join(root, 'parent.js');
  writeFakeCursor(binDir, pidFile);
  fs.writeFileSync(parentScript, [
    'const fs = require("fs");',
    'const path = require("path");',
    'const fleet = require(process.argv[2]);',
    'const [binDir, wt, liveLog, doneFile] = process.argv.slice(3);',
    'process.once("SIGINT", () => {',
    '  setTimeout(() => { fs.writeFileSync(doneFile, "done"); process.exit(0); }, 200);',
    '});',
    'fleet.dispatchToEngine({',
    '  task: { display_id: "CLI-SIGINT-ONCE", status: "open", title: "x Done: x. Check: y." },',
    '  engine: "cursor",',
    '  worktreePath: wt,',
    '  skipBriefCapture: true,',
    '  liveLogPath: liveLog,',
    '  environment: { PATH: binDir + path.delimiter + process.env.PATH },',
    '});',
    '',
  ].join('\n'));
  const parent = spawn(process.execPath, [
    parentScript,
    path.join(repoRoot, 'lib', 'fleet.js'),
    binDir,
    wt,
    path.join(root, 'dispatch.live.log'),
    doneFile,
  ], { cwd: repoRoot, stdio: 'inherit' });
  try {
    await waitUntil(() => readPids(pidFile).length === 1);
    const [pid] = readPids(pidFile);
    parent.kill('SIGINT');
    const closed = await waitForClose(parent);
    assert.ok(closed, 'the parent should exit');
    assert.deepEqual(closed, { code: 0, sig: null }, 'the once handler should own the exit');
    assert.equal(fs.existsSync(doneFile), true, 'the async cleanup should have finished');
    await waitForDeath(pid);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
    for (const pid of readPids(pidFile)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

// With two dispatches running and nothing else listening, the last guard to
// run still re-raises, so a process that would otherwise stay up dies on
// Ctrl-C and both engines go with it.
test('ctrl-c during two dispatches at once still ends the parent by SIGINT', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process groups are posix-only');
    return;
  }
  const repoRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sigint-two-'));
  const binDir = path.join(root, 'bin');
  const pidFile = path.join(root, 'grandchild.pids');
  const parentScript = path.join(root, 'parent.js');
  fs.mkdirSync(path.join(root, 'wt1'));
  fs.mkdirSync(path.join(root, 'wt2'));
  writeFakeCursor(binDir, pidFile);
  fs.writeFileSync(parentScript, [
    'const path = require("path");',
    'const fleet = require(process.argv[2]);',
    'const [binDir, root] = process.argv.slice(3);',
    'setInterval(() => {}, 1000);',
    'for (const name of ["wt1", "wt2"]) {',
    '  fleet.dispatchToEngine({',
    '    task: { display_id: "CLI-SIGINT-TWO", status: "open", title: "x Done: x. Check: y." },',
    '    engine: "cursor",',
    '    worktreePath: path.join(root, name),',
    '    skipBriefCapture: true,',
    '    liveLogPath: path.join(root, name + ".live.log"),',
    '    environment: { PATH: binDir + path.delimiter + process.env.PATH },',
    '  });',
    '}',
    '',
  ].join('\n'));
  const parent = spawn(process.execPath, [parentScript, path.join(repoRoot, 'lib', 'fleet.js'), binDir, root], { cwd: repoRoot, stdio: 'inherit' });
  try {
    await waitUntil(() => readPids(pidFile).length === 2);
    parent.kill('SIGINT');
    const closed = await waitForClose(parent);
    assert.deepEqual(closed, { code: null, sig: 'SIGINT' });
    for (const pid of readPids(pidFile)) await waitForDeath(pid);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
    for (const pid of readPids(pidFile)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
