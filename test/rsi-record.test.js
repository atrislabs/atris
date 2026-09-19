'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rsi = require('../lib/rsi-record');
const { runImprove, runImproveCore } = require('../commands/improve');
const rsiCmd = require('../commands/rsi');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in for backend/scripts/rsi/record.py: logs every invocation as a
// JSON line to $FAKE_RSI_LOG and prints the ids the CLI parses.
const FAKE_RECORD_PY = `import json, os, sys
log = os.environ.get("FAKE_RSI_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"script": "record.py", "argv": sys.argv[1:]}) + "\\n")
cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "start-tree":
    print("x-2099-01-01")
elif cmd == "open":
    print("n_fake_open")
elif cmd == "finish":
    print("n_fake_open")
elif cmd == "get":
    print("{}")
`;

const FAKE_CHOOSE_PY = `import json, os, sys
log = os.environ.get("FAKE_RSI_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"script": "choose.py", "argv": sys.argv[1:]}) + "\\n")
print(json.dumps([{"policy_id": "p-test", "kind": "open", "ground": "backend/services/", "engine": "codex", "model": None, "cap_s": 1800, "prompt_variant": "v1"}]))
`;

function makeRecorderWorkspace() {
  const dir = tmpdir('atris-rsi-ws-');
  const scripts = path.join(dir, 'backend', 'scripts', 'rsi');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'record.py'), FAKE_RECORD_PY);
  fs.writeFileSync(path.join(scripts, 'choose.py'), FAKE_CHOOSE_PY);
  const state = path.join(dir, '.atris', 'state', 'rsi');
  fs.mkdirSync(state, { recursive: true });
  return { dir, state };
}

function readCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fakeDeps(over = {}) {
  const calls = { api: [], local: [], rows: [], journal: [] };
  return {
    calls,
    deps: {
      loadCredentials: over.loadCredentials || (() => ({ token: 'tok' })),
      getApiBaseUrl: over.getApiBaseUrl || (() => 'https://api.atris.ai/api'),
      now: () => '2026-06-08T00:00:00.000Z',
      apiRequestJson: over.apiRequestJson || (async (p, o) => { calls.api.push({ p, o }); return { ok: true, status: 200, data: {} }; }),
      runLocalFallback: over.runLocalFallback || ((o) => {
        calls.local.push(o);
        return { ok: true, status: 0, summary: { reward: 1, verify: true, shipped: 'local fix', files: ['x.js'], model: 'claude', taskId: 'T1', elapsedMs: 1000 }, stdout: '', stderr: '' };
      }),
      appendScorecardRow: over.appendScorecardRow || ((ws, row) => { calls.rows.push({ ws, row }); return '/ws/.atris/state/scorecards.jsonl'; }),
      appendTickToJournal: over.appendTickToJournal || ((ws, summary, o) => { calls.journal.push({ ws, summary, o }); return '/ws/atris/logs/2026/2026-06-08.md'; }),
      log: () => {},
    },
  };
}

test('rsi-record: missing recorder leaves the tick untouched', async () => {
  const dir = tmpdir('atris-rsi-none-');
  try {
    assert.equal(rsi.beginAttempt(dir, { lane: 'improve_tick' }), null);
    const { calls, deps } = fakeDeps({
      getApiBaseUrl: () => 'http://127.0.0.1:8000',
      apiRequestJson: async (p, o) => { calls.api.push({ p, o }); return { ok: true, status: 200, data: { reward: 5, what_shipped: 'shipped X', verify_passed: true, files_written: ['x.md'], model_used: 'm' } }; },
    });
    const res = await runImprove({ workspace: dir, mode: 'full', fallback: true }, deps);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'api');
    assert.equal(res.summary.reward, 5);
    assert.equal(calls.api.length, 1);
    // No ledger was minted in a workspace without the recorder.
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'rsi')), false);
    assert.equal(fs.existsSync(path.join(dir, 'backend')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rsi-record: recorder present opens and finishes a node with sane JSON', async () => {
  const { dir, state } = makeRecorderWorkspace();
  const logPath = path.join(dir, 'rsi-calls.jsonl');
  const prevState = process.env.ATRIS_RSI_STATE;
  const prevLog = process.env.FAKE_RSI_LOG;
  process.env.ATRIS_RSI_STATE = state;
  process.env.FAKE_RSI_LOG = logPath;
  try {
    const { deps } = fakeDeps({
      getApiBaseUrl: () => 'http://127.0.0.1:8000',
      apiRequestJson: async () => ({ ok: true, status: 200, data: { reward: 5, what_shipped: 'shipped X', verify_passed: true, files_written: ['x.md'], model_used: 'claude-sonnet' } }),
    });
    const res = await runImprove({ workspace: dir, mode: 'full', fallback: true }, deps);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'api');

    const calls = readCalls(logPath);
    const scripts = calls.map((c) => `${c.script}:${c.argv[0]}`);
    assert.deepEqual(scripts, ['record.py:start-tree', 'choose.py:--tree', 'record.py:open', 'record.py:finish']);

    // choose got asked for one action for the tree the recorder minted.
    assert.ok(calls[1].argv.includes('--w'));
    assert.equal(calls[1].argv[calls[1].argv.indexOf('--w') + 1], '1');
    assert.ok(calls[1].argv.includes('x-2099-01-01'));

    // open carried a sane action + context; finish carried a real outcome.
    const openArgs = calls[2].argv;
    const action = JSON.parse(openArgs[openArgs.indexOf('--action-json') + 1]);
    assert.equal(action.policy_id, 'p-test'); // policy id came from choose.py
    assert.equal(action.kind, 'open');
    assert.equal(action.engine, 'claude'); // the engine the tick used
    const ctx = JSON.parse(openArgs[openArgs.indexOf('--context-json') + 1]);
    assert.ok('base_commit' in ctx);
    const finishArgs = calls[3].argv;
    assert.equal(finishArgs[finishArgs.indexOf('--node') + 1], 'n_fake_open');
    const outcome = JSON.parse(finishArgs[finishArgs.indexOf('--outcome-json') + 1]);
    assert.equal(outcome.status, 'shipped');
    assert.equal(outcome.verify, 'pass');
    assert.ok(outcome.files.includes('x.md'));
    assert.equal(typeof outcome.elapsed_s, 'number');
  } finally {
    if (prevState === undefined) delete process.env.ATRIS_RSI_STATE; else process.env.ATRIS_RSI_STATE = prevState;
    if (prevLog === undefined) delete process.env.FAKE_RSI_LOG; else process.env.FAKE_RSI_LOG = prevLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rsi-record: nested calls inside an open attempt record nothing', async () => {
  const { dir, state } = makeRecorderWorkspace();
  const logPath = path.join(dir, 'rsi-calls.jsonl');
  const prevState = process.env.ATRIS_RSI_STATE;
  const prevLog = process.env.FAKE_RSI_LOG;
  const prevGuard = process.env[rsi.GUARD_ENV];
  process.env.ATRIS_RSI_STATE = state;
  process.env.FAKE_RSI_LOG = logPath;
  process.env[rsi.GUARD_ENV] = 'n_parent';
  try {
    // A subprocess spawned mid-attempt must not open its own node.
    assert.equal(rsi.beginAttempt(dir, { lane: 'improve_tick' }), null);
    assert.deepEqual(readCalls(logPath), []);
  } finally {
    if (prevState === undefined) delete process.env.ATRIS_RSI_STATE; else process.env.ATRIS_RSI_STATE = prevState;
    if (prevLog === undefined) delete process.env.FAKE_RSI_LOG; else process.env.FAKE_RSI_LOG = prevLog;
    if (prevGuard === undefined) delete process.env[rsi.GUARD_ENV]; else process.env[rsi.GUARD_ENV] = prevGuard;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rsi-record: a broken recorder logs one line and never changes the tick', async () => {
  const dir = tmpdir('atris-rsi-broken-');
  const scripts = path.join(dir, 'backend', 'scripts', 'rsi');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'record.py'), 'import sys\nsys.exit(3)\n');
  const state = path.join(dir, '.atris', 'state', 'rsi');
  fs.mkdirSync(state, { recursive: true });
  const prevState = process.env.ATRIS_RSI_STATE;
  process.env.ATRIS_RSI_STATE = state;
  const logged = [];
  try {
    const { deps } = fakeDeps({
      getApiBaseUrl: () => 'http://127.0.0.1:8000',
      apiRequestJson: async () => ({ ok: true, status: 200, data: { reward: 5, what_shipped: 'shipped X', verify_passed: true, files_written: ['x.md'] } }),
      log: (m) => logged.push(m),
    });
    const res = await runImprove({ workspace: dir, mode: 'full', fallback: true }, deps);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'api');
    assert.ok(logged.length <= 1, 'recorder failure logs at most one line');
  } finally {
    if (prevState === undefined) delete process.env.ATRIS_RSI_STATE; else process.env.ATRIS_RSI_STATE = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rsi status: fixture state dir prints trees, nodes, outcomes, policy, dream', () => {
  const dir = tmpdir('atris-rsi-status-');
  try {
    const state = path.join(dir, '.atris', 'state', 'rsi');
    fs.mkdirSync(state, { recursive: true });
    const node = (id, tree, lane, day, status, verify = 'skipped', reason = '') => JSON.stringify({
      schema: 'atris.rsi.node.v1', id, tree_id: tree, parent_id: null, created_at: `${day}T03:00:00-0700`, lane,
      context: {}, action: { policy_id: 'p-0009', kind: 'open', ground: '', engine: 'claude', cap_s: 1800, prompt_variant: 'v1' },
      outcome: { status, verify, commits: status === 'shipped' ? 1 : 0, files: [], reason, elapsed_s: 12.5, engine_calls: 1 },
      split: 'train',
    });
    fs.writeFileSync(path.join(state, 'attempts.jsonl'), [
      node('n_1', 'x-2026-09-19', 'improve_tick', '2026-09-19', 'running'),
      node('n_1', 'x-2026-09-19', 'improve_tick', '2026-09-19', 'shipped', 'pass', 'landed fix'),
      node('n_2', 'x-2026-09-19', 'improve_tick', '2026-09-19', 'failed', 'fail', 'verify broke'),
      node('n_3', 'ns-2026-09-19', 'night_shift', '2026-09-19', 'shipped', 'pass'),
    ].join('\n') + '\n');
    fs.mkdirSync(path.join(dir, 'atris', 'rsi'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'rsi', 'policy.current'), 'p-0009\n');
    fs.writeFileSync(path.join(state, 'dreams.jsonl'), JSON.stringify({
      schema: 'atris.rsi.dream.v1', at: '2026-09-14T03:12:00-0700', current: 'p-0001',
      candidates: [], deployed: 'p-0009', reason: 'deployed p-0009: train beat holdout', engine: 'codex', elapsed_s: 5,
    }) + '\n');

    const prevState = process.env.ATRIS_RSI_STATE;
    process.env.ATRIS_RSI_STATE = state;
    let out;
    try {
      const s = rsiCmd.collectStatus(dir);
      out = rsiCmd.formatStatus(s);
    } finally {
      if (prevState === undefined) delete process.env.ATRIS_RSI_STATE; else process.env.ATRIS_RSI_STATE = prevState;
    }
    assert.match(out, /2 trees, 3 attempts across 2 lanes/);
    assert.match(out, /improve_tick: 1 tree, 2 attempts \(1 shipped, 1 failed\)/);
    assert.match(out, /night_shift: 1 tree, 1 attempt \(1 shipped\)/);
    assert.match(out, /last night \(2026-09-19\): 3 attempts/);
    assert.match(out, /n_2: failed - verify broke/);
    assert.match(out, /policy: p-0009/);
    assert.match(out, /last dream: .*deployed p-0009/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rsi status: empty workspace still exits 0 through the real CLI', () => {
  const dir = tmpdir('atris-rsi-empty-');
  try {
    const r = spawnSync(process.execPath, [BIN, 'rsi', 'status'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RSI_STATE: path.join(dir, '.atris', 'state', 'rsi') },
      timeout: 60000,
    });
    assert.equal(r.status, 0, String(r.stderr || '').slice(-300));
    assert.match(r.stdout, /no attempts recorded yet/);
    assert.match(r.stdout, /policy:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
