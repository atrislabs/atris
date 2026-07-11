'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  run,
  runImprove,
  parseImproveArgs,
  buildImprovePayload,
  summarizeImproveResponse,
  shouldFallbackLocal,
  buildScorecardRow,
  appendScorecardRow,
  expandHome,
  readTickHistory,
  summarizeTickHistory,
  formatTickHistory,
  improveApiPath,
  summarizeLocalMissionRun,
  runLoopDoctor,
  SCORECARD_SCHEMA,
} = require('../commands/improve');

test('improveApiPath: base with /api gets /improve, bare base gets /api/improve', () => {
  assert.equal(improveApiPath('https://api.atris.ai/api'), '/improve');
  assert.equal(improveApiPath('https://api.atris.ai/api/'), '/improve');
  assert.equal(improveApiPath('http://localhost:8000'), '/api/improve');
});

test('parseImproveArgs: positional mode + flags', () => {
  assert.equal(parseImproveArgs([]).mode, 'full');
  assert.equal(parseImproveArgs(['plan']).mode, 'plan');
  assert.equal(parseImproveArgs(['--mode', 'delegate']).mode, 'delegate');
  // invalid mode falls back to full
  assert.equal(parseImproveArgs(['--mode', 'bogus']).mode, 'full');

  const opts = parseImproveArgs(['plan', '--model', 'claude-sonnet-4-6', '--dry-run', '--json', '--no-fallback', '--timeout', '120']);
  assert.equal(opts.mode, 'plan');
  assert.equal(opts.model, 'claude-sonnet-4-6');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.json, true);
  assert.equal(opts.fallback, false);
  assert.equal(opts.timeoutMs, 120000);

  assert.equal(parseImproveArgs(['--timeout=90']).timeoutMs, 90000);
  assert.equal(parseImproveArgs(['--help']).help, true);
});

test('buildImprovePayload: maps workspace/mode/model/dry_run', () => {
  const body = buildImprovePayload({ workspace: '/ws', mode: 'plan', model: 'gpt-4o', dryRun: true });
  assert.deepEqual(body, { workspace: '/ws', mode: 'plan', model: 'gpt-4o', dry_run: true });

  const minimal = buildImprovePayload({ workspace: '/ws' });
  assert.deepEqual(minimal, { workspace: '/ws', mode: 'full' });
});

test('summarizeImproveResponse: full-mode response (no credits echoed)', () => {
  const s = summarizeImproveResponse({
    reward: 4,
    what_shipped: 'fixed stale wiki ref',
    verify_passed: true,
    files_written: ['atris/wiki/x.md'],
    model_used: 'claude-sonnet-4-6',
    task_id: 'T1',
    elapsed_ms: 47000,
    scorecard_written: true,
  });
  assert.equal(s.shipped, 'fixed stale wiki ref');
  assert.equal(s.reward, 4);
  assert.equal(s.verify, true);
  assert.equal(s.credits, null); // full mode does not echo credits_deducted
  assert.deepEqual(s.files, ['atris/wiki/x.md']);
  assert.equal(s.model, 'claude-sonnet-4-6');
  assert.equal(s.elapsedMs, 47000);
  assert.equal(s.scorecardWritten, true);
});

test('summarizeImproveResponse: delegate-style dict + alt field names', () => {
  const s = summarizeImproveResponse({
    reward: '3',
    verify_pass: false,
    credits_charged: 2,
    files_changed: ['a.js', 'b.js'],
    summary: 'queued',
  });
  assert.equal(s.reward, 3); // coerced from string
  assert.equal(s.verify, false); // verify_pass alias
  assert.equal(s.credits, 2); // credits_charged alias
  assert.deepEqual(s.files, ['a.js', 'b.js']); // files_changed alias
  assert.equal(s.shipped, 'queued');
});

test('shouldFallbackLocal: only on no-auth or unreachable', () => {
  assert.deepEqual(shouldFallbackLocal({ creds: null }), { fallback: true, reason: 'no_auth' });
  assert.deepEqual(shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: true, status: 200 } }), { fallback: false, reason: 'api_ok' });
  assert.deepEqual(shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 0 } }), { fallback: true, reason: 'unreachable' });
  // insufficient credits / real server errors are reported, not silently fallen back
  assert.deepEqual(shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 402 } }), { fallback: false, reason: 'api_error_402' });
  assert.deepEqual(shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 500 } }), { fallback: false, reason: 'api_error_500' });
});

test('shouldFallbackLocal: remote backend cannot see a local workspace → fallback', () => {
  // The hosted backend validates workspace_path against ITS OWN filesystem,
  // so a local-only folder 403s even when the user is authed and funded.
  // That is an unreachable-workspace condition, not an answerable failure —
  // the tick should run locally instead of dying.
  const detail = { error: 'workspace_path must be under an allowed directory' };
  assert.deepEqual(
    shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 403, error: detail } }),
    { fallback: true, reason: 'workspace_not_on_backend' }
  );
  // nested detail shape ({ error: { error: ... } }) also matches
  assert.deepEqual(
    shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 403, data: { detail } } }),
    { fallback: true, reason: 'workspace_not_on_backend' }
  );
  // an unrelated 403 (e.g. forbidden business) is still reported honestly
  assert.deepEqual(
    shouldFallbackLocal({ creds: { token: 't' }, apiResult: { ok: false, status: 403, error: 'forbidden' } }),
    { fallback: false, reason: 'api_error_403' }
  );
});

test('local fallback runs exactly one due mission tick with JSON proof', () => {
  const { LOCAL_FALLBACK_ARGS, localFallbackArgs } = require('../commands/improve');
  assert.deepEqual(LOCAL_FALLBACK_ARGS, ['mission', 'run', '--due', '--headless', '--max-ticks', '1', '--complete-on-pass', '--json']);
  assert.deepEqual(localFallbackArgs(300), [...LOCAL_FALLBACK_ARGS, '--max-wall', '300']);
  assert.deepEqual(localFallbackArgs(30), [...LOCAL_FALLBACK_ARGS, '--max-wall', '60']);
});

test('summarizeLocalMissionRun accepts one verified tick and rejects missing proof', () => {
  const verified = summarizeLocalMissionRun({
    ok: true,
    action: 'mission_run',
    mission: { objective: 'fix the fallback', task_id: 'T1', runner: 'claude' },
    tick_count: 1,
    ticks: [{
      status: 'ran',
      verifier_passed: true,
      claude: { summary: 'fixed the fallback' },
      worktree: { new_since_baseline_sample: ['commands/improve.js'] },
    }],
  });
  assert.equal(verified.verify, true);
  assert.equal(verified.reward, 1);
  assert.equal(verified.shipped, 'fixed the fallback');
  assert.deepEqual(verified.files, ['commands/improve.js']);

  assert.throws(
    () => summarizeLocalMissionRun({ ok: true, action: 'mission_run', tick_count: 1, ticks: [{ status: 'ran' }] }),
    /verifier did not pass/
  );
  assert.throws(
    () => summarizeLocalMissionRun({ ok: true, action: 'mission_run', tick_count: 2, ticks: [{}, {}] }),
    /exactly one tick/
  );
  assert.throws(
    () => summarizeLocalMissionRun({
      ok: true,
      action: 'mission_run',
      tick_count: 1,
      ticks: [{ status: 'ran', reason: 'caller-session-runner', verifier_passed: true, claude: { skipped: true } }],
    }),
    /worker did not run/
  );
});

test('real local improve fallback runs one drill tick, verifies it, and writes one scorecard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-runtime-'));
  const home = path.join(dir, 'home');
  const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const env = { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_TOKEN;
  const runCli = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const started = runCli([
      'mission', 'start',
      'prove one local improve tick',
      '--owner', 'improver',
      '--runner', 'drill',
      '--verify', 'test -f .atris/state/drill-runner-touch.txt',
      '--json',
    ]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const caller = runCli([
      'mission', 'start',
      'newer caller placeholder',
      '--owner', 'improver',
      '--runner', 'codex_goal',
      '--verify', 'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ]);
    assert.equal(caller.status, 0, caller.stderr || caller.stdout);

    const improved = runCli(['improve', 'tick', '--json', '--timeout=60']);
    assert.equal(improved.status, 0, improved.stderr || improved.stdout);
    const payload = JSON.parse(improved.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.source, 'local');
    assert.equal(payload.local.payload.tick_count, 1);
    assert.equal(payload.local.payload.mission.runner, 'drill');
    assert.equal(payload.local.payload.ticks[0].verifier_passed, true);
    assert.equal(payload.summary.reward, 1);
    assert.equal(payload.receipt, 'written');

    const scorecards = fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.schema === SCORECARD_SCHEMA);
    assert.equal(scorecards.length, 1);
    assert.equal(scorecards[0].source, 'local');
    assert.equal(scorecards[0].verify_passed, true);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'drill-runner-touch.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real local improve fallback proves success in human output mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-human-'));
  const home = path.join(dir, 'home');
  const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const env = { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_TOKEN;
  const runCli = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const started = runCli([
      'mission', 'start',
      'prove human local improve output',
      '--owner', 'improver',
      '--runner', 'drill',
      '--verify', 'test -f .atris/state/drill-runner-touch.txt',
      '--json',
    ]);
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const improved = runCli(['improve', 'tick', '--timeout=60']);
    assert.equal(improved.status, 0, improved.stderr || improved.stdout);
    assert.match(improved.stdout, /improved \(local fallback\)/);
    assert.match(improved.stdout, /verify:\s+pass/);
    const rows = readTickHistory(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verify_passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScorecardRow: stable schema + fields', () => {
  const row = buildScorecardRow(
    { reward: 4, verify: true, credits: 1, shipped: 'did a thing', files: ['x'], model: 'm', taskId: 'T1', elapsedMs: 1000 },
    { source: 'api', mode: 'full', ts: '2026-06-08T00:00:00.000Z' }
  );
  assert.equal(row.schema, SCORECARD_SCHEMA);
  assert.equal(row.source, 'api');
  assert.equal(row.reward, 4);
  assert.equal(row.verify_passed, true);
  assert.equal(row.credits_deducted, 1);
  assert.equal(row.what_shipped, 'did a thing');
  assert.deepEqual(row.files_written, ['x']);
  assert.equal(row.ts, '2026-06-08T00:00:00.000Z');
});

test('appendScorecardRow: writes JSONL row to .atris/state/scorecards.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-'));
  try {
    const row = buildScorecardRow({ reward: 2, verify: true }, { source: 'api', ts: '2026-06-08T00:00:00.000Z' });
    const file = appendScorecardRow(dir, row);
    assert.ok(fs.existsSync(file));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(parsed.schema, SCORECARD_SCHEMA);
    assert.equal(parsed.reward, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- orchestrator branches (fully injected deps; no network, no real tick) ----

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
        return {
          ok: true,
          status: 0,
          summary: { reward: 1, verify: true, shipped: 'local fix', files: ['x.js'], model: 'claude', taskId: 'T1', elapsedMs: 1000 },
          stdout: '',
          stderr: '',
        };
      }),
      appendScorecardRow: over.appendScorecardRow || ((ws, row) => { calls.rows.push({ ws, row }); return '/ws/.atris/state/scorecards.jsonl'; }),
      appendTickToJournal: over.appendTickToJournal || ((ws, summary, o) => { calls.journal.push({ ws, summary, o }); return '/ws/atris/logs/2026/2026-06-08.md'; }),
      log: () => {},
    },
  };
}

test('runImprove: API success writes a scorecard and reports api source', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async (p, o) => {
      calls.api.push({ p, o });
      return { ok: true, status: 200, data: { reward: 5, what_shipped: 'shipped X', verify_passed: true, files_written: ['x.md'], model_used: 'm' } };
    },
  });
  const res = await runImprove({ workspace: '/ws', mode: 'full', fallback: true }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.source, 'api');
  assert.equal(res.summary.reward, 5);
  assert.equal(res.summary.verify, true);
  assert.equal(calls.api[0].p, '/improve'); // resolved against /api base
  assert.equal(calls.api[0].o.body.workspace, '/ws');
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].row.what_shipped, 'shipped X');
  assert.equal(calls.journal.length, 1); // tick also lands in the human journal
  assert.equal(calls.journal[0].summary.shipped, 'shipped X');
  assert.equal(calls.local.length, 0); // never fell back
});

test('appendTickToJournal: writes an Improve Tick block under ## Notes (local date)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-'));
  try {
    const { appendTickToJournal } = require('../commands/improve');
    const file = appendTickToJournal(
      dir,
      { shipped: 'add --history', verify: true, reward: 4, credits: 0 },
      { source: 'local', dateKey: '2026-06-08', time: '14:30' }
    );
    assert.ok(file.endsWith(path.join('atris', 'logs', '2026', '2026-06-08.md')));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /## Notes/);
    assert.match(text, /### Improve Tick — 14:30/);
    assert.match(text, /shipped: add --history/);
    assert.match(text, /verify: pass · reward: 4 · credits: 0 · source: local/);
    // a second tick prepends under Notes (newest first), file stays valid
    appendTickToJournal(dir, { shipped: 'second', verify: false, reward: 0 }, { source: 'local', dateKey: '2026-06-08', time: '15:00' });
    const text2 = fs.readFileSync(file, 'utf8');
    assert.match(text2, /### Improve Tick — 15:00/);
    assert.match(text2, /### Improve Tick — 14:30/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runImprove: no auth falls back to local without calling the API', async () => {
  const { calls, deps } = fakeDeps({ loadCredentials: () => null });
  const res = await runImprove({ workspace: '/ws', fallback: true }, deps);
  assert.equal(res.source, 'local');
  assert.equal(res.reason, 'no_auth');
  assert.equal(res.ok, true);
  assert.equal(calls.api.length, 0); // did not attempt a paid call without auth
  assert.equal(calls.local.length, 1);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].row.source, 'local');
  assert.equal(calls.journal.length, 1);
});

test('runImprove: unreachable backend falls back to local', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async () => ({ ok: false, status: 0, error: 'Network error' }),
  });
  const res = await runImprove({ workspace: '/ws', fallback: true }, deps);
  assert.equal(res.source, 'local');
  assert.equal(res.reason, 'unreachable');
  assert.equal(calls.local.length, 1);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.journal.length, 1);
});

test('runImprove: existing local workspace skips an impossible hosted API call', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-local-workspace-'));
  try {
    const { calls, deps } = fakeDeps({
      getApiBaseUrl: () => 'https://api.atris.ai/api',
    });
    const res = await runImprove({ workspace, fallback: true }, deps);

    assert.equal(res.ok, true);
    assert.equal(res.source, 'local');
    assert.equal(res.reason, 'workspace_not_on_backend');
    assert.equal(calls.api.length, 0);
    assert.equal(calls.local.length, 1);
    assert.equal(calls.local[0].workspace, workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runImprove: loopback API still receives an existing local workspace', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-loopback-workspace-'));
  try {
    const { calls, deps } = fakeDeps({
      getApiBaseUrl: () => 'http://127.0.0.1:8000',
    });
    const res = await runImprove({ workspace, fallback: true }, deps);

    assert.equal(res.ok, true);
    assert.equal(res.source, 'api');
    assert.equal(calls.api.length, 1);
    assert.equal(calls.api[0].o.body.workspace, workspace);
    assert.equal(calls.local.length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runImprove: hosted API still receives a workspace not present locally', async () => {
  const workspace = path.join(os.tmpdir(), `atris-hosted-workspace-${process.pid}-${Date.now()}`);
  const { calls, deps } = fakeDeps({
    getApiBaseUrl: () => 'https://api.atris.ai/api',
  });
  const res = await runImprove({ workspace, fallback: true }, deps);

  assert.equal(res.ok, true);
  assert.equal(res.source, 'api');
  assert.equal(calls.api.length, 1);
  assert.equal(calls.api[0].o.body.workspace, workspace);
  assert.equal(calls.local.length, 0);
});

const NONSHIPPING_CASES = [
  ['plan', { mode: 'plan' }],
  ['delegate', { mode: 'delegate' }],
  ['dry-run', { mode: 'full', dryRun: true }],
];

test('runImprove: hosted nonshipping modes use the API for an existing local workspace', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-nonshipping-workspace-'));
  try {
    for (const [label, options] of NONSHIPPING_CASES) {
      const { calls, deps } = fakeDeps({ getApiBaseUrl: () => 'https://api.atris.ai/api' });
      const res = await runImprove({ workspace, fallback: true, ...options }, deps);
      assert.equal(res.source, 'api', label);
      assert.equal(res.receipt, 'skipped', label);
      assert.equal(calls.api.length, 1, label);
      assert.equal(calls.local.length, 0, label);
      assert.equal(calls.rows.length, 0, label);
      assert.equal(calls.journal.length, 0, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runImprove: nonshipping API failures never enter the local shipping fallback', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-nonshipping-failure-'));
  try {
    for (const [label, options] of NONSHIPPING_CASES) {
      const { calls, deps } = fakeDeps({
        getApiBaseUrl: () => 'http://127.0.0.1:8000',
        apiRequestJson: async (p, o) => {
          calls.api.push({ p, o });
          return { ok: false, status: 0, error: 'Network error' };
        },
      });
      const res = await runImprove({ workspace, fallback: true, ...options }, deps);
      assert.equal(res.ok, false, label);
      assert.equal(res.source, 'api', label);
      assert.equal(res.reason, 'unreachable', label);
      assert.equal(calls.api.length, 1, label);
      assert.equal(calls.local.length, 0, label);
      assert.equal(calls.rows.length, 0, label);
      assert.equal(calls.journal.length, 0, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runImprove: no-auth nonshipping modes never enter the local shipping fallback', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-nonshipping-no-auth-'));
  try {
    for (const [label, options] of NONSHIPPING_CASES) {
      const { calls, deps } = fakeDeps({ loadCredentials: () => null });
      const res = await runImprove({ workspace, fallback: true, ...options }, deps);
      assert.equal(res.ok, false, label);
      assert.equal(res.source, 'none', label);
      assert.equal(res.reason, 'no_auth', label);
      assert.equal(calls.api.length, 0, label);
      assert.equal(calls.local.length, 0, label);
      assert.equal(calls.rows.length, 0, label);
      assert.equal(calls.journal.length, 0, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('runImprove: local fallback without verifier proof fails and writes no receipt', async () => {
  const { calls, deps } = fakeDeps({
    loadCredentials: () => null,
    runLocalFallback: (o) => {
      calls.local.push(o);
      return { ok: false, status: 1, error: 'local improve verifier did not pass', stdout: '', stderr: '' };
    },
  });
  const res = await runImprove({ workspace: '/ws', fallback: true }, deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /verifier did not pass/);
  assert.equal(calls.rows.length, 0);
  assert.equal(calls.journal.length, 0);
});

test('runImprove: insufficient credits (402) is reported, not silently retried locally', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async () => ({ ok: false, status: 402, error: 'insufficient credits' }),
  });
  const res = await runImprove({ workspace: '/ws', fallback: true }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.source, 'api');
  assert.equal(res.reason, 'api_error_402');
  assert.equal(res.error, 'insufficient credits');
  assert.equal(calls.local.length, 0); // did NOT run local work on a real, answerable failure
});

test('runImprove: --no-fallback + no auth reports instead of running local', async () => {
  const { calls, deps } = fakeDeps({ loadCredentials: () => null });
  const res = await runImprove({ workspace: '/ws', fallback: false }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.source, 'none');
  assert.equal(res.reason, 'no_auth');
  assert.equal(calls.local.length, 0);
});

// ---- tick history (the compounding signal — proves the loop is recursive) ----

test('summarizeTickHistory: aggregates reward trend, credits, and pass rate', () => {
  const rows = [
    { schema: SCORECARD_SCHEMA, reward: 3, verify_passed: true, credits_deducted: 1 },
    { schema: SCORECARD_SCHEMA, reward: 5, verify_passed: true, credits_deducted: 1 },
    { schema: SCORECARD_SCHEMA, reward: 0, verify_passed: false, credits_deducted: 0 },
  ];
  const s = summarizeTickHistory(rows);
  assert.equal(s.ticks, 3);
  assert.equal(s.shipped, 2);
  assert.equal(Math.round(s.passRate * 100), 67);
  assert.equal(s.totalReward, 8);
  assert.equal(s.totalCredits, 2);
  assert.deepEqual(s.rewardTrend, [3, 5, 0]);
});

test('summarizeTickHistory: empty history is safe', () => {
  const s = summarizeTickHistory([]);
  assert.equal(s.ticks, 0);
  assert.equal(s.passRate, 0);
  assert.equal(s.totalReward, 0);
  assert.match(formatTickHistory(s), /no ticks yet/);
});

test('readTickHistory: reads only improve-tick rows, ignores foreign JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hist-'));
  try {
    const f = path.join(dir, '.atris', 'state', 'scorecards.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [
      JSON.stringify({ schema: SCORECARD_SCHEMA, reward: 4, verify_passed: true, credits_deducted: 1 }),
      JSON.stringify({ schema: 'some.other.schema', reward: 99 }), // foreign row ignored
      'not json at all',
      JSON.stringify({ schema: SCORECARD_SCHEMA, reward: 2, verify_passed: false }),
    ].join('\n') + '\n', 'utf8');
    const rows = readTickHistory(dir);
    assert.equal(rows.length, 2); // only the two improve-tick rows
    const s = summarizeTickHistory(rows);
    assert.equal(s.ticks, 2);
    assert.equal(s.totalReward, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseImproveArgs: history (positional or flag)', () => {
  assert.equal(parseImproveArgs(['history']).history, true);
  assert.equal(parseImproveArgs(['--history']).history, true);
  assert.equal(parseImproveArgs([]).history, false);
});

// ---- member attribution (the member is the source of the loop) ----

test('expandHome: leading ~ expands to homedir for local writes, absolute paths untouched', () => {
  assert.equal(expandHome('~/arena/atris-business'), path.join(os.homedir(), 'arena/atris-business'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('relative/path'), 'relative/path');
  // a literal ~ workspace must NOT create a './~' dir on scorecard write
  const row = buildScorecardRow({ reward: 1, verify: true }, { source: 'api' });
  const file = appendScorecardRow('~/.atris-improve-test-tmp', row);
  try {
    assert.ok(file.startsWith(os.homedir()), `expected homedir-rooted path, got ${file}`);
    assert.ok(!file.includes('/~/'), 'must not contain a literal ~ segment');
  } finally {
    fs.rmSync(path.join(os.homedir(), '.atris-improve-test-tmp'), { recursive: true, force: true });
  }
});

test('parseImproveArgs: --member attributes the tick', () => {
  assert.equal(parseImproveArgs(['--member', 'improver']).member, 'improver');
  assert.equal(parseImproveArgs([]).member, null);
});

test('buildScorecardRow: carries the member that owned the tick', () => {
  const row = buildScorecardRow({ reward: 4, verify: true }, { source: 'api', member: 'improver' });
  assert.equal(row.member, 'improver');
  const anon = buildScorecardRow({ reward: 4, verify: true }, { source: 'api' });
  assert.equal(anon.member, null);
});

test('runImprove: --member is recorded on the scorecard row and journal, not sent to the API', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async (p, o) => { calls.api.push({ p, o }); return { ok: true, status: 200, data: { reward: 5, what_shipped: 'x', verify_passed: true } }; },
  });
  const res = await runImprove({ workspace: '/ws', mode: 'full', member: 'improver', fallback: true }, deps);
  assert.equal(res.ok, true);
  assert.equal(calls.rows[0].row.member, 'improver'); // attributed in the receipt
  assert.equal(calls.journal[0].o.member, 'improver'); // attributed in the journal
  assert.equal(calls.api[0].o.body.member, undefined); // never sent to the backend (avoids 422)
});

test('runImprove: plan mode ships nothing — no scorecard, no journal', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async () => ({ ok: true, status: 200, data: { reward: 0, what_shipped: 'plan only', instructions: {} } }),
  });
  const res = await runImprove({ workspace: '/ws', mode: 'plan', fallback: true }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.receipt, 'skipped');
  assert.equal(calls.rows.length, 0); // plan writes no receipt
  assert.equal(calls.journal.length, 0);
});

test('runImprove: ok envelope carrying a server error writes no receipt', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async () => ({ ok: true, status: 200, data: { reward: 0, what_shipped: 'workspace not found', error: 'workspace does not exist: /opt/render/arena/atris-business' } }),
  });
  const res = await runImprove({ workspace: '/ws', mode: 'full', fallback: true }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.receipt, 'skipped'); // error-in-envelope is not a shipped change
  assert.equal(calls.rows.length, 0);
  assert.equal(calls.journal.length, 0);
});

function fakeFinding(kind = 'repeated_auth_failure') {
  return {
    kind,
    evidence: { detail: 'fake finding for tests' },
    count: 2,
    suggested_mission: {
      objective: 'repair the fake thing',
      verifier: `atris improve doctor --check ${kind}`,
      owner: 'auto-improver',
      cadence: '15m',
    },
  };
}

test('doctor --check exits 0 when the finding is absent and 1 when present', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const absent = await run(['doctor', '--check', 'repeated_auth_failure'], {
      scanLoopReceipts: () => [],
    });
    assert.equal(absent, 0);
    assert.equal(lines.pop(), 'loop doctor check passed: no repeated_auth_failure finding.');

    const present = await run(['doctor', '--check', 'repeated_auth_failure'], {
      scanLoopReceipts: () => [fakeFinding()],
    });
    assert.equal(present, 1);
    assert.equal(lines.pop(), 'loop doctor check failed: repeated_auth_failure is still present.');
  } finally {
    console.log = originalLog;
  }
});

test('doctor --fix files the repair mission with runner auto, not claude', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-doctor-'));
  try {
    const startCalls = [];
    const deps = {
      scanLoopReceipts: () => [fakeFinding()],
      startMission: (args) => {
        startCalls.push(args);
        return { mission: { id: 'mission-fake-1', objective: args[0], status: 'planning' } };
      },
      workspace: root,
      now: new Date('2026-07-10T12:00:00.000Z'),
    };
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      runLoopDoctor(['--fix', '--json'], deps);
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(startCalls.length, 1);
    const runnerFlagIndex = startCalls[0].indexOf('--runner');
    assert.ok(runnerFlagIndex !== -1, 'expected --runner flag in filed mission args');
    assert.equal(startCalls[0][runnerFlagIndex + 1], 'auto');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor --fix writes a scorecard row on mission_started but not on mission_exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-doctor-'));
  try {
    const scorecardFile = path.join(root, '.atris', 'state', 'scorecards.jsonl');
    const missionsFile = path.join(root, '.atris', 'state', 'missions.jsonl');
    const finding = fakeFinding('reward_flatline');
    const deps = {
      scanLoopReceipts: () => [finding],
      startMission: (args) => {
        const mission = { id: 'mission-fake-2', objective: args[0], status: 'planning' };
        fs.mkdirSync(path.dirname(missionsFile), { recursive: true });
        fs.appendFileSync(missionsFile, `${JSON.stringify({ mission })}\n`, 'utf8');
        return { mission };
      },
      workspace: root,
      now: new Date('2026-07-10T12:00:00.000Z'),
    };
    const originalCwd = process.cwd();
    process.chdir(root);
    let secondPayload;
    try {
      runLoopDoctor(['--fix', '--json'], deps);
      secondPayload = runLoopDoctor(['--fix', '--json'], deps);
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(secondPayload.fix.action, 'mission_exists');

    assert.ok(fs.existsSync(scorecardFile), 'expected a scorecard row on mission_started');
    const rows = fs.readFileSync(scorecardFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].schema, 'atris.loop_doctor.v1');
    assert.equal(rows[0].source, 'loop_doctor');
    assert.equal(rows[0].kind, 'reward_flatline');
    assert.equal(rows[0].mission_id, 'mission-fake-2');
    assert.equal(rows[0].reward, 0);
    assert.equal(rows[0].note, 'repair filed; reward is earned by the repair tick, not the filing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
