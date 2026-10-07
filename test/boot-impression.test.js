'use strict';

// Boot impression: assert session boot (atris atris.md) includes the active
// endgame verbatim, and the selector (task next --json) prefers endgame-tagged tasks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-boot-impression-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function seedTask(dir, env, title, { tag } = {}) {
  const args = ['task', 'new', title];
  if (tag) {
    args.push('--tag', tag);
  }
  args.push('--json');
  const created = runCli(args, { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  return task;
}

test('boot panel renders active endgame verbatim and task next prefers endgame-tagged tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    // Create TODO.md with an endgame section
    const todoContent = [
      '# TODO',
      '',
      '## Endgame',
      '**Slug:** cli-235',
      '**Horizon:** make the repeated impression enforceable',
      '',
      '## Backlog',
      '- Regular backlog task',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'), todoContent, 'utf8');

    // Seed one endgame-tagged task and one regular task
    const endgameTask = seedTask(dir, env, 'endgame task one', { tag: 'endgame' });
    const regularTask = seedTask(dir, env, 'regular task one', {});

    // Boot should show the endgame horizon verbatim
    const boot = runCli(['atris.md'], { cwd: dir, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /make the repeated impression enforceable/,
      'boot stdout should contain endgame horizon text verbatim');

    // task list --json should return the endgame-tagged task first
    const taskList = runCli(['task', 'list', '--json'], { cwd: dir, env });
    assert.equal(taskList.status, 0, taskList.stderr);
    const listData = JSON.parse(taskList.stdout);
    assert(listData.tasks && listData.tasks.length > 0, 'task list should return at least one task');
    assert.equal(listData.tasks[0].display_id, endgameTask.display_id,
      `task list should return endgame task ${endgameTask.display_id} first, not ${listData.tasks[0].display_id}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot panel shows only the newest wiki brief and stays silent without briefs', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    const emptyBoot = runCli(['atris.md'], { cwd: dir });
    assert.equal(emptyBoot.status, 0, emptyBoot.stderr);
    assert.deepEqual(emptyBoot.stdout.split('\n').filter((line) => line.includes('learned ')), []);

    const briefsDir = path.join(atrisDir, 'wiki', 'briefs');
    fs.mkdirSync(briefsDir, { recursive: true });
    const olderBrief = path.join(briefsDir, 'zzz-older-brief.md');
    const newestBrief = path.join(briefsDir, 'aaa-newest-brief.md');
    fs.writeFileSync(olderBrief, '# Older brief\n', 'utf8');
    fs.writeFileSync(newestBrief, '# YouTube brief: How agents compound\n', 'utf8');
    fs.utimesSync(olderBrief, new Date('2026-07-20T00:00:00Z'), new Date('2026-07-20T00:00:00Z'));
    fs.utimesSync(newestBrief, new Date('2026-07-21T00:00:00Z'), new Date('2026-07-21T00:00:00Z'));

    const boot = runCli(['atris.md'], { cwd: dir });
    assert.equal(boot.status, 0, boot.stderr);
    assert.deepEqual(
      boot.stdout.split('\n').filter((line) => line.includes('learned ')),
      ['  learned "How agents compound" overnight -> atris/wiki/briefs/aaa-newest-brief.md'],
    );
  } finally {
    cleanupTempDir(dir);
  }
});

// --- the team line: which tool and model does each job ----------------------

// A scratch home so the real ~/.atris roster and sessions are never read.
function lineupEnv(dir) {
  return {
    ATRIS_MACHINE_ROSTER_PATH: path.join(dir, 'home', '.atris', 'roster.json'),
    ATRIS_ROSTER_SESSION: '',
    ATRIS_CODEX_CONFIG_PATH: path.join(dir, 'home', 'no-codex-config.toml'),
    ATRIS_RUNNER_MODEL: '',
    ATRIS_ROUTER_EXPLAIN: '0',
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
  };
}

function seedRosterRoom(dir, rosterText) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  if (rosterText) fs.writeFileSync(path.join(dir, 'atris', 'ROSTER.md'), rosterText, 'utf8');
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  readEngineRegistry(dir);
  for (const name of ['claude', 'codex', 'grok']) setEngineHealth(name, 'ready', dir);
}

function teamLines(stdout) {
  return stdout.split('\n').filter((line) => /^  team /.test(line));
}

const BOOT_ROSTER = [
  '# roster',
  '## build',
  '- claude code, model: opus 5.5',
  '## review',
  '- codex, model: gpt-6-astra, effort: medium',
  '## search',
  '- claude code, model: haiku 5.5',
  '',
].join('\n');

test('boot shows which tool and model leads each built-in job', () => {
  const dir = makeTempDir();
  try {
    seedRosterRoom(dir, `${BOOT_ROSTER}## small build\n- grok, model: grok 4.7 fast, max: 20 min\n`);
    const boot = runCli(['atris.md'], { cwd: dir, env: lineupEnv(dir) });
    assert.equal(boot.status, 0, boot.stderr);
    // The custom job does not fit on the line, so it stops at the built-ins.
    assert.deepEqual(teamLines(boot.stdout), ['  team     build opus 5.5 · review codex gpt-6-astra · search haiku 5.5']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot adds custom jobs when they still fit on one line', () => {
  const dir = makeTempDir();
  try {
    seedRosterRoom(dir, [
      '# roster', '## build', '- codex', '## review', '- claude code, model: opus 5.5', '## search', '- claude code, model: haiku 5.5',
      '## quick build', '- grok', '',
    ].join('\n'));
    const boot = runCli(['atris.md'], { cwd: dir, env: lineupEnv(dir) });
    assert.equal(boot.status, 0, boot.stderr);
    const [line] = teamLines(boot.stdout);
    assert.equal(line, '  team     build codex · review opus 5.5 · search haiku 5.5 · quick build grok');
    assert.ok(line.length <= 80);
  } finally {
    cleanupTempDir(dir);
  }
});

test('boot with no roster shows the router picks in the same shape or nothing, and never crashes', () => {
  const dir = makeTempDir();
  try {
    seedRosterRoom(dir, '');
    const boot = runCli(['atris.md'], { cwd: dir, env: lineupEnv(dir) });
    assert.equal(boot.status, 0, boot.stderr);
    const lines = teamLines(boot.stdout);
    assert.ok(lines.length <= 1);
    if (lines.length) assert.match(lines[0], /^  team     build \S/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a roster reader that throws drops the team line and the boot still finishes', () => {
  const dir = makeTempDir();
  try {
    seedRosterRoom(dir, BOOT_ROSTER);
    const preload = path.join(dir, 'break-roster.js');
    fs.writeFileSync(preload, `const engine = require(${JSON.stringify(path.join(repoRoot, 'commands', 'engine.js'))});\nengine.jobRosterView = () => { throw new Error('roster exploded'); };\n`, 'utf8');
    const result = spawnSync(process.execPath, ['-r', preload, cliPath, 'atris.md'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...lineupEnv(dir) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(teamLines(result.stdout), []);
    assert.match(result.stdout, /^  next\b/m);
  } finally {
    cleanupTempDir(dir);
  }
});
