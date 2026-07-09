const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const packageJson = require('../package.json');
const systemPath = [
  path.dirname(process.execPath),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fast-smoke-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFakeEngine(dir, name) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(file, 0o755);
  return binDir;
}

function runCli(args, { cwd, env = {}, timeout = 6000 } = {}) {
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

test('real atris binary fast smoke covers core read-only commands', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });

    const version = runCli(['--version'], { cwd: dir, env: { HOME: home, PATH: systemPath } });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.match(version.stdout, new RegExp(`atris v${packageJson.version.replace(/\./g, '\\.')}`));

    const help = runCli(['--help'], { cwd: dir, env: { HOME: home, PATH: systemPath } });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /atris - an operating system for intelligence|atris .* operating system for intelligence/);

    const engines = runCli(['engine', 'list', '--json'], { cwd: dir, env: { HOME: home, PATH: systemPath } });
    assert.equal(engines.status, 0, engines.stderr || engines.stdout);
    const payload = JSON.parse(engines.stdout);
    assert.equal(typeof payload.default, 'string');
    assert.ok(Array.isArray(payload.engines));
    assert.ok(payload.engines.some((engine) => engine.id === 'atris-fast'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('real atris binary fast smoke covers wish questions and task render temp paths', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const work = path.join(dir, 'work');
    fs.mkdirSync(path.join(work, 'atris'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const fakeBin = writeFakeEngine(dir, 'codex');
    writeFakeEngine(dir, 'claude');

    const env = {
      HOME: home,
      PATH: `${fakeBin}:${systemPath}`,
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    };

    const wish = runCli(['wish', 'fix auth'], { cwd: work, env });
    assert.equal(wish.status, 1, wish.stderr || wish.stdout);
    assert.match(wish.stdout, /^Got it, wish #\d+: fix auth\./);
    assert.match(wish.stdout, /Auth could mean fewer steps, smarter defaults, or more reliable completion\. I would bet on smarter defaults, so which should I optimize for\?/);
    assert.match(wish.stdout.trim(), /Answer with: atris wish answer "your words"$/);

    const outPath = path.join(dir, 'rendered', 'TODO.md');
    const render = runCli(['task', 'render', '--out', outPath, '--json'], { cwd: work, env });
    assert.equal(render.status, 0, render.stderr || render.stdout);
    const rendered = JSON.parse(render.stdout);
    assert.equal(rendered.ok, true);
    assert.equal(rendered.action, 'rendered');
    assert.equal(rendered.path, outPath);
    assert.equal(fs.existsSync(outPath), true);
  } finally {
    cleanupTempDir(dir);
  }
});
