'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
  buildLocalFallbackEnv,
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

test('buildLocalFallbackEnv: improve --model becomes the fallback runner model', () => {
  const env = buildLocalFallbackEnv(
    { model: 'glm-5.2' },
    { ATRIS_RUNNER_MODEL: 'old-runner', ATRIS_CLAUDE_MODEL: 'old-claude', KEEP_ME: 'yes' }
  );
  assert.equal(env.ATRIS_RUNNER_MODEL, 'glm-5.2');
  assert.equal(env.ATRIS_CLAUDE_MODEL, 'glm-5.2');
  assert.equal(env.KEEP_ME, 'yes');

  const inherited = buildLocalFallbackEnv({}, { ATRIS_RUNNER_MODEL: 'env-model', ATRIS_RUNNER_PROFILE: 'atris-fast' });
  assert.equal(inherited.ATRIS_RUNNER_MODEL, 'env-model');
  assert.equal(inherited.ATRIS_RUNNER_PROFILE, 'atris-fast');
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
      runLocalFallback: over.runLocalFallback || ((o) => { calls.local.push(o); return { ok: true, status: 0, stdout: '', stderr: '' }; }),
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
  const res = await runImprove({ workspace: '/ws', fallback: true, model: 'glm-5.2' }, deps);
  assert.equal(res.source, 'local');
  assert.equal(res.reason, 'no_auth');
  assert.equal(res.ok, true);
  assert.equal(calls.api.length, 0); // did not attempt a paid call without auth
  assert.equal(calls.local.length, 1);
  assert.equal(calls.local[0].model, 'glm-5.2');
});

test('runImprove: unreachable backend falls back to local', async () => {
  const { calls, deps } = fakeDeps({
    apiRequestJson: async () => ({ ok: false, status: 0, error: 'Network error' }),
  });
  const res = await runImprove({ workspace: '/ws', fallback: true, model: 'sonnet' }, deps);
  assert.equal(res.source, 'local');
  assert.equal(res.reason, 'unreachable');
  assert.equal(calls.local.length, 1);
  assert.equal(calls.local[0].model, 'sonnet');
  assert.equal(calls.rows.length, 0); // no scorecard for a non-shipping tick
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
