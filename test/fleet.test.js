const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../lib/fleet');
const { listWorktrees } = require('../commands/worktree');

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget so operators stop retyping. Done: widget renders once, test included. Check: focused node --test test/widget.test.js.',
};

function writeExecutorDispatchHistory(root, outcomes) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    const at = `2026-07-${18 + index}T12:00:00.000Z`;
    const results = Object.entries(outcomes).map(([engine, verifiedPassed]) => ({
      task: `CLI-${engine}-${index}`,
      engine,
      task_type: 'executor',
      verified_passed: verifiedPassed,
      duration_ms: 1000,
      at,
      exitCode: verifiedPassed ? 0 : 1,
    }));
    fs.writeFileSync(path.join(runsDir, `dispatch-history-${index}.json`), `${JSON.stringify({
      schema: 'atris.dispatch_receipt.v1',
      results,
    })}\n`, 'utf8');
  }
}

test('parseDoneCheck extracts the task spec from board convention text', () => {
  const { done, check } = fleet.parseDoneCheck(TASK.title);
  assert.match(done, /widget renders once/);
  assert.match(check, /node --test test\/widget\.test\.js/);
  assert.deepEqual(fleet.parseDoneCheck('no spec here'), { done: '', check: '' });
});

test('buildFleetPrompt is generated, bounded, and carries the contract', () => {
  const prompt = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x' });
  assert.equal(prompt.split('\n')[0], 'First, run `atris worktree guard`; if it fails, stop immediately, report back, and do not edit anything. Do this before any file edit.');
  assert.match(prompt, /CLI-900/);
  assert.match(prompt, /isolated git worktree at \/wt\/x/);
  assert.match(prompt, /NEVER push/);
  assert.match(prompt, /Done criteria: widget renders once/);
  assert.match(prompt, /atris\/MAP\.md first/);
  assert.match(prompt, /atris worktree guard/);
  assert.doesNotMatch(prompt, /atris worktree start/);
  assert.match(prompt, /Stage ONLY files you changed/);
  assert.match(prompt, /real exit code/);
  assert.match(prompt, /Done requires a receipt/);
  assert.match(prompt, /grep the whole repo for its callers/);
  assert.match(prompt, /Final report/);
});

test('buildFleetPrompt yolo asks the engine to land itself', () => {
  const prompt = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x', yolo: true });
  assert.match(prompt, /atris worktree guard/);
  assert.match(prompt, /atris\/MAP\.md first/);
  assert.match(prompt, /plain-English message/);
  assert.match(prompt, /atris worktree ship --message "<msg>" --verify "npm run test:fast && node --test <focused files>" --merge/);
  assert.match(prompt, /never resolve conflicts yourself/);
  assert.doesNotMatch(prompt, /Do not push\. Do not create branches\./);
});

test('METHOD_KERNEL is exported and fully present in the prompt', () => {
  assert.ok(Array.isArray(fleet.METHOD_KERNEL));
  assert.ok(fleet.METHOD_KERNEL.length >= 6);
  const prompt = fleet.buildFleetPrompt({ display_id: 'CLI-1', title: 'x' });
  for (const rule of fleet.METHOD_KERNEL) {
    assert.ok(prompt.includes(`- ${rule}`), `kernel rule missing from prompt: ${rule}`);
  }
});

test('assertIsolatedWorktree refuses missing and primary checkout paths', () => {
  const primaryRoot = fs.realpathSync(listWorktrees(process.cwd())[0].path);
  assert.throws(
    () => fleet.assertIsolatedWorktree('', process.cwd()),
    /worktreePath is required/
  );
  assert.throws(
    () => fleet.assertIsolatedWorktree(primaryRoot, process.cwd()),
    /primary repo checkout/
  );
});

test('assertIsolatedWorktree allows a real non-primary worktree path', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-isolated-wt-'));
  try {
    assert.doesNotThrow(() => fleet.assertIsolatedWorktree(wt, process.cwd()));
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('dispatchToEngine refuses to run from the primary checkout', () => {
  const primaryRoot = fs.realpathSync(listWorktrees(process.cwd())[0].path);
  let runnerCalled = false;
  assert.throws(
    () => fleet.dispatchToEngine({
      task: { ...TASK, display_id: 'CLI-PRIMARY-GUARD' },
      engine: 'cursor',
      worktreePath: primaryRoot,
      runner: () => { runnerCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    }),
    /primary repo checkout/
  );
  assert.equal(runnerCalled, false);
});

test('buildEngineCommand rides runner profiles per engine', () => {
  assert.match(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /^cursor-agent --trust -p/);
  assert.match(fleet.buildEngineCommand('codex', '/tmp/p.md'), /^codex exec/);
  assert.match(fleet.buildEngineCommand('atris-fast', '/tmp/p.md'), /^ax --fast/);
  assert.match(fleet.buildEngineCommand('devin', '/tmp/p.md'), /^devin -p --permission-mode dangerous /);
  // claude has no template: default claude-shaped spawn with a model flag
  assert.match(fleet.buildEngineCommand('claude', '/tmp/p.md'), /^claude -p .*--model/);
  assert.throws(() => fleet.buildEngineCommand('gpt-11', '/tmp/p.md'), /unknown engine/);
});

test('dispatchToEngine writes the prompt file and captures the report', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wt-'));
  try {
    const calls = [];
    const result = fleet.dispatchToEngine({
      task: TASK,
      engine: 'cursor',
      worktreePath: wt,
      runner: (cmd) => { calls.push(cmd); return { status: 0, stdout: 'report: done', stderr: '' }; },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.engine, 'cursor');
    assert.match(result.report, /report: done/);
    assert.equal(calls.length, 1);
    const promptFile = path.join(wt, '.atris', 'fleet-prompt-CLI-900.md');
    assert.ok(fs.existsSync(promptFile));
    assert.match(fs.readFileSync(promptFile, 'utf8'), /Done criteria/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('staffing skips denied lanes and keeps concurrent picks file-disjoint', () => {
  const tasks = [
    { display_id: 'A', status: 'open', title: 'touch commands/mission.js Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'billing invoice run #billing Done: x. Check: y.' },
    { display_id: 'C', status: 'open', title: 'also edits commands/mission.js plus lib/other.js Done: x. Check: y.' },
    { display_id: 'D', status: 'open', title: 'edits lib/fleet.js only Done: x. Check: y.' },
    { display_id: 'E', status: 'review', title: 'not open' },
  ];
  const staffed = fleet.staffFlight(tasks, { slots: 3 });
  const ids = staffed.map((s) => s.task.display_id);
  assert.ok(!ids.includes('B'), 'denied lane staffed');
  assert.ok(!ids.includes('E'), 'non-open staffed');
  assert.ok(ids.includes('A') && ids.includes('D'));
  assert.ok(!ids.includes('C'), 'overlapping surface staffed concurrently');
});

test('staffing allows at most one surface-blind task per flight', () => {
  const tasks = [
    { display_id: 'A', status: 'open', title: 'vague idea one Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'vague idea two Done: x. Check: y.' },
  ];
  const staffed = fleet.staffFlight(tasks, { slots: 3 });
  assert.equal(staffed.length, 1);
});

test('assignEngines round-robins the installed roster', () => {
  const staffed = fleet.staffFlight([
    { display_id: 'A', status: 'open', title: 'edits lib/a.js Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'edits lib/b.js Done: x. Check: y.' },
    { display_id: 'C', status: 'open', title: 'edits lib/c.js Done: x. Check: y.' },
  ], { slots: 3 });
  const assigned = fleet.assignEngines(staffed, ['codex', 'cursor']);
  assert.deepEqual(assigned.map((a) => a.engine), ['codex', 'cursor', 'codex']);
  assert.deepEqual(fleet.assignEngines(staffed, []), []);
});

test('restaffing keeps legacy rotation when history is thin and follows rich executor outcomes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-router-'));
  try {
    const installedEngines = ['codex', 'cursor', 'claude'];
    assert.equal(
      fleet.nextInstalledFleetEngine('codex', { root, installedEngines }),
      'cursor',
    );

    writeExecutorDispatchHistory(root, { cursor: false, claude: true });
    assert.equal(
      fleet.nextInstalledFleetEngine('codex', { root, installedEngines }),
      'claude',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('landArrival rebases clean arrivals and pauses on conflict without resolving', () => {
  const log = [];
  const gitOk = (args) => { log.push(args[0]); return { status: 0, stdout: '', stderr: '' }; };
  const clean = fleet.landArrival({ worktreePath: '/wt', git: gitOk });
  assert.deepEqual(clean, { ok: true, stage: 'rebased' });

  const conflictGit = (args) => {
    log.push(args.join(' '));
    if (args[0] === 'rebase' && args[1] === 'origin/master') return { status: 1, stdout: '', stderr: 'conflict' };
    if (args[0] === 'diff') return { status: 0, stdout: 'commands/mission.js\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const paused = fleet.landArrival({ worktreePath: '/wt', git: conflictGit });
  assert.equal(paused.ok, false);
  assert.equal(paused.stage, 'rebase_conflict');
  assert.deepEqual(paused.conflicts, ['commands/mission.js']);
  assert.ok(log.includes('rebase --abort'), 'conflict must be aborted, never auto-resolved');
});

// CLI-1190: a killed predecessor leaves modified/untracked files behind, so
// git rebase refuses before any conflict can occur — the unmerged-file list is
// empty. Reporting that as rebase_conflict sends the operator chasing a merge
// problem that does not exist. It must report a distinct dirty_worktree state
// naming the uncommitted paths, and an empty conflicts list is never a conflict.
test('landArrival reports dirty_worktree, not an empty rebase_conflict', () => {
  const dirtyGit = (args) => {
    if (args[0] === 'rebase' && args[1] === 'origin/master') {
      return { status: 1, stdout: '', stderr: 'cannot rebase: you have unstaged changes' };
    }
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' }; // no unmerged files
    if (args[0] === 'status') return { status: 0, stdout: ' M lib/web.js\n?? scratch.txt\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const dirty = fleet.landArrival({ worktreePath: '/wt', git: dirtyGit });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.stage, 'dirty_worktree');
  assert.deepEqual(dirty.dirty, ['lib/web.js', 'scratch.txt']);
  assert.equal(dirty.conflicts, undefined, 'an empty conflicts list is never reported as a conflict');
});

// CLI-1190: a claude engine killed mid-flight (exit 143 / SIGTERM) returns an
// empty report. The restaff leg must name the signal instead of a silent no-op.
test('failedDispatchLeg names the signal for a killed engine with an empty report', () => {
  const exitLeg = fleet.failedDispatchLeg({ exitCode: 143, report: '', stderr: '' }, 'claude');
  assert.equal(exitLeg.signal, 'SIGTERM');
  assert.equal(exitLeg.report, '(no report: killed by SIGTERM)');

  const signalLeg = fleet.failedDispatchLeg({ status: null, signal: 'SIGKILL', report: '', stderr: '' }, 'claude');
  assert.equal(signalLeg.signal, 'SIGKILL');
  assert.equal(signalLeg.report, '(no report: killed by SIGKILL)');

  // a normal non-signal failure keeps its own report and grows no signal field.
  const plain = fleet.failedDispatchLeg({ exitCode: 1, report: 'engine died', stderr: 'boom' }, 'codex');
  assert.equal(plain.signal, undefined);
  assert.equal(plain.report, 'engine died');
});

test('detectDeadEngineDispatch flags a signalled leg distinctly from a plain nonzero exit', () => {
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 143, report: '' }), { reason: 'signalled', signal: 'SIGTERM', exitCode: 143 });
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 2, report: 'boom' }), { reason: 'nonzero_exit', exitCode: 2 });
});

test('defaultSelfLandCheck fetches the target ref and checks HEAD ancestry', () => {
  const calls = [];
  const result = fleet.defaultSelfLandCheck({
    worktreePath: '/wt',
    git: (args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls[0], ['fetch', 'origin', 'master:refs/remotes/origin/master']);
  assert.deepEqual(calls[1], ['merge-base', '--is-ancestor', 'HEAD', 'origin/master']);
  assert.deepEqual(result, { ok: true, stage: 'self_landed', target: 'origin/master' });
});

test('runFleetFlight dry-run staffs from the projection without dispatching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-root-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' },
        { display_id: 'F-2', status: 'open', title: 'edits lib/b.js Done: x. Check: node --test test/b.test.js.' },
        { display_id: 'F-3', status: 'open', title: 'deploy the site #deploy Done: x. Check: y.' },
      ],
    }));
    const lines = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex', 'cursor'],
      dryRun: true,
      log: (l) => lines.push(String(l)),
    });
    assert.equal(flight.dry_run, true);
    assert.deepEqual(flight.staffed.map((s) => s.task), ['F-1', 'F-2']);
    assert.deepEqual(flight.staffed.map((s) => s.engine), ['codex', 'cursor']);
    assert.ok(lines.some((l) => /2 tasks staffed/.test(l)));
    assert.equal(flight.results.length, 0, 'dry run must not dispatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight ranks its default primary engine only when executor history is rich', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-primary-router-'));
  const binDir = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    const thin = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.deepEqual(thin.roster, ['claude', 'codex']);
    assert.equal(thin.staffed[0].engine, 'claude');

    writeExecutorDispatchHistory(root, { claude: false, codex: true });
    const rich = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.deepEqual(rich.roster, ['codex', 'claude']);
    assert.equal(rich.staffed[0].engine, 'codex');
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight full loop: claims, dispatches in parallel, lands serially, writes receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-root-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' },
        { display_id: 'F-2', status: 'open', title: 'edits lib/b.js Done: x. Check: node --test test/b.test.js.' },
      ],
    }));
    const cliCalls = [];
    const ownCli = (args) => {
      cliCalls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt-${cliCalls.length}\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    const landed = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex', 'cursor'],
      log: () => {},
      ownCli,
      dispatcher: (entry) => Promise.resolve({ exitCode: entry.task.display_id === 'F-2' ? 1 : 0, report: 'ok', stderr: entry.task.display_id === 'F-2' ? 'engine died' : '' }),
      lander: ({ entry }) => { landed.push(entry.task.display_id); return { ok: true, stage: 'shipped' }; },
    });
    // claims + worktrees per staffed task
    assert.ok(cliCalls.some((c) => c.startsWith('task claim F-1 --as fleet-codex')));
    assert.ok(cliCalls.some((c) => c.startsWith('worktree start --agent cursor')));
    // failed build pauses with the worktree kept; good build lands + task ready
    assert.deepEqual(landed, ['F-1']);
    assert.deepEqual(flight.landed.map((l) => l.task), ['F-1']);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].task, 'F-2');
    assert.ok(cliCalls.some((c) => c.startsWith('task ready F-1')));
    assert.ok(cliCalls.find((c) => c.startsWith('task ready F-1')).includes('Receipt saved at atris/runs/fleet-'), 'ready proof must cite the flight receipt path');
    assert.ok(!cliCalls.some((c) => c.startsWith('task ready F-2')));
    // receipt on disk, no other fleet state file anywhere
    assert.ok(fs.existsSync(flight.receipt));
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.landed.length, 1);
    assert.deepEqual(receipt.results[1].restaffed.failed_legs, [{
      engine: 'cursor',
      exitCode: 1,
      stderr: 'engine died',
      report: 'ok',
    }]);
    assert.deepEqual(receipt.paused[0].restaffed.failed_legs, receipt.results[1].restaffed.failed_legs);
    assert.ok(!fs.existsSync(path.join(root, '.atris', 'fleet.json')), 'fleet must not grow a state file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// CLI-881: a flight launched from a long-lived feature-branch checkout must
// not cut its build worktrees from that branch — rebase-before-ship would then
// replay every feature commit onto master and pause at rebase_conflict. Fleet
// and dispatch both pass --base origin/master to `worktree start` by default.
function baseAfter(call) {
  const i = call.indexOf('--base');
  return i > -1 ? call[i + 1] : null;
}

test('runFleetFlight cuts build worktrees from origin/master by default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-base-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runFleetFlight({
      root,
      engines: ['codex'],
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped' }),
    });
    assert.equal(startCalls.length, 1);
    assert.equal(baseAfter(startCalls[0]), 'origin/master', 'default fleet worktree must cut from origin/master');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight keeps launcher-HEAD only when checkoutBase is explicit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-base-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runFleetFlight({
      root,
      engines: ['codex'],
      log: () => {},
      ownCli,
      checkoutBase: 'HEAD',
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped' }),
    });
    assert.equal(baseAfter(startCalls[0]), 'HEAD', 'explicit checkoutBase overrides the origin/master default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runDispatchFlight cuts its worktree from origin/master by default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-base-'));
  try {
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'task' && args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify({ display_id: 'D-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runDispatchFlight({
      root,
      taskIds: ['D-1'],
      engine: 'codex',
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped', check: 'node --test test/a.test.js', verifyOutput: 'ok' }),
    });
    assert.equal(startCalls.length, 1);
    assert.equal(baseAfter(startCalls[0]), 'origin/master', 'default dispatch worktree must cut from origin/master');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fleet landings ship with an explicit master target, never the launcher branch base', () => {
  const args = fleet.fleetShipArgs(
    { task: { display_id: 'F-9', title: 'fix the thing. Done: x.' }, engine: 'cursor' },
    'node --test test/a.test.js'
  );
  const target = args.indexOf('--target');
  assert.ok(target > -1, 'ship args must carry --target');
  assert.equal(args[target + 1], 'origin/master');
  assert.ok(args.includes('--merge'));
  assert.ok(args.join(' ').includes('(F-9, built by cursor)'));
});

test('clipHeadTail keeps MODULE_NOT_FOUND head with a stack tail', () => {
  const head = "Error: Cannot find module 'missing-mod'\nMODULE_NOT_FOUND: cannot find missing-mod\n";
  const stack = Array.from({ length: 80 }, (_, i) =>
    `    at Object.<anonymous> (node:internal/modules/cjs/loader:${1000 + i}:10)`
  ).join('\n');
  const text = head + stack;
  const clipped = fleet.clipHeadTail(text, { head: 400, tail: 300 });
  assert.match(clipped, /MODULE_NOT_FOUND: cannot find missing-mod/);
  assert.match(clipped, /node:internal\/modules\/cjs\/loader/);
  assert.ok(clipped.includes('\n...\n'));
  assert.ok(clipped.length < text.length);
  assert.equal(fleet.clipHeadTail('short'), 'short');
});

test('runFleetFlight ship failure receipt keeps the failing module at the head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ship-fail-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const head = "Error: Cannot find module 'atris-ship-helper'\nMODULE_NOT_FOUND: cannot find atris-ship-helper\nRequire stack:\n";
    const stack = Array.from({ length: 100 }, (_, i) =>
      `    at Module.require (node:internal/modules/cjs/loader:${2000 + i}:17)`
    ).join('\n');
    const shipErr = head + stack;
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'ship') {
        return { status: 1, stdout: '', stderr: shipErr };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['cursor'],
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
    });
    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'ship');
    assert.match(flight.paused[0].detail, /MODULE_NOT_FOUND: cannot find atris-ship-helper/);
    assert.match(flight.paused[0].detail, /node:internal\/modules\/cjs\/loader/);
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.match(receipt.paused[0].detail, /MODULE_NOT_FOUND: cannot find atris-ship-helper/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
