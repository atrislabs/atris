'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  MAX_ASK_CONCURRENCY,
  MAX_ASK_JOBS,
  MAX_ASK_PROMPT_BYTES,
  parseEngineAskArgs,
  buildReadOnlyEngineInvocation,
  runAskProcess,
  runEngineAskJobs,
  runEngineAskCommand,
} = require('../lib/engine-ask');
const { engineCommand } = require('../commands/engine');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-ask-'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function fakeReplyInvocation({ stdout = '', stderr = '', delayMs = 0, exitCode = 0, hang = false } = {}) {
  const script = [
    `const stdout = ${JSON.stringify(stdout)};`,
    `const stderr = ${JSON.stringify(stderr)};`,
    `const delayMs = ${JSON.stringify(delayMs)};`,
    `const exitCode = ${JSON.stringify(exitCode)};`,
    `const hang = ${JSON.stringify(hang)};`,
    'setTimeout(() => {',
    "  if (stdout) process.stdout.write(stdout + '\\n');",
    "  if (stderr) process.stderr.write(stderr + '\\n');",
    '  if (hang) setInterval(() => {}, 1000);',
    '  else process.exit(exitCode);',
    '}, delayMs);',
  ].join('\n');
  return { bin: process.execPath, args: ['-e', script] };
}

test('shared questions fan out with one model and jobs files may pin models independently', () => {
  const shared = parseEngineAskArgs([
    'compare these tradeoffs',
    '--engine', 'codex',
    '--engine=cursor',
    '--model', 'grok-4.5-xhigh',
    '--concurrency', '2',
    '--timeout=9',
  ]);
  assert.deepEqual(shared.jobs.map(({ engine, model, prompt, label }) => ({ engine, model, prompt, label })), [
    { engine: 'codex', model: 'grok-4.5-xhigh', prompt: 'compare these tradeoffs', label: 'codex' },
    { engine: 'cursor', model: 'grok-4.5-xhigh', prompt: 'compare these tradeoffs', label: 'cursor' },
  ]);
  assert.equal(shared.concurrency, 2);
  assert.equal(shared.timeoutMs, 9000);

  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'jobs.json'), JSON.stringify([
      { engine: 'cursor', model: 'grok-4.5-xhigh', prompt: 'compare the interface' },
      { engine: 'cursor', model: 'kimi-k2.5', prompt: 'compare the interface' },
      { engine: 'claude', model: 'opus', prompt: 'review the interface', label: 'interface review' },
    ]));
    const separate = parseEngineAskArgs(['--jobs', 'jobs.json'], { root });
    assert.deepEqual(separate.jobs.map(({ engine, model, prompt, label }) => ({ engine, model, prompt, label })), [
      { engine: 'cursor', model: 'grok-4.5-xhigh', prompt: 'compare the interface', label: 'cursor-1' },
      { engine: 'cursor', model: 'kimi-k2.5', prompt: 'compare the interface', label: 'cursor-2' },
      { engine: 'claude', model: 'opus', prompt: 'review the interface', label: 'interface review' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask limits cap total cost, concurrency, and timeout before any engine starts', () => {
  const tooMany = [];
  for (let index = 0; index < MAX_ASK_JOBS + 1; index += 1) tooMany.push('--engine', 'codex');
  assert.throws(() => parseEngineAskArgs(['question', ...tooMany]), /at most 8 jobs/);
  assert.throws(
    () => parseEngineAskArgs(['question', '--engine', 'codex', '--concurrency', String(MAX_ASK_CONCURRENCY + 1)]),
    /--concurrency must be an integer/
  );
  assert.throws(
    () => parseEngineAskArgs(['question', '--engine', 'codex', '--timeout', '601']),
    /--timeout must be an integer/
  );
  assert.throws(
    () => parseEngineAskArgs(['x'.repeat(MAX_ASK_PROMPT_BYTES + 1), '--engine', 'codex']),
    /prompt must be 16384 bytes or fewer/
  );
  assert.throws(
    () => parseEngineAskArgs(['x'.repeat(MAX_ASK_PROMPT_BYTES), ...Array.from({ length: 5 }, () => ['--engine', 'codex']).flat()]),
    /at most 65536 prompt bytes per run/
  );
});

test('model-capable engines receive exact model flags without weakening read-only mode', () => {
  const codex = buildReadOnlyEngineInvocation('codex', 'inspect the router', 'gpt-5.6');
  assert.deepEqual(codex.args.slice(1, 3), ['-m', 'gpt-5.6']);
  assert.deepEqual(codex.args.slice(3, 6), ['--sandbox', 'read-only', '--ephemeral']);

  const cursor = buildReadOnlyEngineInvocation('cursor', 'inspect the router', 'kimi-k2.5');
  assert.ok(cursor.args.includes('ask'));
  assert.ok(cursor.args.includes('enabled'));
  assert.deepEqual(cursor.args.slice(1, 3), ['--model', 'kimi-k2.5']);
  assert.equal(cursor.cwd, os.homedir(), 'cursor asks launch from home to skip its per-directory startup tax');
  assert.equal(buildReadOnlyEngineInvocation('grok', 'inspect the router').cwd, undefined, 'other engines keep the workspace cwd');

  const claude = buildReadOnlyEngineInvocation('claude', 'inspect the router', 'opus');
  assert.ok(claude.args.includes('plan'));
  assert.deepEqual(claude.args.slice(2, 4), ['--model', 'opus']);
  assert.match(claude.args.join(' '), /Read,Glob,Grep,WebSearch,WebFetch/);
  assert.doesNotMatch(claude.args.join(' '), /(?:Bash|Edit)/);

  const haiku = buildReadOnlyEngineInvocation('haiku', 'inspect the router', 'opus');
  assert.deepEqual(haiku.args.slice(2, 4), ['--model', 'opus']);

  const devin = buildReadOnlyEngineInvocation('devin', 'inspect the router', 'swe-1.7');
  assert.ok(devin.args.includes('auto'));
  assert.deepEqual(devin.args.slice(2, 4), ['--model', 'swe-1.7']);
  assert.doesNotMatch(devin.args.join(' '), /(?:dangerous|accept-edits)/);

  const droid = buildReadOnlyEngineInvocation('droid', 'inspect the router');
  assert.doesNotMatch(droid.args.join(' '), /(?:--auto|skip-permissions-unsafe)/);

  const grok = buildReadOnlyEngineInvocation('grok', 'inspect the router', 'grok-composer-2.5-fast');
  assert.deepEqual(grok.args.slice(4, 6), ['--sandbox', 'read-only']);
  assert.deepEqual(grok.args.slice(6, 8), ['--model', 'grok-composer-2.5-fast']);

  for (const engine of ['atris-fast', 'claude', 'codex', 'cursor', 'fable', 'composer', 'haiku', 'devin', 'grok', 'droid']) {
    const invocation = buildReadOnlyEngineInvocation(engine, 'read only');
    assert.doesNotMatch(invocation.args.join(' '), /(?:^|\s)--worktree(?:\s|$)/);
    assert.match(invocation.args.join(' '), /Do not modify files/);
  }
});

test('an unsupported requested model fails its job honestly without spawning an engine', async () => {
  const [answer] = await runEngineAskJobs([
    { engine: 'droid', model: 'opus', prompt: 'inspect the router', label: 'droid' },
  ]);
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'model_not_supported');
  assert.match(answer.stderr, /droid does not support model selection/);
});

test('fake engine commands run in parallel up to the cap and preserve every answer', async () => {
  let active = 0;
  let peak = 0;
  const jobs = [
    { engine: 'codex', prompt: 'one', label: 'one' },
    { engine: 'cursor', prompt: 'two', label: 'two' },
    { engine: 'claude', prompt: 'three', label: 'three' },
    { engine: 'droid', prompt: 'four', label: 'four' },
  ];
  const answers = await runEngineAskJobs(jobs, {
    concurrency: 2,
    executeAskJob: async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      const result = await runAskProcess(fakeReplyInvocation({
        stdout: job.label === 'two' ? '' : `${job.label} answer`,
        stderr: job.label === 'two' ? 'engine failed' : '',
        delayMs: 40,
        exitCode: job.label === 'two' ? 7 : 0,
      }), { timeoutMs: 1000 });
      active -= 1;
      return result;
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(answers.map((answer) => answer.label), ['one', 'two', 'three', 'four']);
  assert.equal(answers[0].stdout.trim(), 'one answer');
  assert.equal(answers[1].reason, 'exit_7');
  assert.equal(answers[3].stdout.trim(), 'four answer');
});

test('timeout kills only the process group launched for that ask', async () => {
  if (process.platform === 'win32') return;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  unrelated.unref();
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const grandchildCode = 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000)';",
    "const child = spawn(process.execPath, ['-e', grandchildCode], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid) + '\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
  ].join('\n');

  try {
    const result = await runAskProcess({
      bin: process.execPath,
      args: ['-e', childScript],
    }, { timeoutMs: 100 });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.timed_out, true);
    const launchedGrandchild = Number(result.stdout.trim());
    assert.ok(Number.isInteger(launchedGrandchild));
    await wait(100);
    assert.equal(processIsAlive(launchedGrandchild), false, 'the ask process tree must be gone');
    assert.equal(processIsAlive(unrelated.pid), true, 'an unrelated process must stay alive');
  } finally {
    try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {}
  }
});

test('silent fake engines fail or time out honestly and leave no process behind', async () => {
  const empty = await runAskProcess(fakeReplyInvocation(), { timeoutMs: 1000 });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no_output');
  assert.equal(empty.exit_code, 0);

  if (process.platform === 'win32') return;
  const root = tempRoot();
  const pidFile = path.join(root, 'silent.pid');
  const silentScript = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  try {
    const timedOut = await runAskProcess({
      bin: process.execPath,
      args: ['-e', silentScript],
    }, { cwd: root, timeoutMs: 100 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.reason, 'timeout');
    assert.equal(timedOut.stdout, '');
    assert.equal(timedOut.stderr, '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await wait(100);
    assert.equal(processIsAlive(pid), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('command prints labeled statuses and writes only its receipt', async () => {
  const root = tempRoot();
  const output = [];
  const originalLog = console.log;
  console.log = (line = '') => output.push(String(line));
  try {
    const code = await runEngineAskCommand([
      'one question',
      '--engine', 'codex',
      '--engine', 'cursor',
      '--engine', 'claude',
      '--model', 'gpt-5.6',
      '--concurrency', '2',
    ], root, {
      now: () => new Date('2026-08-12T05:30:00.000Z'),
      executeAskJob: async (job) => {
        if (job.engine === 'codex') {
          return runAskProcess(fakeReplyInvocation({ stdout: 'codex answer' }), { cwd: root, timeoutMs: 1000 });
        }
        if (job.engine === 'cursor') {
          return runAskProcess(fakeReplyInvocation(), { cwd: root, timeoutMs: 1000 });
        }
        return runAskProcess(fakeReplyInvocation({ hang: true }), { cwd: root, timeoutMs: 40 });
      },
    });
    assert.equal(code, 1);
    const printed = output.join('\n');
    assert.match(printed, /codex \(codex\)\ncodex answer/);
    assert.match(printed, /cursor \(cursor\)\nfailed: no output/);
    assert.match(printed, /claude \(claude\)\nfailed: timed out/);
    assert.match(printed, /codex \(codex\): answered/);
    assert.match(printed, /cursor \(cursor\): failed/);
    assert.match(printed, /claude \(claude\): timed out/);
    const runsDir = path.join(root, 'atris', 'runs');
    const receiptFiles = fs.readdirSync(runsDir).filter((file) => file.startsWith('engine-ask-'));
    assert.equal(receiptFiles.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(runsDir, receiptFiles[0]), 'utf8'));
    assert.equal(receipt.read_only, true);
    assert.deepEqual(receipt.summary, { answered: 1, failed: 1, timed_out: 1 });
    assert.deepEqual(receipt.answers.map((answer) => answer.model), ['gpt-5.6', 'gpt-5.6', 'gpt-5.6']);
    assert.deepEqual(receipt.answers.map((answer) => answer.status), ['answered', 'failed', 'timed out']);
    assert.deepEqual(fs.readdirSync(root), ['atris']);
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine command routes ask help without entering the build dispatcher', async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (line = '') => output.push(String(line));
  try {
    const code = await engineCommand(['ask', '--help']);
    assert.equal(code, 0);
    assert.match(output.join('\n'), /atris engine ask "<question>"/);
  } finally {
    console.log = originalLog;
  }
});
