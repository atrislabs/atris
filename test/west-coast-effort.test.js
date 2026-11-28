'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  classifyTaskEffort,
  effectiveEffortForEngine,
  buildMysteryBugDiagnosticPrompt,
  resolveDiagnosticWorker,
} = require('../lib/effort-router');
const { buildScoutInvocation } = require('../lib/dispatch-scout');
const { parseRunUsage, appendRosterRun, readRosterRuns, workerRuns } = require('../lib/roster-runs');
const { attachSuggestions } = require('../lib/roster-suggest');
const { reviewCommand } = require('../commands/review');
const comms = require('../lib/swarm-comms');
const fleet = require('../lib/fleet');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');

test('classifyTaskEffort routes Span x Unknowns across Sprinter, Worker, and Thinker classes', () => {
  const bounded = classifyTaskEffort({ title: 'Update button copy in ui/Header.tsx' });
  assert.equal(bounded.effort, 'low');
  assert.equal(bounded.weight_class, 'worker');
  assert.equal(bounded.audible, false);

  const search = classifyTaskEffort({ title: 'Find auth callers' }, { job: 'search' });
  assert.equal(search.effort, 'low');
  assert.equal(search.weight_class, 'sprinter');

  const integration = classifyTaskEffort({ title: 'Wire Stripe webhook idempotency retry' });
  assert.equal(integration.effort, 'medium');
  assert.equal(integration.weight_class, 'worker');

  const race = classifyTaskEffort({ title: 'Fix distributed lock race condition in queue ledger' });
  assert.equal(race.effort, 'high');
  assert.equal(race.weight_class, 'thinker');

  const audible = classifyTaskEffort({ title: 'Fix button copy' }, { retryCount: 2 });
  assert.equal(audible.effort, 'high');
  assert.equal(audible.weight_class, 'thinker');
  assert.equal(audible.audible, true);
});

test('effectiveEffortForEngine degrades safely and skips engines without effort flags', () => {
  assert.equal(effectiveEffortForEngine('claude', 'low'), 'low');
  assert.equal(effectiveEffortForEngine('codex', 'xhigh'), 'xhigh');
  assert.equal(effectiveEffortForEngine('agy', 'xhigh'), 'high');
  assert.equal(effectiveEffortForEngine('devin', 'low'), '');
  assert.equal(effectiveEffortForEngine('cursor', 'high'), '');
  assert.equal(effectiveEffortForEngine('atris-fast', 'low'), '');
});

test('buildMysteryBugDiagnosticPrompt enforces read-only root-cause protocol', () => {
  const prompt = buildMysteryBugDiagnosticPrompt({
    task: { title: 'Fix flaky session lock' },
    error: 'SQLITE_BUSY: database is locked',
    files: ['lib/task-db.js'],
  });
  assert.match(prompt, /Do NOT write code or patch symptoms yet/);
  assert.match(prompt, /top 2-3 root-cause hypotheses/);
  assert.match(prompt, /SQLITE_BUSY/);
  assert.match(prompt, /lib\/task-db\.js/);
});

test('resolveDiagnosticWorker reads the repo diagnose Deep Thinker lane from atris/ROSTER.md', () => {
  // A temp room with the repo's own roster and its engines marked ready, so the
  // answer does not depend on which engines this machine has installed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-diag-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.copyFileSync(path.resolve(__dirname, '..', 'atris', 'ROSTER.md'), path.join(root, 'atris', 'ROSTER.md'));
    readEngineRegistry(root);
    for (const name of ['claude', 'codex']) setEngineHealth(name, 'ready', root);
    const worker = resolveDiagnosticWorker(root);
    assert.ok(worker);
    assert.equal(worker.job, 'diagnose');
    assert.ok(worker.engine);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch-scout and code-review triage default to effort low for strict JSON', async () => {
  const scoutInv = buildScoutInvocation({ engine: 'haiku', model: '', prompt: 'return json' });
  const idx = scoutInv.args.indexOf('--effort');
  assert.ok(idx !== -1 && scoutInv.args[idx + 1] === 'low');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-cr-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'SPEC.md'), '# Spec\n\n## Wall of shame\n\n### Caps (1 example)\n\nAvoid caps.\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: root });
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
    spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.js'), 'const x = 1;\n');
    const seen = [];
    await reviewCommand(['--json'], {
      root,
      log: () => {},
      error: () => {},
      executeAskJob: async (job) => {
        seen.push(job);
        if (job.label === 'triage') return { ok: true, stdout: '{"lenses":[{"lens":"Caps","relevant":false,"reason":"none"}]}' };
        return { ok: true, stdout: '{"verdict":"accept","score":95,"assessment":"clean"}' };
      },
    });
    const triage = seen.find((j) => j.label === 'triage');
    assert.ok(triage);
    assert.equal(triage.effort, 'low');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('roster-runs splits input, output, thinking, and KV cache tokens and filters workerRuns by effort', () => {
  const usage = parseRunUsage({
    usage: {
      input_tokens: 500,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 500,
      output_tokens: 400,
      thinking_tokens: 1600,
    },
    cost_usd: 0.14,
  });
  assert.equal(usage.tokens, 10400);
  assert.equal(usage.input_tokens, 500);
  assert.equal(usage.output_tokens, 400);
  assert.equal(usage.thinking_tokens, 1600);
  assert.equal(usage.cache_read_tokens, 9000);
  assert.equal(usage.cache_write_tokens, 500);
  assert.equal(usage.cache_hit_pct, 90);
  assert.equal(usage.thinking_pct, 80);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-runs-'));
  try {
    const now = Date.parse('2026-11-28T12:00:00.000Z');
    appendRosterRun(root, { at: new Date(now - 60000).toISOString(), job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'low', outcome: 'landed', seconds: 40, ...usage });
    appendRosterRun(root, { at: new Date(now - 30000).toISOString(), job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'high', outcome: 'landed', seconds: 260 });
    const rows = readRosterRuns(root, { now });
    assert.equal(rows[0].cache_hit_pct, 90);
    assert.equal(rows[0].thinking_tokens, 1600);
    assert.equal(workerRuns(rows, { job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'low' }).length, 1);
    assert.equal(workerRuns(rows, { job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }).length, 1);
    assert.equal(workerRuns(rows, { job: 'build', engine: 'claude', model: 'claude-opus-5-5' }).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('roster-suggest recommends effort downgrade when same-model low matches landing rate at >=2x speed', () => {
  const row = {
    job: 'build',
    pick: { engine: 'claude' },
    workers: [
      { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      { engine: 'claude', model: 'claude-opus-5-5', effort: 'low' },
    ],
  };
  const history = [
    { at: '2026-11-27T10:00:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'high', outcome: 'landed', seconds: 260, cost_usd: 1.2 },
    { at: '2026-11-27T10:05:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'high', outcome: 'landed', seconds: 240, cost_usd: 1.1 },
    { at: '2026-11-27T10:10:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'high', outcome: 'landed', seconds: 250, cost_usd: 1.0 },
    { at: '2026-11-27T11:00:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'low', outcome: 'landed', seconds: 50, cost_usd: 0.2 },
    { at: '2026-11-27T11:05:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'low', outcome: 'landed', seconds: 45, cost_usd: 0.18 },
    { at: '2026-11-27T11:10:00.000Z', job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: 'low', outcome: 'landed', seconds: 55, cost_usd: 0.22 },
  ];
  assert.equal(attachSuggestions([row], history), 1);
  assert.equal(row.suggestion.kind, 'effort_downgrade');
  assert.equal(row.suggestion.challenger.effort, 'low');
  assert.match(row.suggestion.command, /--promote "claude code claude-opus-5-5 low"/);
});

test('fleet dispatch routes unset effort to low for bounded tasks and high for concurrency tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-fleet-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-fleet-wt-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-fleet-home-'));
  const prevMachine = process.env.ATRIS_MACHINE_ROSTER_PATH;
  const prevExplain = process.env.ATRIS_ROUTER_EXPLAIN;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  try {
    spawnSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.join(root, 'atris'));
    readEngineRegistry(root);
    setEngineHealth('claude', 'ready', root);

    const seenPins = [];
    const runTask = (task) => fleet.runDispatchFlight({
      root,
      taskIds: [task.display_id],
      engine: 'claude',
      installedEngines: ['claude'],
      ownCli: (args) => {
        if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(task), stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
        return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
      },
      dispatcher: (entry) => {
        seenPins.push({ id: task.display_id, effort: entry.roster_pin && entry.roster_pin.effort });
        return Promise.resolve({ exitCode: 0, report: 'done' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: 'ok\n', stderr: '' }),
      scoutAsk: false,
      log: () => {},
    });

    await runTask({ display_id: 'CLI-1', status: 'open', title: 'Update copy in UI banner. Done: banner updated. Check: git diff --check.' });
    await runTask({ display_id: 'CLI-2', status: 'open', title: 'Fix concurrency race condition in distributed lock ledger. Done: lock safe. Check: git diff --check.' });

    assert.deepEqual(seenPins, [
      { id: 'CLI-1', effort: 'low' },
      { id: 'CLI-2', effort: 'high' },
    ]);
    const recorded = readRosterRuns(root);
    assert.deepEqual(recorded.map((r) => [r.task, r.effort]), [
      ['CLI-1', 'low'],
      ['CLI-2', 'high'],
    ]);
  } finally {
    if (prevMachine === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = prevMachine;
    if (prevExplain === undefined) delete process.env.ATRIS_ROUTER_EXPLAIN;
    else process.env.ATRIS_ROUTER_EXPLAIN = prevExplain;
    for (const dir of [root, wt, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('swarm up runs 1-turn Deep Thinker diagnosis on 2 repeated misses and recovers on low effort', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wc-swarm-'));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, '.atris', 'state', 'swarm.json'), JSON.stringify({
    objective: 'Fix flaky cache invalidation',
    lead: 'coordinator',
    workers: ['builder'],
    channel: 'general',
    hub: 'wc-hub',
    server: 'http://127.0.0.1:1',
    queue: [
      { task_key: 'step-1', content: 'Patch cache invalidation', depends_on: [], status: 'open' },
      { task_key: 'step-2', content: 'Patch cache invalidation retry', depends_on: [], status: 'open' },
      { task_key: 'step-3', content: 'Apply diagnosed fix', depends_on: [], status: 'open' },
    ],
  }));

  let diagCalls = 0;
  const workerSawDiagnosis = [];
  const res = await comms.runSwarmUpLoop(root, {
    durationMs: 60000,
    maxCycles: 5,
    maxRepeatErrors: 2,
    stopOnEmpty: true,
    diagnose: true,
    recover: true,
    dream: false,
    server: 'http://127.0.0.1:1',
    hub: 'wc-hub',
    home,
    json: true,
  }, {
    sleep: async () => {},
    diagnoseStall: async (_r, payload) => {
      diagCalls += 1;
      assert.match(payload.error, /stale cache key/);
      return {
        ok: true,
        engine: 'codex',
        model: 'gpt-6.2-sol',
        effort: 'xhigh',
        diagnosis: 'Hypothesis 1: prefix mutates timestamp per turn. Minimal fix: freeze prefix key.',
      };
    },
    runWorker: async ({ task, westCoast, diagnosis }) => {
      assert.ok(westCoast && westCoast.effort);
      workerSawDiagnosis.push({ key: task.task_key, hasDiag: Boolean(diagnosis && diagnosis.diagnosis) });
      if (!diagnosis) return { ok: false, error: 'stale cache key mismatch at line 42' };
      return { ok: true, summary: `recovered ${task.task_key} using diagnosis` };
    },
  });

  assert.equal(diagCalls, 1);
  assert.equal(res.ok, true);
  assert.equal(res.stop_reason, 'queue_drained');
  assert.equal(res.succeeded_count, 1);
  assert.equal(res.failed_count, 2);
  assert.equal(res.diagnosis.engine, 'codex');
  assert.equal(res.diagnosis.effort, 'xhigh');
  assert.deepEqual(workerSawDiagnosis, [
    { key: 'step-1', hasDiag: false },
    { key: 'step-2', hasDiag: false },
    { key: 'step-3', hasDiag: true },
  ]);
});
