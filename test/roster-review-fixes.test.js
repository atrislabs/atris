'use strict';

// Five edge cases a reviewer found in the sectioned roster and the Ctrl-C
// guard. Every room is a scratch project with a scratch home, so the real
// ~/.atris and ~/.codex are never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  setEngineHealth,
  setRosterPick,
} = require('../lib/engine-registry');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-fixes-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-fixes-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  const paths = { home, sessions: path.join(home, '.atris', 'sessions') };
  try { return fn(root, paths); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
}

function writeRoster(root, text) {
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), text);
}

function readRoster(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

function project(root) {
  return readRosterState(root, { now: NOW }).project;
}

// 1. Two session keys that clean up to the same text keep separate files.
test('session keys that sanitize the same still get their own files', () => withRoom((root, paths) => {
  ready(root, 'codex', 'claude', 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell/b';
  setRosterPick('build', 'codex', { session: true, now: NOW }, root);
  process.env.ATRIS_ROSTER_SESSION = 'shell-b';
  setRosterPick('build', 'cursor', { session: true, now: NOW }, root);
  const files = fs.readdirSync(paths.sessions).sort();
  assert.equal(files.length, 2, `expected two session files, got ${files.join(', ')}`);
  for (const key of ['shell/b', 'shell-b']) {
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    assert.ok(files.includes(`roster-shell-b-${hash}.md`), `missing the file for ${key}`);
  }
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'cursor');
  process.env.ATRIS_ROSTER_SESSION = 'shell/b';
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'codex');
  // Keys that only differ past the readable prefix stay apart too.
  const long = 'x'.repeat(100);
  process.env.ATRIS_ROSTER_SESSION = `${long}1`;
  setRosterPick('build', 'claude', { session: true, now: NOW }, root);
  process.env.ATRIS_ROSTER_SESSION = `${long}2`;
  assert.notEqual(resolveEngineForRoleRanked('executor', root, { now: NOW }).source, 'session');
  // A key full of path parts never leaves the sessions folder.
  process.env.ATRIS_ROSTER_SESSION = '../../escape';
  setRosterPick('build', 'codex', { session: true, now: NOW }, root);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.sessions)).sort(), ['sessions']);
  for (const name of fs.readdirSync(paths.sessions)) assert.match(name, /^roster-[A-Za-z0-9_][A-Za-z0-9_.-]*\.md$/);
}));

// 2. Assign with --like on a job that already has a section writes the new kind.
test('assign --like on an existing job changes its kind, and the new worker resolves', () => withRoom((root) => {
  ready(root, 'codex', 'atris-fast', 'haiku');
  writeRoster(root, '# roster\n\n## quick fixes (like build)\n- codex\n\n## team\n');
  setRosterPick('quick fixes', 'atris-fast', { like: 'search', now: NOW }, root);
  assert.match(readRoster(root), /\n## quick fixes \(like search\)\n- atris fast\n/);
  const pick = project(root).picks['quick-fixes'];
  assert.equal(pick.like, 'search');
  assert.equal(pick.engine, 'atris-fast');
  assert.equal(resolveEngineForRoleRanked('navigator', root, { now: NOW, job: 'quick fixes' }).engine.id, 'atris-fast');
  // Removing a worker keeps the kind the section already has.
  setRosterPick('quick fixes', 'haiku', { add: true, now: NOW }, root);
  setRosterPick('quick fixes', null, { remove: 'haiku', now: NOW }, root);
  assert.match(readRoster(root), /\n## quick fixes \(like search\)\n- atris fast\n/);
}));

// 3. A lead plus a backup keeps every other worker, in its old order.
test('assign with --backup keeps the other workers after the lead and backup', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'cursor', 'grok');
  writeRoster(root, '# roster\n\n## build\n- codex, effort: high <!-- old lead -->\n- claude code, model: opus 5.5\n- devin, model: swe-2-max, until 2026-10-24\n');
  setRosterPick('build', 'claude', { backup: 'cursor', now: NOW }, root);
  assert.equal(readRoster(root), '# roster\n\n## build\n- claude code\n- cursor\n- codex, effort: high <!-- old lead -->\n- devin, model: swe-2-max, until 2026-10-24\n');
  assert.deepEqual(project(root).picks.executor.workers.map((worker) => worker.engine), ['claude', 'cursor', 'codex', 'devin']);
  // A lead that already sits lower loses only that one line.
  writeRoster(root, '# roster\n\n## build\n- codex\n- devin\n- claude code\n- grok\n');
  setRosterPick('build', 'devin', { backup: 'cursor', now: NOW }, root);
  assert.equal(readRoster(root), '# roster\n\n## build\n- devin\n- cursor\n- codex\n- claude code\n- grok\n');
}));

// 4. Clearing a job, or removing its last worker, removes every section for
// it, so an ignored second section cannot take over.
test('clear and removing the last worker take out every section for that job', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'cursor');
  const twice = '# roster\n\n## build\n- codex\n\n## review\n- claude code\n\n## build\n- cursor\n';
  writeRoster(root, twice);
  const warnings = project(root).warnings.filter((warning) => /second time/.test(warning.message));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 9);
  assert.equal(project(root).picks.executor.engine, 'codex');
  setRosterPick('build', null, { clear: true, now: NOW }, root);
  assert.equal(readRoster(root), '# roster\n\n## review\n- claude code\n');
  assert.equal(project(root).picks.executor, undefined);
  writeRoster(root, twice);
  setRosterPick('build', null, { remove: 'codex', now: NOW }, root);
  assert.equal(readRoster(root), '# roster\n\n## review\n- claude code\n');
  assert.equal(project(root).picks.executor, undefined);
  // Removing a worker that leaves the first section with others keeps both.
  writeRoster(root, '# roster\n\n## build\n- codex\n- claude code\n\n## build\n- cursor\n');
  setRosterPick('build', null, { remove: 'codex', now: NOW }, root);
  assert.equal(readRoster(root), '# roster\n\n## build\n- claude code\n\n## build\n- cursor\n');
}));

function waitUntil(predicate, timeoutMs = 5000) {
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

// 5. A handler registered with process.once removes itself before its async
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
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, ['#!/bin/sh', 'sleep 30 &', `echo $! > "${pidFile}"`, 'wait', ''].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
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
    await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the engine should have written its grandchild pid');
    parent.kill('SIGINT');
    const closed = await new Promise((resolve) => {
      const bail = setTimeout(() => resolve(null), 10000);
      parent.once('close', (code, sig) => {
        clearTimeout(bail);
        resolve({ code, sig });
      });
    });
    assert.ok(closed, 'the parent should exit');
    assert.deepEqual(closed, { code: 0, sig: null }, 'the once handler should own the exit');
    assert.equal(fs.existsSync(doneFile), true, 'the async cleanup should have finished');
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    assert.throws(() => process.kill(pid, 0));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
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
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'wt1'));
  fs.mkdirSync(path.join(root, 'wt2'));
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, ['#!/bin/sh', 'sleep 30 &', `echo $! >> "${pidFile}"`, 'wait', ''].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
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
  const pids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter((pid) => pid > 0) : []);
  try {
    await waitUntil(() => pids().length === 2);
    parent.kill('SIGINT');
    const closed = await new Promise((resolve) => {
      const bail = setTimeout(() => resolve(null), 10000);
      parent.once('close', (code, sig) => {
        clearTimeout(bail);
        resolve({ code, sig });
      });
    });
    assert.deepEqual(closed, { code: null, sig: 'SIGINT' });
    for (const pid of pids()) {
      await waitUntil(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      });
    }
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL'); } catch {}
    }
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
