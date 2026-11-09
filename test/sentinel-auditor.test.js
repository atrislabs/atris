'use strict';

// The sentinel auditor: every review re-checks the last review's open
// findings. Real temp git repos, a fake engine and a local fake backend.
// No real model, no network, no credits.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const { auditCommand } = require('../commands/security-review');

const FIXED_LINE = "  return execFileSync('echo', [title]);";

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auditor-target-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'run.js'), [
    "const { execSync } = require('child_process');",
    'function runTask(task) {',
    '  const title = task.title;',
    '  return execSync(`echo ${title}`);',
    '}',
    'module.exports = { runTask };',
    '',
  ].join('\n'));
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

// The fix from the record's remediation: arguments, not a shell string.
function applyFix(root) {
  fs.writeFileSync(path.join(root, 'lib', 'run.js'), [
    "const { execFileSync } = require('child_process');",
    'function runTask(task) {',
    '  const title = task.title;',
    FIXED_LINE,
    '}',
    'module.exports = { runTask };',
    '',
  ].join('\n'));
}

// Lines added above the hole: same bug, new line numbers.
function shiftDown(root) {
  const file = path.join(root, 'lib', 'run.js');
  fs.writeFileSync(file, `// one\n// two\n${fs.readFileSync(file, 'utf8')}`);
}

const CANDIDATE = {
  proposed_verdict: 'confirmed',
  fingerprint: 'lib/run.js:runTask/shell-from-task-title',
  title: 'Task title runs as shell code',
  description: 'runTask puts the task title inside a shell string.',
  attack_class: 'command-injection',
  attacker: 'anyone who can create a task',
  root_cause: 'execSync gets a template string with the title in it',
  intended_behavior: 'the title is passed as an argument, never as shell text',
  impact: 'code execution as the user running the task',
  trace: [
    { kind: 'entrypoint', file: 'lib/run.js', line: 2, description: 'task arrives' },
    { kind: 'propagation', file: 'lib/run.js', line: 3, description: 'title read' },
    { kind: 'sink', file: 'lib/run.js', line: 4, description: 'execSync with title' },
  ],
  conditions: [{ kind: 'authorization_role', description: 'can create a task' }],
  severity: { likelihood: { score: 'medium', reason: 'tasks come from other people' }, impact: { score: 'high', reason: 'code execution' }, overall: 'high' },
  remediation: { strategy: 'use execFileSync with an argv array', summary: 'Pass the command and its arguments separately instead of building one shell string.', regression_test: 'a title with $(touch x) creates no file' },
};

const FIXED_ANSWER = { status: 'fixed', reason: 'line 4 now passes the title as an argument with no shell', closing_line: { file: 'lib/run.js', line: 4, code: FIXED_LINE.trim() } };

// What each sentinel prompt gets back. `auditor` is the auditor's answer.
function answerFor(prompt, { auditor = FIXED_ANSWER, clean = false } = {}) {
  if (prompt.includes('security hunter')) {
    const ids = [...prompt.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
    const isRun = !clean && prompt.includes('starting paths: lib/run.js') && prompt.includes('command-injection');
    return JSON.stringify({
      units: ids.map((id) => ({ coverage_id: id, disposition: isRun ? 'candidate' : 'covered', reviewed_paths: ['lib/run.js'], checks: [{ invariant: 'input never becomes shell text', method: 'source', result: 'read it', reviewed_paths: ['lib/run.js'] }], candidate_fingerprints: isRun ? [CANDIDATE.fingerprint] : [], unresolved: [] })),
      candidates: isRun ? [{ ...CANDIDATE, coverage_ids: ids }] : [],
      hardening: [],
      uncovered: [],
    });
  }
  if (prompt.includes('independent security verifier')) return JSON.stringify({ verdict: 'confirmed', reason: 'line 4 puts the title in a shell string', preventing_layer: null, corrected: {} });
  if (prompt.includes('coverage critic')) return JSON.stringify({ missing_units: [], reassign_ids: [], stop: true });
  if (prompt.includes('final record checker')) return '{"ok": true}';
  if (prompt.includes('You are the auditor')) return typeof auditor === 'string' ? auditor : JSON.stringify(auditor);
  return 'no idea';
}

function engines(calls, opts) {
  return async (jobs) => jobs.map((job) => { calls.push(job); return { ok: true, stdout: answerFor(job.prompt, opts) }; });
}

function auditorCalls(calls) {
  return calls.filter((c) => c.prompt.includes('You are the auditor'));
}

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auditor-home-'));
  const prev = process.env.ATRIS_SECURITY_AUDIT_HOME;
  process.env.ATRIS_SECURITY_AUDIT_HOME = path.join(home, 'audits');
  try { return await fn(home); } finally {
    if (prev === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME; else process.env.ATRIS_SECURITY_AUDIT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A first review that confirms the hole, found by codex, checked by claude.
async function firstReview(root) {
  const res = await audit.runAudit({ root, profile: 'quick', runJobs: engines([]) });
  assert.ok(res.records.some((r) => r.verdict === 'confirmed' && r.fingerprint === CANDIDATE.fingerprint), 'the first review confirms the hole');
  return res;
}

test('a fixed finding becomes fixed with the line that closes it', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    applyFix(root);
    const calls = [];
    const res = await audit.runRecheck({ root, runJobs: engines(calls) });
    assert.strictEqual(auditorCalls(calls).length, 1);
    assert.strictEqual(calls.length, 1, 'a re-check never hunts');
    assert.strictEqual(calls[0].engine, 'claude', 'the verifier, not the codex hunter that found it');
    assert.ok(calls[0].prompt.includes('"code_then": "return execSync(`echo ${title}`);"'), 'the auditor sees the line as it was');
    assert.ok(calls[0].prompt.includes(`"code_now": "${FIXED_LINE.trim()}"`), 'and as it is now');
    const fixed = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.strictEqual(fixed.verdict, 'fixed');
    assert.deepStrictEqual(fixed.closed_at, { file: 'lib/run.js', line: 4, code: FIXED_LINE.trim() });
    assert.strictEqual(fixed.fixed_by.engine, 'claude');
    assert.match(fixed.fixed_by.reason, /argument/);
    assert.deepStrictEqual(audit.validateFindings(res.records, { root }), []);
    assert.strictEqual(res.meta.mode, 'recheck');
    assert.strictEqual(res.meta.counts.confirmed, 0);
    assert.strictEqual(res.meta.invocations.used, 1);
    const report = fs.readFileSync(path.join(res.dir, 'REPORT.md'), 'utf8');
    assert.ok(report.includes('## Fixed since the last review'));
    assert.ok(report.includes('Closed at lib/run.js:4'));
    assert.deepStrictEqual(audit.validateLedger(JSON.parse(fs.readFileSync(path.join(res.dir, 'coverage-ledger.json'), 'utf8'))), []);
    // The next re-check has nothing open left.
    const again = await audit.runRecheck({ root, runJobs: engines([]) });
    assert.match(again.nothing, /no open findings/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('an untouched finding stays open with zero engine calls', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    // A change far from the cited lines is not a change to them.
    fs.writeFileSync(path.join(root, 'lib', 'other.js'), 'module.exports = 1;\n');
    const calls = [];
    const res = await audit.runRecheck({ root, runJobs: engines(calls) });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(res.meta.invocations.used, 0);
    assert.strictEqual(res.meta.audit.unchanged, 1);
    const rec = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.strictEqual(rec.verdict, 'confirmed');
    assert.strictEqual(res.meta.counts.confirmed, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('an older record without windows is compared through git and stays open with no call when nothing changed', () => withHome(async () => {
  const root = makeRepo();
  try {
    const first = await firstReview(root);
    // Records from before windows existed: only the cited code and the commit.
    const file = path.join(first.dir, 'findings.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8')).map((r) => { const c = { ...r }; delete c.source_windows; return c; });
    fs.writeFileSync(file, JSON.stringify(records));
    const calls = [];
    const res = await audit.runRecheck({ root, runJobs: engines(calls) });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint).verdict, 'confirmed');
    // The original commit stays the baseline: a later edit is still caught.
    applyFix(root);
    git(root, 'commit', '-qam', 'fix');
    const calls2 = [];
    const res2 = await audit.runRecheck({ root, runJobs: engines(calls2) });
    assert.strictEqual(auditorCalls(calls2).length, 1);
    assert.strictEqual(res2.records.find((r) => r.fingerprint === CANDIDATE.fingerprint).verdict, 'fixed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('an ambiguous or unproven answer keeps the finding open', () => withHome(async () => {
  const answers = [
    { status: 'unsure', reason: 'cannot tell if the caller still passes raw titles' },
    'it looks fixed to me',
    { status: 'fixed', reason: 'looks fine now' },
    { status: 'fixed', reason: 'quoted a line that is not there', closing_line: { file: 'lib/run.js', line: 4, code: 'if (!safe(title)) throw new Error("bad title");' } },
    { status: 'fixed', reason: 'cites a file that does not exist', closing_line: { file: 'lib/nope.js', line: 1, code: 'nope' } },
  ];
  for (const auditor of answers) {
    const root = makeRepo();
    try {
      await firstReview(root);
      applyFix(root);
      const calls = [];
      const res = await audit.runRecheck({ root, runJobs: engines(calls, { auditor }) });
      assert.strictEqual(auditorCalls(calls).length, 1);
      assert.ok(!res.records.some((r) => r.verdict === 'fixed'), `stays open for ${JSON.stringify(auditor)}`);
      assert.strictEqual(res.meta.counts.confirmed, 1);
      assert.strictEqual(res.meta.audit.fixed, 0);
      // The old lines still resolve: it stays in the findings as open.
      const open = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
      assert.strictEqual(open.verdict, 'confirmed');
      // Unsure keeps the old baseline: the next re-check asks again.
      const calls2 = [];
      await audit.runRecheck({ root, runJobs: engines(calls2, { auditor }) });
      assert.strictEqual(auditorCalls(calls2).length, 1, 'still asked next time');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}));

test('an open finding whose lines moved keeps its new location', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    shiftDown(root);
    const moved = { status: 'open', reason: 'the title still reaches a shell string', trace: [
      { kind: 'entrypoint', file: 'lib/run.js', line: 4, description: 'task arrives' },
      { kind: 'sink', file: 'lib/run.js', line: 6, description: 'execSync with title' },
    ] };
    const calls = [];
    const res = await audit.runRecheck({ root, runJobs: engines(calls, { auditor: moved }) });
    assert.ok(auditorCalls(calls)[0].prompt.includes('"same_code_now_at_line": 6'), 'the auditor is told where the old line sits now');
    const rec = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.strictEqual(rec.verdict, 'confirmed');
    assert.strictEqual(rec.moved_from, 'lib/run.js:4');
    assert.strictEqual(rec.trace[rec.trace.length - 1].line, 6);
    assert.strictEqual(rec.trace[rec.trace.length - 1].code, 'return execSync(`echo ${title}`);');
    assert.deepStrictEqual(audit.validateFindings(res.records, { root }), []);
    // Checked against today's code: the next re-check with no edits costs nothing.
    const calls2 = [];
    await audit.runRecheck({ root, runJobs: engines(calls2) });
    assert.strictEqual(calls2.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a finding whose old lines are gone and gets no answer stays open in the upload', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    fs.writeFileSync(path.join(root, 'lib', 'run.js'), 'module.exports = {};\n');
    const res = await audit.runRecheck({ root, runJobs: async (jobs) => jobs.map(() => ({ ok: false, stdout: '', reason: 'timed out' })) });
    assert.strictEqual(res.meta.run_status, 'incomplete');
    assert.strictEqual(res.meta.audit.held.length, 1);
    assert.strictEqual(res.meta.counts.confirmed, 1);
    const body = require('../lib/sentinel-cloud').buildUploadBody(res.dir);
    assert.deepStrictEqual(body.findings.map((f) => [f.title, f.status]), [[CANDIDATE.title, 'open']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('the engine that found a finding is never asked to close it', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    applyFix(root);
    const calls = [];
    const res = await audit.runRecheck({ root, verifier: 'codex', runJobs: engines(calls) });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint).verdict, 'confirmed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a full review re-checks the changed finding first and closes it', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    applyFix(root);
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'quick', runJobs: engines(calls, { clean: true }) });
    const order = calls.map((c) => (c.prompt.includes('You are the auditor') ? 'auditor' : c.prompt.includes('security hunter') ? 'hunter' : 'other'));
    assert.strictEqual(order[0], 'auditor', 'the re-check runs before any hunting');
    assert.strictEqual(res.meta.invocations.audits, 1);
    assert.ok(res.meta.invocations.used <= res.meta.budget);
    const fixed = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.strictEqual(fixed.verdict, 'fixed');
    assert.ok(calls.filter((c) => c.prompt.includes('security hunter')).every((c) => c.prompt.includes(`${CANDIDATE.fingerprint}: ${CANDIDATE.title} (already on record, being re-checked)`)), 'hunters are told it is on record');
    assert.deepStrictEqual(audit.validateFindings(res.records, { root }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a hunter and verifier confirming the same finding again outrank a fixed answer', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    applyFix(root);
    const res = await audit.runAudit({ root, profile: 'quick', runJobs: engines([]) });
    const recs = res.records.filter((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.deepStrictEqual(recs.map((r) => r.verdict), ['confirmed']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a plan-only review keeps a changed finding instead of dropping it', () => withHome(async () => {
  const root = makeRepo();
  try {
    await firstReview(root);
    applyFix(root);
    const plan = await audit.runAudit({ root, profile: 'quick', planOnly: true });
    const pending = JSON.parse(fs.readFileSync(path.join(plan.dir, 'carried-pending.json'), 'utf8'));
    assert.ok(pending.some((r) => r.fingerprint === CANDIDATE.fingerprint));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

// ---------------------------------------------------------------- command + backend

async function fakeBackend({ auditor = FIXED_ANSWER, eventsStatus = 201 } = {}) {
  const log = [];
  const state = { eventsStatus };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      log.push(entry);
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/api/atris2/billing/quote') return json(200, { model: entry.query.model, credits: entry.query.model === 'atris:fast' ? 2 : 5 });
      if (url.pathname === '/api/atris2/turn') {
        const text = answerFor(entry.body.message, { auditor });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'result', result: text })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'receipt', receipt: { billing: { billed: true, credits_charged: 3 } } })}\n\n`);
        res.end();
        return;
      }
      if (url.pathname === '/api/sentinel/runs' && req.method === 'POST') return json(201, { id: 'run-uuid' });
      if (url.pathname === '/api/sentinel/events' && req.method === 'POST') return state.eventsStatus === 201 ? json(201, { saved: entry.body.events.length }) : json(state.eventsStatus, { detail: 'events are down' });
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { log, state, base: `http://127.0.0.1:${server.address().port}/api`, close: () => new Promise((r) => server.close(r)) };
}

async function withBackend(backend, fn) {
  return withHome(async (home) => {
    const prev = process.env.ATRIS_API_URL;
    process.env.ATRIS_API_URL = backend.base;
    const out = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    try { return await fn({ home, out, env: { HOME: home, PATH: '' } }); } finally {
      console.log = log;
      console.error = err;
      if (prev === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = prev;
    }
  });
}

test('atris sentinel recheck uploads status fixed and sends the fix as open then resolved, once', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withBackend(backend, async ({ out, env }) => {
      await firstReview(root);
      applyFix(root);
      const calls = [];
      const code = await auditCommand(['recheck', root, '--engine', 'local'], { token: 'tok', env, runJobs: engines(calls) });
      assert.strictEqual(code, 0, out.join('\n'));
      assert.strictEqual(auditorCalls(calls).length, 1);
      const text = out.join('\n');
      assert.ok(text.includes('re-checked 1 open finding from run-1'), text);
      assert.ok(text.includes('1 fixed'), text);
      assert.ok(text.includes('marked 1 finding fixed on your dashboard'), text);
      const uploads = backend.log.filter((e) => e.path === '/api/sentinel/runs');
      assert.strictEqual(uploads.length, 1);
      const body = uploads[0].body;
      assert.strictEqual(body.run_id, 'run-2');
      assert.deepStrictEqual(Object.keys(body.counts).sort(), ['confirmed', 'needs_validation', 'rejected', 'severity']);
      assert.strictEqual(body.counts.confirmed, 0);
      assert.deepStrictEqual(body.findings.map(({ id, ...f }) => f), [{ severity: 'high', title: CANDIDATE.title, location: 'lib/run.js:4', fix: CANDIDATE.remediation.summary, status: 'fixed' }]);
      assert.ok(!JSON.stringify(body).includes('execFileSync'), 'no code in the upload');
      const events = backend.log.filter((e) => e.path === '/api/sentinel/events');
      assert.strictEqual(events.length, 2, 'open first and resolved second, in two calls');
      const [opened, resolved] = events.map((e) => e.body.events);
      assert.strictEqual(opened.length, 1);
      assert.strictEqual(resolved.length, 1);
      for (const ev of [opened[0], resolved[0]]) {
        assert.strictEqual(ev.kind, 'threat');
        assert.strictEqual(ev.fingerprint, body.findings[0].id);
        assert.strictEqual(ev.severity, 'high');
        assert.strictEqual(ev.title, CANDIDATE.title);
        assert.ok(!JSON.stringify(ev).includes('execFileSync'));
      }
      assert.strictEqual(opened[0].status, 'open');
      assert.strictEqual(resolved[0].status, 'resolved');
      assert.ok(Date.parse(opened[0].occurred_at) <= Date.parse(resolved[0].occurred_at), 'the open copy is dated when the first review found it');
      // Uploading the same run again saves it. The fix is not counted twice.
      const up = await auditCommand(['upload'], { root, token: 'tok', env });
      assert.strictEqual(up, 0, out.join('\n'));
      assert.strictEqual(backend.log.filter((e) => e.path === '/api/sentinel/events').length, 2);
      assert.strictEqual(backend.log.filter((e) => e.path === '/api/sentinel/runs').length, 2);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed events call warns, keeps the saved review and a later upload sends the fix', async () => {
  const backend = await fakeBackend({ eventsStatus: 500 });
  const root = makeRepo();
  try {
    await withBackend(backend, async ({ out, env }) => {
      await firstReview(root);
      applyFix(root);
      const code = await auditCommand(['recheck', root, '--engine', 'local'], { token: 'tok', env, runJobs: engines([]) });
      assert.strictEqual(code, 0, out.join('\n'));
      assert.ok(out.join('\n').includes('could not mark the fixed findings on your dashboard'), out.join('\n'));
      assert.strictEqual(backend.log.filter((e) => e.path === '/api/sentinel/runs').length, 1);
      backend.state.eventsStatus = 201;
      const before = backend.log.filter((e) => e.path === '/api/sentinel/events').length;
      assert.strictEqual(await auditCommand(['upload'], { root, token: 'tok', env }), 0);
      const sent = backend.log.filter((e) => e.path === '/api/sentinel/events').slice(before).map((e) => e.body.events[0].status);
      assert.deepStrictEqual(sent, ['open', 'resolved']);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('recheck on atris models quotes first, respects the cap and sends only plain text', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withBackend(backend, async ({ out, env }) => {
      await firstReview(root);
      applyFix(root);
      let asked = 0;
      const no = await auditCommand(['recheck', root, '--engine', 'atris'], { token: 'tok', env, input: { isTTY: true }, ask: async () => { asked += 1; return false; } });
      assert.strictEqual(no, 1);
      assert.strictEqual(asked, 1);
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'), 'a no spends nothing');
      assert.ok(out.join('\n').includes('costs at most 5 credits'), out.join('\n'));
      assert.ok(out.join('\n').includes('1 check call on atris:pro'), out.join('\n'));

      const code = await auditCommand(['recheck', root, '--engine', 'atris', '--yes'], { token: 'tok', env });
      assert.strictEqual(code, 0, out.join('\n'));
      const turns = backend.log.filter((e) => e.path === '/api/atris2/turn');
      assert.strictEqual(turns.length, 1);
      assert.strictEqual(turns[0].body.model, 'atris:pro');
      assert.strictEqual(turns[0].body.max_output_tokens, 4096);
      assert.ok(turns[0].body.message.includes('## Source'), 'a hosted auditor gets the numbered source');
      assert.ok(turns[0].body.message.includes(`    4  ${FIXED_LINE}`));
      const at = backend.log.indexOf(turns[0]);
      assert.ok(backend.log.slice(0, at).some((e) => e.path === '/api/atris2/billing/quote' && e.query.model === 'atris:pro' && Number(e.query.input_tokens) >= Buffer.byteLength(turns[0].body.message)), 'the call is priced at its own size first');
      const body = backend.log.filter((e) => e.path === '/api/sentinel/runs').pop().body;
      assert.strictEqual(body.source, 'atris-models');
      assert.strictEqual(body.credits_used, 3);
      assert.deepStrictEqual(body.findings.map((f) => f.status), ['fixed']);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('recheck on atris models never starts a call that could pass the approved price', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withBackend(backend, async ({ out, env }) => {
      await firstReview(root);
      applyFix(root);
      // The run is approved at 5 credits; this one call is priced at 50.
      const code = await auditCommand(['recheck', root, '--engine', 'atris', '--yes', '--no-upload'], { token: 'tok', env, quoteCall: async () => 50 });
      assert.strictEqual(code, 1, out.join('\n'));
      assert.ok(!backend.log.some((e) => e.path === '/api/atris2/turn'));
      assert.ok(out.join('\n').includes('stopped at the approved limit of 5 credits'), out.join('\n'));
      const last = audit.latestRun(root);
      assert.strictEqual(last.records.find((r) => r.fingerprint === CANDIDATE.fingerprint).verdict, 'confirmed', 'no answer keeps it open');
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('recheck with no earlier review does nothing', async () => {
  const backend = await fakeBackend();
  const root = makeRepo();
  try {
    await withBackend(backend, async ({ out, env }) => {
      const code = await auditCommand(['recheck', root, '--engine', 'local'], { token: 'tok', env, runJobs: engines([]) });
      assert.strictEqual(code, 0);
      assert.ok(out.join('\n').includes('no earlier review of this project to re-check'));
      assert.strictEqual(backend.log.length, 0);
    });
  } finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
