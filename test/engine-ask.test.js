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
  buildAskSpawnEnv,
  runAskProcess,
  runEngineAskJobs,
  runEngineAskCommand,
} = require('../lib/engine-ask');
const {
  readEngineRegistry,
  resolveEngineForRoleRanked,
  setEngineHealth,
} = require('../lib/engine-registry');
const { engineCommand } = require('../commands/engine');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-ask-'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
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

test('claude and fable ask spawn env pins USER to the OS username when a parent set a display name', async () => {
  const osUser = os.userInfo().username;
  assert.ok(osUser);
  const built = buildAskSpawnEnv({
    PATH: '/bin',
    HOME: '/Users/keshavrao',
    USER: 'keshav',
    LOGNAME: 'keshav',
    TERM: 'xterm',
  });
  assert.equal(built.USER, osUser);
  assert.equal(built.LOGNAME, osUser);
  assert.equal(built.PATH, '/bin');
  assert.equal(built.HOME, '/Users/keshavrao');
  assert.equal(built.TERM, 'xterm');
  assert.equal(built.ANTHROPIC_API_KEY, undefined);

  for (const engine of ['claude', 'fable']) {
    const invocation = buildReadOnlyEngineInvocation(engine, 'say hi');
    assert.equal(invocation.engine, engine);
    assert.match(String(invocation.bin), /claude/);
  }

  const previousUser = process.env.USER;
  const previousLogname = process.env.LOGNAME;
  process.env.USER = 'keshav';
  process.env.LOGNAME = 'keshav';
  let spawnedEnv;
  try {
    const invocation = {
      ...buildReadOnlyEngineInvocation('fable', 'say hi'),
      ...fakeReplyInvocation({ stdout: 'hi' }),
    };
    const result = await runAskProcess(invocation, {
      timeoutMs: 1000,
      spawnProcess: (bin, args, options) => {
        spawnedEnv = options.env;
        return spawn(bin, args, options);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(spawnedEnv.USER, osUser);
    assert.equal(spawnedEnv.LOGNAME, osUser);
    assert.notEqual(spawnedEnv.USER, 'keshav');
    assert.equal(spawnedEnv.PATH, process.env.PATH);
    assert.equal(spawnedEnv.HOME, process.env.HOME);
    assert.equal(
      Object.prototype.hasOwnProperty.call(spawnedEnv, 'ANTHROPIC_API_KEY'),
      Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY'),
    );
  } finally {
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
    if (previousLogname === undefined) delete process.env.LOGNAME;
    else process.env.LOGNAME = previousLogname;
  }
});

test('Fable defaults to the real model and gets a deep-reasoning timeout', () => {
  const parsed = parseEngineAskArgs(['find the real cause', '--engine', 'fable']);
  assert.equal(parsed.jobs[0].model, 'claude-fable-5');
  assert.equal(parsed.timeoutMs, 10 * 60 * 1000);

  const overridden = parseEngineAskArgs(['find the real cause', '--engine', 'fable', '--timeout', '30']);
  assert.equal(overridden.timeoutMs, 30000);

  const invocation = buildReadOnlyEngineInvocation('fable', 'find the real cause');
  assert.deepEqual(invocation.args.slice(2, 4), ['--model', 'claude-fable-5']);
  assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(!invocation.args.includes('--safe-mode'));
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

  const agy = buildReadOnlyEngineInvocation('agy', 'inspect the router', 'gemini-3.1-pro-high');
  // Read-only safety comes from the sandbox; skip-permissions must ride WITH
  // it because agy prompts even in plan mode and a headless ask has no one to
  // answer (it denied its own `ls` and failed every ask, live 2026-08-19).
  assert.deepEqual(agy.args.slice(0, 4), ['--mode', 'plan', '--sandbox', '--dangerously-skip-permissions']);
  assert.deepEqual(agy.args.slice(4, 6), ['--model', 'gemini-3.1-pro-high']);
  assert.doesNotMatch(agy.args.join(' '), /accept-edits/);
  assert.ok(agy.args.includes('--sandbox'), 'skip-permissions is only acceptable inside the sandbox');

  const grok = buildReadOnlyEngineInvocation('grok', 'inspect the router', 'grok-composer-2.5-fast');
  assert.deepEqual(grok.args.slice(4, 6), ['--sandbox', 'read-only']);
  assert.deepEqual(grok.args.slice(6, 8), ['--model', 'grok-composer-2.5-fast']);

  const opencode = buildReadOnlyEngineInvocation('opencode', 'inspect the router', 'opencode/big-pickle');
  assert.deepEqual(opencode.args.slice(0, 2), ['--agent', 'plan']);
  assert.deepEqual(opencode.args.slice(2, 4), ['-m', 'opencode/big-pickle']);

  for (const engine of ['atris-fast', 'claude', 'codex', 'cursor', 'fable', 'composer', 'haiku', 'devin', 'grok', 'agy', 'opencode']) {
    const invocation = buildReadOnlyEngineInvocation(engine, 'read only');
    assert.doesNotMatch(invocation.args.join(' '), /(?:^|\s)--worktree(?:\s|$)/);
    assert.match(invocation.args.join(' '), /Do not modify files/);
  }
});

test('an unsupported requested model fails its job honestly without spawning an engine', async () => {
  const [answer] = await runEngineAskJobs([
    { engine: 'atris-fast', model: 'opus', prompt: 'inspect the router', label: 'atris-fast' },
  ]);
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'model_not_supported');
  assert.match(answer.stderr, /atris-fast does not support model selection/);
});

test('fake engine commands run in parallel up to the cap and preserve every answer', async () => {
  let active = 0;
  let peak = 0;
  const jobs = [
    { engine: 'codex', prompt: 'one', label: 'one' },
    { engine: 'cursor', prompt: 'two', label: 'two' },
    { engine: 'claude', prompt: 'three', label: 'three' },
    { engine: 'agy', prompt: 'four', label: 'four' },
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
    await waitUntil(() => !processIsAlive(launchedGrandchild), 5000)
      .catch(() => assert.fail('the ask process tree must be gone'));
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
    }, { cwd: root, timeoutMs: 1000 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.reason, 'timeout');
    assert.equal(timedOut.stdout, '');
    assert.equal(timedOut.stderr, '');
    await waitUntil(() => fs.existsSync(pidFile), 2000)
      .catch(() => assert.fail('silent engine must write its pid before timeout'));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await wait(100);
    assert.equal(processIsAlive(pid), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('command prints labeled statuses and writes its receipt plus engine health', async () => {
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
    const receiptFiles = fs.readdirSync(runsDir).filter((file) => file.startsWith('engine-ask-') && file.endsWith('.json'));
    assert.equal(receiptFiles.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(runsDir, receiptFiles[0]), 'utf8'));
    assert.equal(receipt.read_only, true);
    assert.deepEqual(receipt.summary, { answered: 1, failed: 1, timed_out: 1, cancelled: 0 });
    assert.equal(receipt.status, 'timed_out');
    assert.match(receipt.live_log, /^atris\/runs\/engine-ask-.+[.]live[.]log$/);
    assert.equal(fs.existsSync(path.join(root, receipt.live_log)), true);
    assert.equal(Number.isInteger(receipt.pid), true);
    assert.equal(Number.isInteger(receipt.pgid), true);
    assert.deepEqual(receipt.answers.map((answer) => answer.model), ['gpt-5.6', 'gpt-5.6', 'gpt-5.6']);
    assert.deepEqual(receipt.answers.map((answer) => answer.status), ['answered', 'failed', 'timed out']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.atris', 'atris']);
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
    const registry = readEngineRegistry(root, { persist: false });
    assert.equal(registry.engines.find((engine) => engine.id === 'codex').health.status, 'ready');
    assert.equal(registry.engines.find((engine) => engine.id === 'cursor').health.status, 'error');
    // A timeout is transient: 'error' keeps the engine routable instead of
    // dropping it from routing as if the binary were missing.
    assert.equal(registry.engines.find((engine) => engine.id === 'claude').health.status, 'error');
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine ask benches an expired subscription and a later answer restores ready', async () => {
  const root = tempRoot();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const failed = await runEngineAskCommand(['check access', '--engine', 'codex'], root, {
      executeAskJob: async () => ({
        ok: false,
        reason: 'exit_1',
        exit_code: 1,
        signal: null,
        timed_out: false,
        cancelled: false,
        stdout: '',
        stderr: 'Not authenticated. Your subscription has expired. Please log in.',
        output_truncated: false,
        duration_ms: 1,
      }),
    });
    assert.equal(failed, 1);
    setEngineHealth('cursor', 'ready', root);
    let registry = readEngineRegistry(root, { persist: false });
    assert.equal(registry.engines.find((engine) => engine.id === 'codex').health.status, 'credit_out');
    assert.ok(!resolveEngineForRoleRanked('executor', root).ranked.some((engine) => engine.id === 'codex'));

    const recovered = await runEngineAskCommand(['check access', '--engine', 'codex'], root, {
      executeAskJob: async () => ({
        ok: true,
        reason: 'ok',
        exit_code: 0,
        signal: null,
        timed_out: false,
        cancelled: false,
        stdout: 'access restored',
        stderr: '',
        output_truncated: false,
        duration_ms: 1,
      }),
    });
    assert.equal(recovered, 0);
    registry = readEngineRegistry(root, { persist: false });
    assert.equal(registry.engines.find((engine) => engine.id === 'codex').health.status, 'ready');
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('chunked engine output reaches the receipt live log before process exit', async () => {
  const root = tempRoot();
  const engineScript = [
    "process.stdout.write('first live chunk\\n');",
    "setTimeout(() => process.stderr.write('second live chunk\\n'), 350);",
    'setTimeout(() => process.exit(0), 700);',
  ].join('\n');
  const originalLog = console.log;
  console.log = () => {};
  let settled = false;
  const runningCommand = runEngineAskCommand(['watch me', '--engine', 'codex'], root, {
    executeAskJob: (_job, context) => runAskProcess({
      bin: process.execPath,
      args: ['-e', engineScript],
    }, {
      cwd: root,
      timeoutMs: 3000,
      signal: context.signal,
      onOutputChunk: context.onOutputChunk,
    }),
  }).finally(() => { settled = true; });
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    await waitUntil(() => {
      if (!fs.existsSync(runsDir)) return false;
      const file = fs.readdirSync(runsDir).find((name) => name.endsWith('.json'));
      if (!file) return false;
      const receipt = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
      return Boolean(receipt.live_log && fs.existsSync(path.join(root, receipt.live_log)));
    }, 2000);
    const receiptFile = fs.readdirSync(runsDir).find((name) => name.endsWith('.json'));
    const receiptPath = path.join(runsDir, receiptFile);
    const running = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.match(running.live_log, /^atris\/runs\/engine-ask-.+[.]live[.]log$/);
    const liveLogPath = path.join(root, running.live_log);
    await waitUntil(() => fs.readFileSync(liveLogPath, 'utf8').includes('first live chunk'), 2000);
    assert.equal(settled, false, 'the dispatch must still be running when its first chunk is readable');
    assert.equal(await runningCommand, 0);
    assert.match(fs.readFileSync(liveLogPath, 'utf8'), /first live chunk[\s\S]*second live chunk/);
    const completed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.live_log, running.live_log);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('killing an ask mid-run leaves a running receipt with its pid and pgid', async () => {
  if (process.platform === 'win32') return;
  const root = tempRoot();
  const runner = path.join(root, 'kill-mid-ask.js');
  const engineAskModule = path.join(__dirname, '..', 'lib', 'engine-ask.js');
  fs.writeFileSync(runner, [
    `'use strict';`,
    `const { runEngineAskCommand } = require(${JSON.stringify(engineAskModule)});`,
    `runEngineAskCommand(['wait', '--engine', 'codex'], ${JSON.stringify(root)}, {`,
    `  executeAskJob: () => new Promise(() => setInterval(() => {}, 1000)),`,
    `}).catch(() => {});`,
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [runner], { cwd: root, detached: true, stdio: 'ignore' });
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    await waitUntil(() => fs.existsSync(runsDir) && fs.readdirSync(runsDir).some((file) => file.startsWith('engine-ask-') && file.endsWith('.json')), 2000);
    const receiptFile = fs.readdirSync(runsDir).find((file) => file.startsWith('engine-ask-') && file.endsWith('.json'));
    const receiptPath = path.join(runsDir, receiptFile);
    const running = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(running.status, 'running');
    assert.equal(running.pid, child.pid);
    assert.equal(running.pgid, child.pid);
    assert.equal(running.engine, 'codex');
    assert.match(running.started_at, /^\d{4}-\d{2}-\d{2}T/);

    const closed = new Promise((resolve) => child.once('close', resolve));
    process.kill(-child.pid, 'SIGKILL');
    await closed;
    const stranded = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(stranded.status, 'running');
    assert.equal(processIsAlive(stranded.pid), false);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aborting an ask finalizes its receipt as cancelled', async () => {
  const root = tempRoot();
  const abort = new AbortController();
  try {
    const running = runEngineAskCommand(['wait', '--engine', 'codex'], root, {
      abortController: abort,
      executeAskJob: (_job, context) => runAskProcess(fakeReplyInvocation({ hang: true }), {
        cwd: root,
        timeoutMs: 5000,
        signal: context.signal,
      }),
    });
    await wait(30);
    abort.abort();
    assert.equal(await running, 1);
    const runsDir = path.join(root, 'atris', 'runs');
    const receiptFile = fs.readdirSync(runsDir).find((file) => file.startsWith('engine-ask-') && file.endsWith('.json'));
    const receipt = JSON.parse(fs.readFileSync(path.join(runsDir, receiptFile), 'utf8'));
    assert.equal(receipt.status, 'cancelled');
    assert.equal(receipt.summary.cancelled, 1);
    assert.match(receipt.finished_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
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

test('engine name with model and trailing text routes through ask without changing the default', async () => {
  const root = tempRoot();
  const jobs = [];
  const output = [];
  const originalLog = console.log;
  console.log = (line = '') => output.push(String(line));
  try {
    const code = await engineCommand(['fable', '--model', 'opus', 'explain', 'the failure', 'today'], {
      root,
      engineAsk: {
        executeAskJob: async (job) => {
          jobs.push(job);
          return {
            ok: true,
            reason: 'answered',
            exit_code: 0,
            signal: null,
            timed_out: false,
            cancelled: false,
            stdout: 'answer',
            stderr: '',
            output_truncated: false,
            duration_ms: 1,
          };
        },
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(jobs.map(({ engine, model, prompt }) => ({ engine, model, prompt })), [
      { engine: 'fable', model: 'opus', prompt: 'explain the failure today' },
    ]);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'engine.json')), false);
    assert.match(output.join('\n'), /fable \(fable\)\nanswer/);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported shorthand model fails before ask and names known-good examples', async () => {
  const root = tempRoot();
  const errors = [];
  let askCalled = false;
  const originalError = console.error;
  console.error = (line = '') => errors.push(String(line));
  try {
    const code = await engineCommand(['atris-fast', '--model', 'opus', 'inspect', 'the router'], {
      root,
      engineAsk: {
        executeAskJob: async () => {
          askCalled = true;
          throw new Error('ask should not start');
        },
      },
    });
    assert.equal(code, 2);
    assert.equal(askCalled, false);
    assert.match(errors.join('\n'), /atris-fast does not support model selection/);
    assert.match(errors.join('\n'), /known-good atris-fast examples: atris fast/);
  } finally {
    console.error = originalError;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
