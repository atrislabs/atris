const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../lib/fleet');

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget so operators stop retyping. Done: widget renders once, test included. Check: focused node --test test/widget.test.js.',
};

test('parseDoneCheck extracts the task spec from board convention text', () => {
  const { done, check } = fleet.parseDoneCheck(TASK.title);
  assert.match(done, /widget renders once/);
  assert.match(check, /node --test test\/widget\.test\.js/);
  assert.deepEqual(fleet.parseDoneCheck('no spec here'), { done: '', check: '' });
});

test('buildFleetPrompt is generated, bounded, and carries the contract', () => {
  const prompt = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x' });
  assert.match(prompt, /CLI-900/);
  assert.match(prompt, /isolated git worktree at \/wt\/x/);
  assert.match(prompt, /NEVER push/);
  assert.match(prompt, /Done criteria: widget renders once/);
  assert.match(prompt, /atris\/MAP\.md first/);
  assert.match(prompt, /Stage ONLY files you changed/);
  assert.match(prompt, /Final report/);
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
    assert.ok(!fs.existsSync(path.join(root, '.atris', 'fleet.json')), 'fleet must not grow a state file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
