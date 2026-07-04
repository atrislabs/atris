'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unknowns-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function seedWorkspace(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), Array.from({ length: 120 }, (_, i) => `map line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), '- keep blindspot passes local-first\n');
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), JSON.stringify([{ lesson: 'sql is truth' }], null, 2));
  fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-04.md'), '# Daily\n\n- shipped a test signal\n');
}

test('unknowns --help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['unknowns', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris unknowns/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('unknowns writes, lists, and resolves a stub row when runner is unavailable', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const env = {
      ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db'),
      ATRIS_RUNNER_BIN: 'definitely-not-an-atris-runner',
    };

    const create = runCli(['unknowns', 'Should we ship a blindspot ledger?'], { cwd: dir, env });
    assert.equal(create.status, 0, create.stderr || create.stdout);
    assert.match(create.stdout, /Top questions:/);
    assert.match(create.stdout, /1 unknown written to ledger/);

    const projection = path.join(dir, '.atris', 'state', 'unknowns.md');
    assert.ok(fs.existsSync(projection));
    assert.match(fs.readFileSync(projection, 'utf8'), /Model unavailable/);

    const listed = runCli(['unknowns', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /unknown_unknown costly/);
    assert.match(listed.stdout, /Model unavailable/);
    const id = (listed.stdout.match(/^([0-9A-Z]{26})\s/m) || [])[1];
    assert.ok(id, listed.stdout);

    const resolved = runCli(['unknowns', 'resolve', id, 'No runner installed; stub path verified.'], { cwd: dir, env });
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.match(resolved.stdout, new RegExp(`resolved ${id}`));

    const after = runCli(['unknowns', 'list'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.match(after.stdout, /No open unknowns/);
    const rendered = fs.readFileSync(projection, 'utf8');
    assert.match(rendered, /Resolved/);
    assert.match(rendered, /stub path verified/);
  } finally {
    cleanupTempDir(dir);
  }
});
