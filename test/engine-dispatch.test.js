'use strict';

// Regression coverage for `atris engine dispatch <task-id> --engine cursor|codex`
// (CLI-863): the one-command replacement for the 6-Bash-call manual loop
// (claim -> worktree start -> prompt file -> engine -p -> verify -> ship).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../lib/fleet');
const engine = require('../commands/engine');

// runDispatchFlight writes a receipt under <root>/atris/runs, so flight tests
// need a real writable directory (a fake path like '/root' cannot mkdir).
function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-dispatch-root-'));
}

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget so operators stop retyping. Done: widget renders once, test included. Check: node --test test/widget.test.js.',
};

test('dispatchCheck prefers the narrow node --test extraction when present', () => {
  assert.equal(fleet.dispatchCheck(TASK), 'node --test test/widget.test.js');
});

test('dispatchCheck falls back to the full Check: text when it is not a node --test command', () => {
  const task = { title: 'Ship it. Done: x. Check: npm run lint && npm run build.' };
  assert.equal(fleet.dispatchCheck(task), 'npm run lint && npm run build.');
});

test('isSafeLane reads the canonical singular task tag', () => {
  assert.equal(fleet.isSafeLane({ title: 'ship it', tag: 'deploy' }), false);
  assert.equal(fleet.isSafeLane({ title: 'fix it', tag: 'code' }), true);
});

test('parseDispatchArgs separates positional task ids from --engine/--prompt-file values', () => {
  const parsed = engine.parseDispatchArgs(['CLI-1', 'CLI-2', '--engine', 'cursor', '--prompt-file', 'p.md', '--json', '--yolo']);
  assert.deepEqual(parsed.taskIds, ['CLI-1', 'CLI-2']);
  assert.equal(parsed.engine, 'cursor');
  assert.equal(parsed.promptFile, 'p.md');
  assert.equal(parsed.json, true);
  assert.equal(parsed.yolo, true);
});

test('parseDispatchArgs supports --flag=value form', () => {
  const parsed = engine.parseDispatchArgs(['CLI-1', '--engine=codex', '--prompt-file=/tmp/p.md']);
  assert.deepEqual(parsed.taskIds, ['CLI-1']);
  assert.equal(parsed.engine, 'codex');
  assert.equal(parsed.promptFile, '/tmp/p.md');
  assert.equal(parsed.yolo, false);
});

test('buildEngineCommand pins yolo flags for codex and claude engines', () => {
  assert.equal(fleet.YOLO_ENGINE_FLAGS.codex, '--dangerously-bypass-approvals-and-sandbox');
  assert.equal(fleet.YOLO_ENGINE_FLAGS.claude, '--dangerously-skip-permissions');

  const codex = fleet.buildEngineCommand('codex', '/tmp/p.md', { yolo: true });
  assert.match(codex, /^codex exec --dangerously-bypass-approvals-and-sandbox /);
  assert.doesNotMatch(fleet.buildEngineCommand('codex', '/tmp/p.md'), /dangerously-bypass-approvals-and-sandbox/);

  const claude = fleet.buildEngineCommand('claude', '/tmp/p.md', { yolo: true });
  assert.match(claude, /--dangerously-skip-permissions$/);
  assert.doesNotMatch(fleet.buildEngineCommand('claude', '/tmp/p.md'), /dangerously-skip-permissions/);
});

test('buildEngineCommand enables each engine native sandbox for one-lap execution', () => {
  assert.match(fleet.buildEngineCommand('codex', '/tmp/p.md', { sealed: true }), /--sandbox workspace-write.*--ephemeral.*--ignore-user-config/);
  assert.match(fleet.buildEngineCommand('claude', '/tmp/p.md', { sealed: true }), /--safe-mode.*--permission-mode acceptEdits.*"enabled":true/);
  assert.match(fleet.buildEngineCommand('cursor', '/tmp/p.md', { sealed: true }), /--sandbox enabled/);
  assert.match(fleet.buildEngineCommand('devin', '/tmp/p.md', { sealed: true }), /--sandbox --permission-mode accept-edits/);
  const grok = fleet.buildEngineCommand('grok', '/tmp/p.md', { sealed: true });
  assert.match(grok, /--sandbox enabled.*--permission-mode acceptEdits/);
  assert.doesNotMatch(grok, /--always-approve/);
});

test('runDispatchCommand refuses without a task id or engine', () => {
  const before = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  try {
    assert.equal(engine.runDispatchCommand([], process.cwd()), 2);
    assert.equal(engine.runDispatchCommand(['CLI-1'], process.cwd()), 2);
    assert.ok(lines.some((l) => /usage: atris engine dispatch/.test(l)));
  } finally {
    console.error = before;
  }
});

test('runDispatchCommand refuses an engine that cannot build headlessly', () => {
  const before = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  try {
    // atris-fast is a real, installed, valid runner profile, but a chat lane
    // (not FLEET_CAPABLE) - dispatch must refuse it, not silently misroute.
    const code = engine.runDispatchCommand(['CLI-1', '--engine', 'atris-fast'], process.cwd());
    assert.equal(code, 2);
    assert.ok(lines.some((l) => /--engine must be one of/.test(l)));
  } finally {
    console.error = before;
  }
});

test('runDispatchCommand refuses an unknown engine name', () => {
  const before = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  try {
    assert.equal(engine.runDispatchCommand(['CLI-1', '--engine', 'not-a-real-engine'], process.cwd()), 2);
  } finally {
    console.error = before;
  }
});

test('runDispatchCommand refuses --prompt-file with more than one task id', () => {
  const before = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  const prevPath = process.env.PATH;
  try {
    // Keep cursor-agent resolvable so the failure is specifically about
    // --prompt-file + multiple ids, not "not installed".
    const code = engine.runDispatchCommand(
      ['CLI-1', 'CLI-2', '--engine', 'cursor', '--prompt-file', '/tmp/does-not-matter.md'],
      process.cwd()
    );
    assert.equal(code, 2);
    assert.ok(lines.some((l) => /--prompt-file only supports a single task id/.test(l)));
  } finally {
    process.env.PATH = prevPath;
    console.error = before;
  }
});

test('runDispatchCommand refuses an engine whose CLI is not installed here', () => {
  const before = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const code = engine.runDispatchCommand(['CLI-1', '--engine', 'cursor'], process.cwd());
    assert.equal(code, 2);
    assert.ok(lines.some((l) => /is not installed here/.test(l)));
  } finally {
    process.env.PATH = prevPath;
    console.error = before;
  }
});

test('runDispatchFlight requires an engine and at least one task id', async () => {
  await assert.rejects(fleet.runDispatchFlight({ taskIds: ['CLI-1'] }), /engine is required/);
  await assert.rejects(fleet.runDispatchFlight({ taskIds: [], engine: 'cursor' }), /at least one task id/);
  await assert.rejects(fleet.runDispatchFlight({ taskIds: ['CLI-1'], engine: 'atris-fast' }), /cannot build headlessly/);
});

test('runDispatchFlight refuses --prompt-file with more than one task id', async () => {
  await assert.rejects(
    fleet.runDispatchFlight({ taskIds: ['CLI-1', 'CLI-2'], engine: 'cursor', prompt: 'custom prompt text' }),
    /only supports a single task id/
  );
});

test('runDispatchFlight review-only requires an explicit allowlisted verifier', async () => {
  const tmpRoot = makeTempRoot();
  try {
    await assert.rejects(
      fleet.runDispatchFlight({
        root: tmpRoot,
        taskIds: ['CLI-900'],
        engine: 'cursor',
        reviewOnly: true,
      }),
      /review-only dispatch requires an explicit verifier command/
    );
    await assert.rejects(
      fleet.runDispatchFlight({
        root: tmpRoot,
        taskIds: ['CLI-900'],
        engine: 'cursor',
        reviewOnly: true,
        verifierCommand: 'node --test test/widget.test.js && rm -rf .',
      }),
      /verifier command is not allowed/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function ownCliFake({ tasks, worktreeFor }) {
  const calls = [];
  return {
    calls,
    cli: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'show') {
        const task = tasks[args[2]];
        return { status: task ? 0 : 1, stdout: task ? JSON.stringify(task) : '', stderr: task ? '' : 'not found' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        const taskArg = args[args.indexOf('--task') + 1] || '';
        const wt = worktreeFor(taskArg);
        return wt
          ? { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' }
          : { status: 2, stdout: '', stderr: 'refusing' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
  };
}

test('runDispatchFlight happy path: claims, builds, re-verifies for real, ships, and readies with the actual output', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const verifyCalls = [];
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'agent report tail' }),
      lander: undefined,
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: (command, cwd) => {
        verifyCalls.push({ command, cwd });
        return { status: 0, stdout: '# tests 3\n# pass 3\n# fail 0\n', stderr: '' };
      },
    });

    assert.deepEqual(flight.landed.map((l) => l.task), ['CLI-900']);
    assert.equal(flight.paused.length, 0);
    assert.equal(flight.results[0].engine, 'cursor');
    assert.equal(flight.results[0].restaffed, undefined);
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].command, 'node --test test/widget.test.js');
    assert.equal(verifyCalls[0].cwd, '/wt/dispatch-cli-900');

    assert.ok(calls.some((c) => c === 'task claim CLI-900 --as fleet-cursor'));
    assert.ok(calls.some((c) => c.startsWith('worktree start --agent cursor --task dispatch-cli-900')));
    const readyCall = calls.find((c) => c.startsWith('task ready CLI-900'));
    assert.ok(readyCall, 'task ready must be called on a landed task');
    assert.match(readyCall, /Check re-run: node --test test\/widget\.test\.js/);
    assert.match(readyCall, /# pass 3/, 'proof must carry the real verify output, not just prose');
    assert.ok(fleet.landArrival, 'sanity: shared land primitive still exported');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight review-only verifies explicitly, readies the task, and leaves master untouched', async () => {
  const tmpRoot = makeTempRoot();
  const explicitVerifier = 'node --test test/one-lap-review.test.js';
  let taskStatus = 'open';
  const calls = [];
  const verifyCalls = [];
  const stages = [];
  let dispatchCalls = 0;
  try {
    const cli = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify({ ...TASK, status: taskStatus }), stderr: '' };
      }
      if (args[0] === 'task' && args[1] === 'claim') {
        taskStatus = 'claimed';
        return { status: 0, stdout: 'claimed', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: 'next: cd /wt/dispatch-cli-900\n', stderr: '' };
      }
      if (args[0] === 'task' && args[1] === 'ready') {
        stages.push('ready');
        assert.equal(taskStatus, 'claimed');
        const proof = args[args.indexOf('--proof') + 1];
        const receiptRel = proof.match(/Receipt saved at (atris\/runs\/dispatch-[^\s]+[.]json)/)?.[1];
        assert.ok(receiptRel, 'ready proof must cite its dispatch receipt');
        const durable = JSON.parse(fs.readFileSync(path.join(tmpRoot, receiptRel), 'utf8'));
        assert.equal(durable.result.passed, true, 'passing evidence must exist before Review');
        assert.equal(durable.ready[0].review_recorded, false);
        taskStatus = 'review';
        return { status: 0, stdout: 'proof ready', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'ship') {
        throw new Error('review-only dispatch must not ship or merge');
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: explicitVerifier,
      receiptContext: { source: 'one_lap', objective: 'Fix the widget' },
      ownCli: cli,
      dispatcher: () => {
        dispatchCalls += 1;
        return Promise.resolve({ exitCode: 0, report: 'engine completed the requested change' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: (command, cwd) => {
        stages.push('verify');
        verifyCalls.push({ command, cwd });
        return { status: 0, stdout: '# pass 1\n', stderr: '' };
      },
      validatorEngines: ['claude'],
      validatorDispatcher: ({ engine, prompt }) => {
        stages.push('validator');
        assert.equal(engine, 'claude');
        assert.match(prompt, /independent validator/);
        assert.match(prompt, /Required verifier: node --test test\/one-lap-review[.]test[.]js/);
        return Promise.resolve({ exitCode: 0, report: 'cold review complete\nSIGNOFF: focused regression passed' });
      },
      validatorStateInspector: () => ({ ok: true, head: '2222222222222222222222222222222222222222', digest: 'clean-state' }),
      changeInspector: () => ({
        has_change: true,
        base: '1111111111111111111111111111111111111111',
        head: '2222222222222222222222222222222222222222',
        commit: '2222222222222222222222222222222222222222',
        dirty: false,
      }),
      log: () => {},
    });

    assert.equal(dispatchCalls, 1);
    assert.deepEqual(stages, ['verify', 'validator', 'ready']);
    assert.deepEqual(verifyCalls, [{ command: explicitVerifier, cwd: '/wt/dispatch-cli-900' }]);
    assert.equal(taskStatus, 'review');
    assert.deepEqual(flight.landed, []);
    assert.equal(flight.paused.length, 0);
    assert.equal(flight.ready.length, 1);
    assert.equal(flight.ready[0].check, explicitVerifier);
    assert.equal(flight.ready[0].verifier_result.passed, true);
    assert.equal(flight.ready[0].verifier_result.status, 0);
    assert.equal(flight.ready[0].validator_result.engine, 'claude');
    assert.equal(flight.ready[0].validator_result.passed, true);
    assert.match(flight.ready[0].verifier_result.output, /# pass 1/);
    assert.match(flight.ready[0].next_action, /^cd \/wt\/dispatch-cli-900 && atris worktree ship /);
    assert.match(flight.ready[0].next_action, /--verify 'node --test test\/one-lap-review\.test\.js'/);
    assert.match(flight.ready[0].next_action, /--target origin\/master --merge$/);
    assert.ok(!calls.some((call) => call.startsWith('worktree ship')), 'review-only path must not invoke the master landing gate');

    const readyCall = calls.find((call) => call.startsWith('task ready CLI-900'));
    assert.ok(readyCall, 'a verified review-only build must move the task to Review');
    assert.match(readyCall, /Check re-run: node --test test\/one-lap-review\.test\.js/);
    assert.doesNotMatch(readyCall, /test\/widget\.test\.js/, 'operator Check: text must not override the explicit verifier');
    assert.match(readyCall, /Receipt saved at atris\/runs\/dispatch-/);
    assert.match(readyCall, /commit 2222222222222222222222222222222222222222; node --test test\/one-lap-review[.]test[.]js passed \(exit 0\)/);

    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.schema, 'atris.dispatch_receipt.v1');
    assert.equal(receipt.review_only, true);
    assert.deepEqual(receipt.context, { source: 'one_lap', objective: 'Fix the widget' });
    assert.deepEqual(receipt.landed, []);
    assert.equal(receipt.ready[0].next_action, flight.ready[0].next_action);
    assert.equal(receipt.result.kind, 'dispatch_review_ready');
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.verifier_result.command, explicitVerifier);
    assert.equal(receipt.result.verifier_result.passed, true);
    assert.equal(receipt.result.verifier_result.status, 0);
    assert.equal(receipt.result.validator_result.engine, 'claude');
    assert.equal(receipt.result.validator_result.executor_engine, 'cursor');
    assert.equal(receipt.result.validator_result.independent, true);
    assert.equal(receipt.result.validator_result.passed, true);
    assert.equal(receipt.result.validator_result.worktree_unchanged, true);
    assert.match(receipt.result.verifier_result.output, /# pass 1/);
    assert.equal(receipt.ready[0].review_recorded, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight one-lap requires a validator distinct from the actual executor', async () => {
  const tmpRoot = makeTempRoot();
  try {
    const { cli, calls } = ownCliFake({ tasks: { 'CLI-900': TASK }, worktreeFor: () => '/wt/dispatch-cli-900' });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/one-lap-review.test.js',
      receiptContext: { source: 'one_lap' },
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'built' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      changeInspector: () => ({ has_change: true, head: '2222222222222222222222222222222222222222', dirty: false }),
      validatorEngines: ['cursor'],
      log: () => {},
    });
    assert.equal(flight.result.passed, false);
    assert.equal(flight.ready.length, 0);
    assert.equal(flight.paused[0].stage, 'validator_unavailable');
    assert.equal(flight.result.validator_result.independent, false);
    assert.ok(!calls.some((call) => call.startsWith('task ready')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight one-lap blocks Review when the validator mutates the worktree', async () => {
  const tmpRoot = makeTempRoot();
  let snapshot = 0;
  try {
    const { cli, calls } = ownCliFake({ tasks: { 'CLI-900': TASK }, worktreeFor: () => '/wt/dispatch-cli-900' });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/one-lap-review.test.js',
      receiptContext: { source: 'one_lap' },
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'built' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      changeInspector: () => ({ has_change: true, head: '2222222222222222222222222222222222222222', dirty: false }),
      validatorEngines: ['claude'],
      validatorDispatcher: () => Promise.resolve({ exitCode: 0, report: 'SIGNOFF: looks correct' }),
      validatorStateInspector: () => ({ ok: true, head: '2222222222222222222222222222222222222222', digest: `state-${snapshot += 1}` }),
      log: () => {},
    });
    assert.equal(flight.result.passed, false);
    assert.equal(flight.ready.length, 0);
    assert.equal(flight.paused[0].stage, 'validator_mutated_worktree');
    assert.equal(flight.result.validator_result.worktree_unchanged, false);
    assert.ok(!calls.some((call) => call.startsWith('task ready')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight review-only pauses a green no-op build before Review', async () => {
  const tmpRoot = makeTempRoot();
  let verifierCalled = false;
  try {
    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (task) => `/wt/${task}`,
    });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/one-lap-review.test.js',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'done' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => {
        verifierCalled = true;
        return { status: 0, stdout: '# pass 1\n', stderr: '' };
      },
      changeInspector: () => ({
        has_change: false,
        base: '1111111111111111111111111111111111111111',
        head: '1111111111111111111111111111111111111111',
      }),
      log: () => {},
    });

    assert.deepEqual(flight.ready, []);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'no_change');
    assert.equal(flight.result.passed, false);
    assert.equal(flight.result.verifier_result.passed, false);
    assert.equal(verifierCalled, false, 'a no-op build must stop before spending the verifier');
    assert.ok(!calls.some((call) => call.startsWith('task ready')), 'a verifier cannot promote a no-op build');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight review-only refuses a verifier workdir outside its worktree', async () => {
  const tmpRoot = makeTempRoot();
  try {
    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (task) => `/wt/${task}`,
    });
    await assert.rejects(
      fleet.runDispatchFlight({
        root: tmpRoot,
        taskIds: ['CLI-900'],
        engine: 'cursor',
        reviewOnly: true,
        verifierCommand: 'cd ../outside && node --test',
        ownCli: cli,
        dispatcher: () => Promise.resolve({ exitCode: 0, report: 'done' }),
        rebase: () => ({ ok: true, stage: 'rebased' }),
        log: () => {},
      }),
      /verifier command is not allowed/
    );
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight restaffs once when usage-limit output kills the first engine', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    assert.deepEqual(fleet.DEAD_ENGINE_OUTPUT_PATTERNS, ['usage limit', 'purchase more credits', 'rate limit']);
    const dispatchEngines = [];
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      installedEngines: ['codex', 'cursor'],
      ownCli: cli,
      dispatcher: (entry) => {
        dispatchEngines.push(entry.engine);
        if (entry.engine === 'codex') {
          return Promise.resolve({ exitCode: 1, stderr: 'Usage limit reached. Purchase more credits.' });
        }
        return Promise.resolve({ exitCode: 0, report: 'cursor finished the same prompt' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    });

    assert.deepEqual(dispatchEngines, ['codex', 'cursor']);
    assert.deepEqual(flight.results[0].restaffed, { from: 'codex', to: 'cursor', reason: 'usage_limit' });
    assert.equal(flight.results[0].engine, 'cursor');
    assert.equal(flight.landed[0].engine, 'cursor');
    assert.deepEqual(flight.landed[0].restaffed, { from: 'codex', to: 'cursor', reason: 'usage_limit' });
    assert.equal(flight.paused.length, 0);
    const readyCall = calls.find((c) => c.startsWith('task ready CLI-900'));
    assert.match(readyCall, /Built by cursor engine/);
    assert.match(readyCall, /Restaffed from codex to cursor \(usage_limit\)/);
    assert.ok(!calls.some((c) => c.startsWith('task ready CLI-900') && /fleet-codex/.test(c)), 'ready attribution must move to the fallback engine');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('a green build whose report mentions a dead-engine pattern never restaffs', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const dispatchEngines = [];
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      installedEngines: ['codex', 'cursor'],
      ownCli: cli,
      dispatcher: (entry) => {
        dispatchEngines.push(entry.engine);
        return Promise.resolve({ exitCode: 0, report: 'added rate limit handling; usage limit docs updated' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    });

    assert.deepEqual(dispatchEngines, ['codex']);
    assert.equal(flight.results[0].restaffed, undefined);
    assert.equal(flight.results[0].engine, 'codex');
    assert.equal(flight.landed[0].engine, 'codex');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight fails the flight when the fallback engine also fails', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const verifyCalls = [];
    const dispatchEngines = [];
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      installedEngines: ['codex', 'cursor'],
      ownCli: cli,
      dispatcher: (entry) => {
        dispatchEngines.push(entry.engine);
        if (entry.engine === 'codex') return Promise.resolve({ exitCode: 1, stderr: 'rate limit' });
        return Promise.resolve({ exitCode: 2, stderr: 'cursor failed too' });
      },
      verifier: () => {
        verifyCalls.push('verify');
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(dispatchEngines, ['codex', 'cursor']);
    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'build');
    assert.equal(flight.paused[0].engine, 'cursor');
    assert.deepEqual(flight.paused[0].restaffed, { from: 'codex', to: 'cursor', reason: 'usage_limit' });
    assert.deepEqual(flight.results[0].restaffed, { from: 'codex', to: 'cursor', reason: 'usage_limit' });
    assert.deepEqual(verifyCalls, []);
    assert.ok(!calls.some((c) => c.startsWith('task ready')), 'failed fallback must not mark the task ready');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});


test('runDispatchFlight yolo records self-landed tasks and receipt state', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const checks = [];
    let landerCalled = false;
    let verifierCalled = false;
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      yolo: true,
      ownCli: cli,
      log: () => {},
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'self landed in PR https://example.test/pr/1' }),
      lander: () => { landerCalled = true; return { ok: true, stage: 'shipped' }; },
      verifier: () => { verifierCalled = true; return { status: 0, stdout: '', stderr: '' }; },
      selfLandCheck: (input) => {
        checks.push(input);
        return { ok: true, target: input.targetRef };
      },
    });

    assert.equal(flight.yolo, true);
    assert.equal(flight.landed.length, 1);
    assert.equal(flight.landed[0].landing, 'self');
    assert.equal(flight.landed[0].target, fleet.DISPATCH_SELF_LAND_TARGET);
    assert.equal(flight.paused.length, 0);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].worktreePath, '/wt/dispatch-cli-900');
    assert.equal(landerCalled, false);
    assert.equal(verifierCalled, false);
    assert.ok(!calls.some((c) => c.startsWith('worktree ship')), 'outer dispatch must not ship in yolo mode');
    assert.ok(!calls.some((c) => c.startsWith('task ready')), 'outer dispatch must not ready a self-landed task');

    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.yolo, true);
    assert.equal(receipt.landed[0].landing, 'self');
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.verifier_result.command, 'git merge-base --is-ancestor HEAD origin/master');
    assert.equal(receipt.result.verifier_result.passed, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight yolo pauses when the engine did not land its work', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      yolo: true,
      ownCli: cli,
      log: () => {},
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'done but not merged' }),
      lander: () => { throw new Error('lander should not run in yolo mode'); },
      verifier: () => { throw new Error('verifier should not run in yolo mode'); },
      selfLandCheck: () => ({ ok: false, stage: 'self_land_missing', target: fleet.DISPATCH_SELF_LAND_TARGET, detail: 'not merged' }),
    });

    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'self_land_missing');
    assert.equal(flight.paused[0].target, fleet.DISPATCH_SELF_LAND_TARGET);
    assert.ok(!calls.some((c) => c.startsWith('worktree ship')), 'outer dispatch must not ship in yolo mode');

    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.yolo, true);
    assert.equal(receipt.paused[0].stage, 'self_land_missing');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight pauses (never ships) when the real Check: re-run fails', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'codex',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'agent says done' }),
      lander: undefined,
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 1, stdout: '', stderr: '1 failing\n' }),
    });

    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'verify_failed');
    assert.ok(!calls.some((c) => c.startsWith('worktree ship')), 'must never reach the ship gate on a failed verify');
    assert.ok(!calls.some((c) => c.startsWith('task ready')), 'must never ready a task whose verify failed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight pauses when the build itself fails, keeping the worktree', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({
      tasks: { 'CLI-900': TASK },
      worktreeFor: (t) => `/wt/${t}`,
    });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 1, stderr: 'engine crashed' }),
      verifier: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused[0].stage, 'build');
    assert.ok(!calls.some((c) => c.startsWith('task ready')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight pauses a task it cannot find, without touching worktree/claim for it', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({ tasks: {}, worktreeFor: () => null });
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-DOES-NOT-EXIST'],
      engine: 'cursor',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0 }),
      verifier: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(flight.paused[0].stage, 'task_lookup');
    assert.ok(!calls.some((c) => c.startsWith('task claim')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight never reuses a receipt path for rapid flights', async () => {
  const tmpRoot = makeTempRoot();
  try {
    const cli = () => ({ status: 1, stdout: '', stderr: 'not found' });
    const first = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-MISSING-1'],
      engine: 'cursor',
      ownCli: cli,
      log: () => {},
    });
    const second = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-MISSING-2'],
      engine: 'cursor',
      ownCli: cli,
      log: () => {},
    });
    assert.notEqual(first.receipt, second.receipt);
    assert.ok(fs.existsSync(first.receipt));
    assert.ok(fs.existsSync(second.receipt));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight stops before worktree creation when the atomic claim fails', async () => {
  const tmpRoot = makeTempRoot();
  const calls = [];
  let dispatchCalled = false;
  try {
    const cli = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
      }
      if (args[0] === 'task' && args[1] === 'claim') {
        return { status: 1, stdout: '', stderr: 'already claimed by another worker' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        throw new Error('worktree start must not run after a failed claim');
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/one-lap-review.test.js',
      ownCli: cli,
      dispatcher: () => {
        dispatchCalled = true;
        return Promise.resolve({ exitCode: 0 });
      },
      rebase: () => { throw new Error('rebase must not run after a failed claim'); },
      verifier: () => { throw new Error('verifier must not run after a failed claim'); },
      log: () => {},
    });

    assert.equal(dispatchCalled, false);
    assert.deepEqual(calls, [
      'task show CLI-900 --json',
      'task claim CLI-900 --as fleet-cursor',
    ]);
    assert.deepEqual(flight.results, []);
    assert.deepEqual(flight.ready, []);
    assert.deepEqual(flight.landed, []);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].task, 'CLI-900');
    assert.equal(flight.paused[0].stage, 'claim');
    assert.match(flight.paused[0].detail, /already claimed by another worker/);

    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.paused[0].stage, 'claim');
    assert.ok(!receipt.ready.length);
    assert.ok(!receipt.landed.length);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight builds multiple task ids in parallel worktrees and lands them serially', async () => {
  const tmpRoot = makeTempRoot();
  try {    const tasks = {
      'CLI-901': { display_id: 'CLI-901', title: 'edit a. Done: x. Check: node --test test/a.test.js.' },
      'CLI-902': { display_id: 'CLI-902', title: 'edit b. Done: x. Check: node --test test/b.test.js.' },
    };
    const { cli, calls } = ownCliFake({ tasks, worktreeFor: (t) => `/wt/${t}` });
    const landOrder = [];
    const flight = await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-901', 'CLI-902'],
      engine: 'codex',
      ownCli: cli,
      dispatcher: (entry) => Promise.resolve({ exitCode: 0, report: `${entry.taskId} done` }),
      lander: ({ entry }) => { landOrder.push(entry.taskId); return { ok: true, stage: 'shipped', check: 'node --test x', verifyOutput: 'ok' }; },
    });
    assert.deepEqual(landOrder, ['CLI-901', 'CLI-902'], 'landing must run serially in submission order');
    assert.deepEqual(flight.landed.map((l) => l.task), ['CLI-901', 'CLI-902']);
    assert.ok(calls.some((c) => c.startsWith('worktree start --agent codex --task dispatch-cli-901')));
    assert.ok(calls.some((c) => c.startsWith('worktree start --agent codex --task dispatch-cli-902')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runDispatchFlight ship args always target origin/master, never the launcher branch', async () => {
  const tmpRoot = makeTempRoot();
  try {    const { cli, calls } = ownCliFake({ tasks: { 'CLI-900': TASK }, worktreeFor: (t) => `/wt/${t}` });
    await fleet.runDispatchFlight({
      root: tmpRoot,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      ownCli: cli,
      dispatcher: () => Promise.resolve({ exitCode: 0 }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: 'pass', stderr: '' }),
    });
    const shipCall = calls.find((c) => c.startsWith('worktree ship'));
    assert.ok(shipCall, 'default lander ships via the fleet ship-args builder');
    assert.match(shipCall, /--target origin\/master/);
    assert.match(shipCall, /--merge/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
