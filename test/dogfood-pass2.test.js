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
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-dogfood-pass2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

test('16: current-step --json error body is compact unless --full', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);
    const compact = runCli([
      'task', 'current-step', '--goal-id', 'missing-mission', '--as', 'mission-lead', '--json',
    ], { cwd: dir });
    assert.notEqual(compact.status, 0);
    assert.ok(Buffer.byteLength(compact.stdout || '') < 2048, `compact too large: ${Buffer.byteLength(compact.stdout || '')}`);
    const body = JSON.parse(compact.stdout);
    assert.equal(body.ok, false);
    assert.ok(body.reason);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'detail'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'selected_ref'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'next_command'), true);
    assert.equal(body.current, undefined);

    const full = runCli([
      'task', 'current-step', '--goal-id', 'missing-mission', '--as', 'mission-lead', '--json', '--full',
    ], { cwd: dir });
    assert.notEqual(full.status, 0);
    const fullBody = JSON.parse(full.stdout);
    assert.equal(fullBody.ok, false);
    assert.ok(fullBody.current || fullBody.page || fullBody.detail);
  } finally {
    cleanupTempDir(dir);
  }
});

test('16: mission tick --json error is compact unless --full', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);
    const compact = runCli(['mission', 'tick', 'missing-mission-id', '--json'], { cwd: dir });
    assert.notEqual(compact.status, 0);
    assert.ok(Buffer.byteLength(compact.stdout || '') < 2048, compact.stdout);
    const body = JSON.parse(compact.stdout);
    assert.equal(body.ok, false);
    assert.ok(body.reason);
    assert.equal(body.error, undefined);

    const full = runCli(['mission', 'tick', 'missing-mission-id', '--json', '--full'], { cwd: dir });
    const fullBody = JSON.parse(full.stdout);
    assert.equal(fullBody.ok, false);
    assert.ok(fullBody.error || fullBody.detail);
  } finally {
    cleanupTempDir(dir);
  }
});

test('16: task ready --json success stays compact unless --full', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);
    const created = runCli([
      'task', 'new', 'compact ready json proof', '--tag', 'cli', '--as', 'cursor-agent',
    ], { cwd: dir });
    assert.equal(created.status, 0, created.stderr);
    const ref = String(created.stdout || '').trim().split(/\s+/)[0];
    assert.ok(ref);
    runCli(['task', 'claim', ref, '--as', 'cursor-agent'], { cwd: dir });

    fs.writeFileSync(path.join(dir, 'ready-check.js'), 'module.exports = 1;\n');
    const compact = runCli([
      'task', 'ready', ref,
      '--verify', 'node --check ready-check.js',
      '--result', 'Operators can read a small ready json payload instead of a huge dump.',
      '--landing', 'A teammate can trust ready json is small enough to read in one glance.',
      '--as', 'cursor-agent',
      '--json',
    ], { cwd: dir });
    assert.equal(compact.status, 0, compact.stderr + compact.stdout);
    assert.ok(Buffer.byteLength(compact.stdout || '') < 2048, `ready compact too large: ${Buffer.byteLength(compact.stdout || '')}\n${compact.stdout}`);
    const body = JSON.parse(compact.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.action, 'ready');
    assert.ok(body.task_id || body.selected_ref);
    assert.ok(body.next_command);
    assert.equal(body.handoff, undefined);
    assert.equal(body.task, undefined);

    // --full on a ready-shaped failure still dumps richer fields when present.
    const fullErr = runCli([
      'task', 'ready', 'missing-ready-id',
      '--proof', 'x',
      '--result', 'Operators can still request the full ready dump when needed.',
      '--json',
      '--full',
    ], { cwd: dir });
    assert.notEqual(fullErr.status, 0);
    const fullBody = JSON.parse(fullErr.stdout);
    assert.equal(fullBody.ok, false);
    assert.ok(fullBody.command || fullBody.detail);
  } finally {
    cleanupTempDir(dir);
  }
});

test('17: stream --once and ATRIS_NONINTERACTIVE stream exit quickly', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(['init', '--yes'], { cwd: dir, timeout: 60000 });
    assert.equal(init.status, 0, init.stderr);

    const once = runCli(['stream', '--once'], { cwd: dir, timeout: 8000 });
    assert.equal(once.status, 0, once.stderr);
    assert.match(once.stdout, /Team stream|Watching missions|On now/i);

    const noninteractive = runCli(['stream'], {
      cwd: dir,
      timeout: 8000,
      env: { ATRIS_NONINTERACTIVE: '1' },
    });
    assert.equal(noninteractive.status, 0, noninteractive.stderr);
    assert.match(noninteractive.stdout, /Team stream|Watching missions|On now/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('17: orb --json emits moves; orb --pick selects one', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'now.md'), '# Now\n\nfixture\n');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [],
    }));

    const json = runCli(['orb', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.ok(Array.isArray(body.moves));
    assert.ok(body.moves.length >= 1);
    assert.equal(body.moves[0].n, 1);
    assert.ok(body.moves[0].label);
    assert.ok(body.moves[0].command);

    const pick = runCli(['orb', '--pick', '1'], { cwd: dir });
    assert.equal(pick.status, 0, pick.stderr);
    assert.match(pick.stdout, /picked 1:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('18: close with no args exits 2; sign status when off exits 0', () => {
  const dir = makeTempDir();
  try {
    const close = runCli(['close'], { cwd: dir });
    assert.equal(close.status, 2, close.stdout + close.stderr);

    const voice = runCli(['voice'], { cwd: dir });
    assert.equal(voice.status, 2, voice.stdout + voice.stderr);

    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    const sign = runCli(['sign', 'status'], { cwd: dir });
    assert.equal(sign.status, 0, sign.stdout + sign.stderr);
    assert.match(sign.stdout, /co-author is off/i);

    const founder = runCli(['founder', '--json'], { cwd: dir });
    assert.equal(founder.status, 0, founder.stdout + founder.stderr);
    const founderBody = JSON.parse(founder.stdout);
    assert.equal(typeof founderBody.commitsThisWeek, 'number');
    assert.equal(typeof founderBody.slopePct, 'number');
    assert.ok(Array.isArray(founderBody.perRepo));
  } finally {
    cleanupTempDir(dir);
  }
});

test('19: update without --yes does not write; with --yes may write', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(path.join(atrisDir, 'team', 'navigator'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'atris.md'), 'old atris\n');
    fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), 'old persona\n');
    fs.writeFileSync(path.join(atrisDir, 'team', 'navigator', 'MEMBER.md'), 'old navigator\n');

    const beforePolicies = fs.existsSync(path.join(atrisDir, 'policies'));
    const plan = runCli(['update'], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
    });
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /Plan only|Dry run|Would/i);
    assert.equal(fs.existsSync(path.join(atrisDir, 'policies')), beforePolicies);

    const apply = runCli(['update', '--yes'], { cwd: dir });
    assert.equal(apply.status, 0, apply.stderr + apply.stdout);
    assert.equal(fs.existsSync(path.join(atrisDir, 'policies')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('19: brain without --yes plans only and does not write GEMINI.md', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n');
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), '# Now\n');

    const plan = runCli(['brain', 'compile', '--root', dir], {
      cwd: dir,
      env: { ATRIS_NONINTERACTIVE: '1' },
    });
    assert.equal(plan.status, 2, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /Plan only|Would write|GEMINI\.md/i);
    assert.equal(fs.existsSync(path.join(dir, 'GEMINI.md')), false);

    const apply = runCli(['brain', 'compile', '--root', dir, '--yes'], { cwd: dir });
    assert.equal(apply.status, 0, apply.stderr + apply.stdout);
    assert.equal(fs.existsSync(path.join(dir, 'GEMINI.md')), true);
  } finally {
    cleanupTempDir(dir);
  }
});
