'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERIFY_COMMAND = 'node -e "process.exit(0)"';
const COAUTHOR = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function hasFlag(args, name) {
  return args.includes(name);
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (options.check === false || result.status === 0) return result;
  const output = (result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim();
  throw new Error(output);
}

function parseJsonOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('expected JSON output, got empty output');
  return JSON.parse(raw);
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

async function captureCommand(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalExitCode = process.exitCode;
  const stdout = [];
  const stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(' '));
  console.error = (...args) => stderr.push(args.map(String).join(' '));
  process.exitCode = undefined;
  process.exit = (code = 0) => {
    const error = new Error(`process.exit(${code})`);
    error.isProcessExit = true;
    error.exitCode = code;
    throw error;
  };
  try {
    const value = await fn();
    return { value, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } catch (error) {
    if (error && error.isProcessExit) {
      const output = `${stderr.join('\n')}\n${stdout.join('\n')}`.trim();
      error.message = output || `process.exit(${error.exitCode})`;
    }
    throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.exitCode = originalExitCode;
  }
}

async function withSandboxProcessState(sandboxPath, envPatch, fn) {
  const oldCwd = process.cwd();
  const previousEnv = {};
  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(sandboxPath);
  try {
    return await fn();
  } finally {
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function callInitAtris(sandboxPath) {
  const { initAtris } = require('./init');
  const oldArgv = process.argv;
  process.argv = [process.execPath, 'atris', 'init', '--yes'];
  try {
    await captureCommand(() => initAtris());
  } finally {
    process.argv = oldArgv;
  }
}

async function createSandbox(ctx) {
  ctx.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-drill-'));
  ctx.sandboxPath = path.join(ctx.tmpRoot, 'sandbox');
  fs.mkdirSync(ctx.sandboxPath, { recursive: true });
  runGit(['init', '-b', 'master'], ctx.sandboxPath);
  runGit(['config', 'user.email', 'drill@example.invalid'], ctx.sandboxPath);
  runGit(['config', 'user.name', 'Atris Drill'], ctx.sandboxPath);
  fs.writeFileSync(path.join(ctx.sandboxPath, 'README.md'), '# Atris drill sandbox\n', 'utf8');
  await withSandboxProcessState(ctx.sandboxPath, {
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(ctx.sandboxPath, '.atris', 'state', 'drill-tasks.db'),
    NODE_NO_WARNINGS: '1',
  }, async () => {
    await callInitAtris(ctx.sandboxPath);
  });
  runGit(['add', '-A'], ctx.sandboxPath);
  runGit(['commit', '-m', 'initial sandbox'], ctx.sandboxPath);
}

async function wishCaptured(ctx) {
  const { wishCommand, readWishes } = require('./wish');
  const result = await captureCommand(() => wishCommand(['fix auth']));
  assertOk(result.value === 1, `wish should request clarification with exit 1, got ${result.value}`);
  const wishes = readWishes(ctx.sandboxPath);
  assertOk(wishes.length > 0, 'wish ledger is empty');
  const latest = wishes[wishes.length - 1];
  assertOk(latest.status === 'needs_input', `wish status should be needs_input, got ${latest.status}`);
  assertOk(latest.text === 'fix auth', `wish text mismatch: ${latest.text}`);
}

async function taskClaimed(ctx) {
  const taskCommand = require('./task');
  const taskDb = require('../lib/task-db');
  const createdCapture = await captureCommand(() => taskCommand.delegateTask([
    'Prove drill task ledger health for fast factory diagnosis',
    '--to',
    'executor',
    '--executed-by',
    'drill',
    '--tag',
    'drill',
  ]));
  const created = createdCapture.value;
  assertOk(created && created.task_id, 'task delegate did not return a task_id');
  ctx.taskId = created.task_id;
  const claimed = taskDb.claimTask(taskDb.open(), { id: ctx.taskId, claimedBy: 'executor' });
  assertOk(claimed.claimed === true, `task claim failed: ${claimed.reason || 'unknown'}`);
  const row = taskDb.getTask(taskDb.open(), ctx.taskId);
  assertOk(row && row.status === 'claimed', `task should be claimed, got ${row && row.status}`);
}

async function missionStarted(ctx) {
  const { startMission } = require('./mission');
  const result = await captureCommand(() => startMission([
    'Prove drill mission receipts for fast factory diagnosis',
    '--owner',
    'executor',
    '--runner',
    'drill',
    '--verify',
    VERIFY_COMMAND,
    '--task',
    ctx.taskId,
    '--json',
  ], { silent: true }));
  const payload = result.value;
  assertOk(payload && payload.mission && payload.mission.id, 'mission start did not return a mission');
  assertOk(payload.mission.runner === 'drill', `mission runner should be drill, got ${payload.mission.runner}`);
  assertOk(payload.mission.verifier === VERIFY_COMMAND, `mission verifier mismatch: ${payload.mission.verifier}`);
  ctx.missionId = payload.mission.id;
}

async function tickVerified(ctx) {
  const missionCommand = require('./mission');
  const taskDb = require('../lib/task-db');
  const run = await captureCommand(() => missionCommand.missionCommand([
    'run',
    ctx.missionId,
    '--max-ticks',
    '1',
    '--max-wall',
    '60',
    '--complete-on-pass',
    '--json',
  ]));
  const payload = parseJsonOutput(run.stdout);
  assertOk(payload.ok === true && payload.action === 'mission_run', `mission run failed: ${run.stdout || run.stderr}`);
  assertOk(payload.ran_ticks === 1, `mission should run one tick, ran ${payload.ran_ticks}`);
  assertOk(payload.ticks && payload.ticks[0] && payload.ticks[0].drill, 'drill runner did not record a touch');
  assertOk(payload.mission && payload.mission.verifier_result && payload.mission.verifier_result.passed === true, 'mission verifier pass was not recorded');
  ctx.receiptPath = payload.mission.receipt_path;
  assertOk(ctx.receiptPath && fs.existsSync(path.join(ctx.sandboxPath, ctx.receiptPath)), `mission receipt missing: ${ctx.receiptPath}`);
  const ready = taskDb.readyTask(taskDb.open(), {
    id: ctx.taskId,
    actor: 'executor',
    proof: `Receipt saved at ${ctx.receiptPath}; ${VERIFY_COMMAND} passed in the drill sandbox.`,
    result: 'Operators can run one command to prove the local factory pipeline still works.',
  });
  assertOk(ready.ready === true, `task ready failed: ${ready.reason}`);
}

async function landingShippedLocal(ctx) {
  const worktree = require('./worktree');
  try {
    require('../lib/task-db').close();
  } catch {}
  const dirty = runGit(['status', '--porcelain'], ctx.sandboxPath).stdout.trim();
  if (dirty) {
    runGit(['add', '-A'], ctx.sandboxPath);
    runGit(['commit', '-m', 'record drill pipeline state'], ctx.sandboxPath);
  }
  ctx.landingWorktree = path.join(ctx.tmpRoot, 'landing-worktree');
  const created = worktree.createAgentWorktree({
    root: ctx.sandboxPath,
    member: 'executor',
    task: 'drill local landing',
    path: ctx.landingWorktree,
    base: 'master',
  });
  ctx.landingBranch = created.branch;
  fs.writeFileSync(path.join(ctx.landingWorktree, 'drill-landing.txt'), 'local landing ok\n', 'utf8');
  await withSandboxProcessState(ctx.landingWorktree, {}, async () => {
    const shipped = await captureCommand(() => worktree.worktreeCommand([
      'ship',
      '--message',
      'drill local landing commit',
      '--verify',
      VERIFY_COMMAND,
      '--merge',
      '--local',
      '--target',
      'master',
    ]));
    assertOk(shipped.value === 0, `worktree ship exited ${shipped.value}`);
    assertOk(/local mode/.test(`${shipped.stdout}\n${shipped.stderr}`), 'worktree ship did not report local mode');
  });
  runGit(['worktree', 'remove', ctx.landingWorktree, '--force'], ctx.sandboxPath);
  runGit(['branch', '-d', ctx.landingBranch], ctx.sandboxPath);
  const landed = runGit(['show', 'master:drill-landing.txt'], ctx.sandboxPath).stdout;
  assertOk(landed.trim() === 'local landing ok', 'landing file was not merged into sandbox master');
}

async function ledgerChecked(ctx) {
  const taskDb = require('../lib/task-db');
  const mission = require('./mission');
  const task = taskDb.getTask(taskDb.open(), ctx.taskId);
  assertOk(task && ['review', 'done'].includes(task.status), `task should be review or done, got ${task && task.status}`);
  const currentMission = mission.listMissions(ctx.sandboxPath).find((row) => row.id === ctx.missionId);
  assertOk(currentMission, `mission not found: ${ctx.missionId}`);
  assertOk(currentMission.verifier_result && currentMission.verifier_result.passed === true, 'mission verifier result is not passing');
  assertOk(currentMission.receipt_path && fs.existsSync(path.join(ctx.sandboxPath, currentMission.receipt_path)), `mission receipt missing: ${currentMission.receipt_path}`);
  const unmerged = runGit(['branch', '--no-merged', 'master'], ctx.sandboxPath).stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*/, '').trim())
    .filter(Boolean)
    .filter((line) => line !== 'master');
  assertOk(unmerged.length === 0, `unmerged local branches remain: ${unmerged.join(', ')}`);
  const worktrees = worktreeList(ctx.sandboxPath);
  assertOk(worktrees.length === 1, `expected only the primary worktree, got ${worktrees.length}`);
}

function worktreeList(root) {
  const worktree = require('./worktree');
  return worktree.listWorktrees(root);
}

const STAGE_DEFS = [
  ['sandbox ready', createSandbox],
  ['wish captured', wishCaptured],
  ['task claimed', taskClaimed],
  ['mission started', missionStarted],
  ['tick verified', tickVerified],
  ['landing shipped (local mode)', landingShippedLocal],
  ['ledger checked', ledgerChecked],
];

async function runDrill(options = {}) {
  const keep = options.keep === true;
  const reporter = typeof options.reporter === 'function' ? options.reporter : null;
  const afterStage = typeof options.afterStage === 'function' ? options.afterStage : null;
  const stages = [];
  const ctx = {};
  const oldCwd = process.cwd();
  const envPatch = {
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
  };
  const previousEnv = {};
  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  let pass = true;
  try {
    for (const [name, fn] of STAGE_DEFS) {
      const startedAt = Date.now();
      const stage = { name, ok: false, ms: 0 };
      try {
        const runInSandbox = name === 'sandbox ready'
          ? () => fn(ctx)
          : () => withSandboxProcessState(ctx.sandboxPath, {
            ATRIS_SKIP_UPDATE_CHECK: '1',
            ATRIS_TASKS_DB: path.join(ctx.sandboxPath, '.atris', 'state', 'drill-tasks.db'),
            NODE_NO_WARNINGS: '1',
          }, () => fn(ctx));
        await runInSandbox();
        stage.ok = true;
        stage.ms = Date.now() - startedAt;
        stages.push(stage);
        if (reporter) reporter(name);
        if (afterStage) await afterStage(name, ctx);
      } catch (error) {
        stage.ok = false;
        stage.ms = Date.now() - startedAt;
        stage.error = error && error.message ? String(error.message) : String(error);
        stages.push(stage);
        pass = false;
        break;
      }
    }
    return {
      pass,
      stages,
      sandbox_path: ctx.sandboxPath || null,
      tmp_root: ctx.tmpRoot || null,
      kept: keep,
    };
  } finally {
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      require('../lib/task-db').close();
    } catch {}
    if (!keep && ctx.tmpRoot) {
      fs.rmSync(ctx.tmpRoot, { recursive: true, force: true });
    }
  }
}

async function drillCommand(args = []) {
  const asJson = hasFlag(args, '--json');
  const keep = hasFlag(args, '--keep');
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    console.log('Usage: atris drill [--json] [--keep]');
    console.log('');
    console.log('Runs a no-LLM end-to-end drill in a throwaway sandbox repo.');
    return 0;
  }
  const startedAt = Date.now();
  const result = await runDrill({
    keep,
    reporter: asJson ? null : (line) => console.log(line),
  });
  if (asJson) {
    console.log(JSON.stringify({ stages: result.stages, pass: result.pass }, null, 2));
  } else if (result.pass) {
    console.log(`PASS ${Date.now() - startedAt}ms`);
  } else {
    const failed = result.stages.find((stage) => !stage.ok) || result.stages[result.stages.length - 1];
    console.log(`FAIL ${failed.name}: ${failed.error}`);
  }
  if (keep && result.sandbox_path) {
    console.log(`sandbox kept: ${result.sandbox_path}`);
  }
  return result.pass ? 0 : 1;
}

module.exports = {
  COAUTHOR,
  VERIFY_COMMAND,
  drillCommand,
  runDrill,
};
