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
  return runCliAt(cliPath, args, { cwd, input, env, timeout });
}

function childEnv(patch = {}) {
  const env = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
    ...patch,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) delete env[key];
  }
  return env;
}

function runCliAt(binary, args, { cwd, input = '', env, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: childEnv(env),
  });

  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli timed out after ${timeout}ms: atris ${args.join(' ')}`);
  }
  if (result.error) throw result.error;
  return result;
}

function runCommand(command, args, { cwd, env, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: childEnv(env),
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`${command} timed out after ${timeout}ms: ${args.join(' ')}`);
  }
  if (result.error) throw result.error;
  return result;
}

function parseShellWords(command) {
  const words = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  assert.equal(quote, null, `unclosed quote in printed command: ${command}`);
  assert.equal(escaped, false, `trailing escape in printed command: ${command}`);
  if (current) words.push(current);
  return words;
}

function printedAtrisArgs(output, label) {
  const prefix = `${label}:`.toLowerCase();
  const line = String(output || '')
    .split(/\r?\n/)
    .map((row) => row.trimStart())
    .find((row) => row.toLowerCase().startsWith(prefix) && /\batris\s/.test(row));
  assert.ok(line, `missing ${label} Atris command in output:\n${output}`);
  return parseShellWords(line.slice(line.toLowerCase().indexOf('atris ') + 'atris '.length));
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertGoldenPathStep(result, label) {
  assertOk(result, label);
  assert.equal(result.stderr, '', `${label} wrote to stderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /BOOTSTRAP REQUIRED|Answer in one sentence|Verifier failed|no verifier was run|NEXT SETUP STEP|^Mission: atris mission start|^\s*>\s*$/m);
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
      '--full',
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

test('packed golden path follows printed talk do ready and autoland handoffs', () => {
  assert.ok(hasNodeSqlite(), 'packed golden path requires a Node runtime with node:sqlite');

  const root = makeTempDir();
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const packDir = path.join(root, 'pack');
  const prefix = path.join(root, 'prefix');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(packDir, { recursive: true });

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    ATRIS_TASKS_DB: null,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
  };

  try {
    const gitInit = runCommand('git', ['init', '-b', 'master'], { cwd: workspace, env });
    assertOk(gitInit, 'git init');
    assertOk(runCommand('git', ['config', 'user.email', 'golden-path@example.invalid'], { cwd: workspace, env }), 'git config email');
    assertOk(runCommand('git', ['config', 'user.name', 'Golden Path'], { cwd: workspace, env }), 'git config name');
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Toy repo\n', 'utf8');
    assertOk(runCommand('git', ['add', 'README.md'], { cwd: workspace, env }), 'stage toy repo');
    assertOk(runCommand('git', ['commit', '-m', 'initial toy repo'], { cwd: workspace, env }), 'initial commit');

    const packed = runCommand('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], {
      cwd: repoRoot,
      env,
      timeout: 30000,
    });
    assertOk(packed, 'npm pack');
    const archives = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, `expected one package archive, got: ${archives.join(', ')}`);

    const installed = runCommand('npm', [
      'install',
      '--global',
      '--ignore-scripts',
      '--prefix',
      prefix,
      path.join(packDir, archives[0]),
    ], { cwd: workspace, env, timeout: 30000 });
    assertOk(installed, 'packed install');
    const installedBin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const installedEnv = {
      ...env,
      PATH: `${installedBin}${path.delimiter}${process.env.PATH || ''}`,
    };
    const runInstalled = (args, options = {}) => runCommand('atris', args, {
      cwd: workspace,
      env: installedEnv,
      ...options,
    });

    const firstRun = runInstalled([]);
    assertGoldenPathStep(firstRun, 'first run');
    assert.match(firstRun.stdout, /initial toy repo is already here\./);
    assert.match(firstRun.stdout, /^next: atris do$/m);
    assert.doesNotMatch(firstRun.stdout, /README\.md is already here|what do you want here|git log|HEAD/);

    const doArgs = printedAtrisArgs(firstRun.stdout, 'next');
    assert.deepEqual(doArgs, ['do']);

    const talk = runInstalled(doArgs, { timeout: 30000 });
    assertGoldenPathStep(talk, 'printed do from files already here');
    assert.match(talk.stdout, /README\.md is ready\./);
    assert.match(talk.stdout, /^next: atris do$/m);
    assert.doesNotMatch(talk.stdout, /I saved a first step|first useful step/i);
    assert.doesNotMatch(talk.stdout, /atris initialized|What do you want to build|minimal scaffold/i);
    assert.doesNotMatch(talk.stdout, /atris task (claim|show) /);

    const doit = runInstalled(doArgs);
    assertGoldenPathStep(doit, 'second do after first-talk');
    assert.match(doit.stdout, /already yours/);
    assert.match(doit.stdout, /^next: atris do$/m);
    assert.doesNotMatch(doit.stdout, /atris task show |PROMPT ONLY|You are the Executor|executor\.md/);

    const afterDo = runInstalled([]);
    assertGoldenPathStep(afterDo, 'first minute after do');
    assert.doesNotMatch(afterDo.stdout, /No open tasks/);
    assert.deepEqual(printedAtrisArgs(afterDo.stdout, 'next'), ['do']);

    const listed = parseJson(runInstalled(['task', 'list', '--json']), 'task list');
    const starter = (listed.tasks || []).find((row) => row && row.status === 'claimed');
    assert.ok(starter && starter.display_id, `claimed starter missing: ${JSON.stringify(listed)}`);
    const taskRef = starter.display_id;

    fs.appendFileSync(path.join(workspace, 'README.md'), '\nFirst useful step complete.\n', 'utf8');
    const ready = runInstalled([
      'task',
      'ready',
      taskRef,
      '--verify',
      'git diff --check',
      '--result',
      'New users can now finish a first proof loop faster because every next step is printed.',
      '--landing',
      'New users can now finish their first proof loop faster, skipping the hidden setup steps.',
    ]);
    assertGoldenPathStep(ready, 'task-ready after first-talk do');
    assert.match(ready.stdout, /proof is ready; autoland runs the second check and lands it once the hourly heartbeat runs \(start one with atris autoland tick\)\./);

    const landed = runInstalled(['autoland', 'tick']);
    assertGoldenPathStep(landed, 'autoland tick');
    assert.match(landed.stdout, new RegExp(`1 landed \\(${taskRef}\\)`));

    const taskResult = runInstalled(['task', 'show', taskRef, '--json']);
    assertGoldenPathStep(taskResult, 'landed task');
    const task = parseJson(taskResult, 'landed task');
    assert.equal(task.status, 'done');
    assert.equal(task.review?.approval_status, 'accepted');
    const workspaceDiff = runCommand('git', ['diff', '--', 'README.md'], { cwd: workspace, env });
    assertOk(workspaceDiff, 'workspace diff');
    assert.match(workspaceDiff.stdout, /First useful step complete\./);
  } finally {
    cleanupTempDir(root);
  }
});
