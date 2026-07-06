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
const DEFAULT_TIMEOUT_MS = 15000;
const INIT_TIMEOUT_MS = 5000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-golden-path-e2e-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function runCli(args, { cwd, input = '', env, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });

  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli timed out after ${timeout}ms: atris ${args.join(' ')}`);
  }
  if (result.error) throw result.error;
  return result;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function parseJson(result, label) {
  assertOk(result, label);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    assert.fail(`${label} returned invalid json\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

test('golden path e2e runs init delegate ready autoland status without human input', (t) => {
  if (!hasNodeSqlite()) {
    t.skip('node:sqlite unavailable');
    return;
  }

  const root = makeTempDir();
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const dbPath = path.join(root, 'tasks.db');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    ATRIS_TASKS_DB: dbPath,
  };

  try {
    const init = runCli(['init', '--yes'], {
      cwd: workspace,
      input: '',
      env,
      timeout: INIT_TIMEOUT_MS,
    });
    assertOk(init, 'init --yes');
    assert.ok(fs.existsSync(path.join(workspace, 'atris', 'atris.md')));
    assert.doesNotMatch(init.stdout, /Answer in one sentence|^\s*>\s*$/m);
    assert.equal(init.stderr, '');

    const delegated = parseJson(runCli([
      'task',
      'delegate',
      'demo fix',
      '--to',
      'demo',
      '--json',
    ], { cwd: workspace, env }), 'task delegate');

    const taskRef = delegated.task?.display_id || delegated.task_id;
    assert.ok(taskRef, 'delegate returned a task ref');
    assert.equal(delegated.owner, 'demo');
    assert.match(delegated.handoff?.command || '', new RegExp(`task claim ${taskRef} --as demo`));

    const claimed = parseJson(runCli([
      'task',
      'claim',
      taskRef,
      '--as',
      'demo',
      '--json',
    ], { cwd: workspace, env }), 'task claim');
    assert.equal(claimed.task?.status, 'claimed');
    assert.equal(claimed.task?.claimed_by, 'demo');

    fs.writeFileSync(path.join(workspace, 'demo-fix.js'), "'use strict';\n", 'utf8');
    const ready = parseJson(runCli([
      'task',
      'ready',
      taskRef,
      '--as',
      'demo',
      '--verify',
      'node --check demo-fix.js',
      '--result',
      'Operators can now land a demo fix faster because the proof path is clear.',
      '--json',
    ], { cwd: workspace, env }), 'task ready');

    assert.equal(ready.action, 'ready');
    assert.equal(ready.task?.status, 'review');
    assert.equal(ready.approval_status, 'pending');
    assert.equal(ready.task?.metadata?.verify, 'node --check demo-fix.js');

    const certified = parseJson(runCli([
      'task',
      'certify-verified',
      '--json',
    ], { cwd: workspace, env }), 'task certify-verified');
    assert.equal(certified.action, 'certify_verified');
    assert.equal(certified.certified, 1);
    assert.equal(certified.results?.[0]?.action, 'certified');

    const accepted = parseJson(runCli([
      'task',
      'auto-accept-certified',
      '--json',
    ], { cwd: workspace, env }), 'task auto-accept-certified');
    assert.equal(accepted.action, 'auto_accept_certified');
    assert.equal(accepted.accepted, 1);
    assert.equal(accepted.results?.[0]?.action, 'accepted');

    const done = parseJson(runCli([
      'task',
      'show',
      taskRef,
      '--json',
    ], { cwd: workspace, env }), 'task show');
    assert.equal(done.status, 'done');
    assert.equal(done.review?.approval_status, 'accepted');

    const todoPath = path.join(workspace, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
      '',
    ].join('\n'), 'utf8');

    const status = runCli(['status'], { cwd: workspace, env });
    assertOk(status, 'status');
    assert.match(status.stdout, /and 1 completed items still\s+sitting in TODO\./);
  } finally {
    cleanupTempDir(root);
  }
});
