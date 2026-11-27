'use strict';

// When a run has more leads than check calls, one call checks a few leads
// instead of leaving the rest unchecked. When the first quick wave leaves
// check calls idle, a second wave reads more areas with them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const { CONFIRM_CHECKS } = require('../lib/security-audit-classes');

const lead = (fp, file = 'lib/a.js', extra = {}) => ({ fingerprint: fp, proposed_verdict: 'confirmed', trace: [{ kind: 'sink', file, line: 1 }], ...extra });

test('each lead gets its own check while there is a call for it', () => {
  const leads = [lead('a'), lead('b'), lead('c')];
  const { groups, left } = audit.verifyGroups(leads, 4);
  assert.deepStrictEqual(groups.map((g) => g.map((l) => l.fingerprint)), [['a'], ['b'], ['c']]);
  assert.deepStrictEqual(left, []);
});

test('past the budget, leads share calls, same sink file together, every call used', () => {
  const leads = [lead('a1', 'lib/a.js'), lead('b1', 'lib/b.js'), lead('a2', 'lib/a.js'), lead('c1', 'lib/c.js'), lead('b2', 'lib/b.js'), lead('d1', 'lib/d.js')];
  const { groups, left } = audit.verifyGroups(leads, 4);
  assert.strictEqual(groups.length, 4);
  assert.deepStrictEqual(groups.map((g) => g.map((l) => l.fingerprint)), [['a1', 'a2'], ['b1', 'b2'], ['c1'], ['d1']]);
  assert.deepStrictEqual(left, []);
});

test('a call checks at most three leads; the lowest ranked wait', () => {
  const leads = 'abcdefgh'.split('').map((x) => lead(x));
  const { groups, left } = audit.verifyGroups(leads, 2);
  assert.ok(groups.every((g) => g.length <= audit.VERIFY_BATCH_MAX));
  assert.strictEqual(groups.flat().length, 6);
  assert.deepStrictEqual(left.map((l) => l.fingerprint), ['g', 'h']);
  assert.deepStrictEqual(audit.verifyGroups(leads, 0), { groups: [], left: leads });
});

test('a shared answer splits back per lead by fingerprint, and a skipped lead gets none', () => {
  const group = [lead('x'), lead('y'), lead('z')];
  const stdout = JSON.stringify({ results: [{ fingerprint: 'y', verdict: 'rejected' }, { fingerprint: 'x', verdict: 'confirmed' }] });
  const out = audit.splitGroupAnswer({ ok: true, stdout }, group);
  assert.strictEqual(JSON.parse(out[0].stdout).verdict, 'confirmed');
  assert.strictEqual(JSON.parse(out[1].stdout).verdict, 'rejected');
  assert.strictEqual(out[2], null);
  assert.deepStrictEqual(audit.splitGroupAnswer({ ok: false, stdout: '' }, group), [null, null, null]);
});

test('a miscopied fingerprint counts only when the answer is one result per lead, in order', () => {
  const group = [lead('x'), lead('y')];
  const ordered = audit.splitGroupAnswer({ ok: true, stdout: JSON.stringify({ results: [{ fingerprint: 'x!', verdict: 'confirmed' }, { fingerprint: 'y', verdict: 'rejected' }] }) }, group);
  assert.strictEqual(JSON.parse(ordered[0].stdout).verdict, 'confirmed');
  const short = audit.splitGroupAnswer({ ok: true, stdout: JSON.stringify({ results: [{ fingerprint: 'x!', verdict: 'confirmed' }] }) }, group);
  assert.deepStrictEqual(short, [null, null]);
});

test('a shared check prompt shows every lead, the guide for each class, and asks for one result each', () => {
  const { CLASS_BY_ID } = require('../lib/security-audit-classes');
  const p = audit.verifierPrompt({ candidates: [lead('lib/a.js:f/one'), lead('lib/b.js:g/two')], classes: [CLASS_BY_ID.get('command-injection'), CLASS_BY_ID.get('path-traversal')] });
  assert.match(p, /## Candidate 1 of 2/);
  assert.match(p, /## Candidate 2 of 2/);
  assert.match(p, /exactly 2 entries in "results"/);
  assert.ok(p.includes(`## Attack class: ${CLASS_BY_ID.get('path-traversal').title}`));
  for (const c of CONFIRM_CHECKS) assert.ok(p.includes(`${c.key} [${c.pass}]`));
  const single = audit.verifierPrompt({ candidate: lead('lib/a.js:f/one'), cls: CLASS_BY_ID.get('command-injection') });
  assert.match(single, /## Candidate\n/);
  assert.doesNotMatch(single, /"results"/);
});

function repo(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-batch-'));
  for (let i = 0; i < n; i++) {
    fs.mkdirSync(path.join(root, `svc${i}`));
    fs.writeFileSync(path.join(root, `svc${i}`, 'run.js'), [
      "const { execSync } = require('child_process');",
      `function runJob${i}(task) {`,
      '  const title = task.title;',
      '  return execSync(`echo ${title}`);',
      '}',
      `module.exports = { runJob${i} };`,
      '',
    ].join('\n'));
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-home-'));
  const prev = process.env.ATRIS_SECURITY_AUDIT_HOME;
  process.env.ATRIS_SECURITY_AUDIT_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
    else process.env.ATRIS_SECURITY_AUDIT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

const PASS = Object.fromEntries(CONFIRM_CHECKS.map((c) => [c.key, c.pass]));

// Hunters report one lead per area they read; the verifier confirms every
// lead it is shown, alone or several to a call.
function engines(calls, { leadsPerArea = 1 } = {}) {
  return async (jobs) => jobs.map((job) => {
    calls.push(job);
    const p = job.prompt;
    if (p.includes('security hunter')) {
      const ids = [...p.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
      const files = [...new Set([...p.matchAll(/svc\d+\/run\.js/g)].map((m) => m[0]))];
      const candidates = files.flatMap((file) => Array.from({ length: leadsPerArea }, (_, k) => ({
        proposed_verdict: 'confirmed',
        fingerprint: `${file}:run${k}/shell-from-title`,
        title: 'A task title runs as shell code',
        description: 'd',
        attack_class: 'command-injection',
        attacker: 'anyone who can create a task',
        root_cause: 'the title is put in a shell string',
        intended_behavior: 'the title is an argument',
        impact: 'code execution',
        trace: [{ kind: 'entrypoint', file, line: 2, description: 'task' }, { kind: 'sink', file, line: 4, description: 'execSync' }],
        conditions: [{ kind: 'authorization_role', description: 'can create a task' }],
        severity: { likelihood: { score: 'medium', reason: 'r' }, impact: { score: 'high', reason: 'r' }, overall: 'high' },
        remediation: { strategy: 'use execFileSync', summary: 'Pass the title as an argument', regression_test: 't' },
        coverage_ids: ids,
      })));
      return { ok: true, stdout: JSON.stringify({ units: ids.map((id) => ({ coverage_id: id, disposition: candidates.length ? 'candidate' : 'covered', reviewed_paths: files.length ? files : ['svc0/run.js'], checks: [{ invariant: 'i', method: 'source', result: 'r', reviewed_paths: files.length ? files : ['svc0/run.js'] }], candidate_fingerprints: candidates.map((c) => c.fingerprint), unresolved: [] })), candidates, hardening: [], uncovered: [] }) };
    }
    if (p.includes('independent security verifier')) {
      const one = { verdict: 'confirmed', reason: 'line 4 puts the title in a shell string', checks: PASS };
      if (!p.includes('"results"')) return { ok: true, stdout: JSON.stringify(one) };
      const fps = [...p.matchAll(/"fingerprint": "([^"]+)"/g)].map((m) => m[1]).filter((f) => f.includes('shell-from-title'));
      return { ok: true, stdout: JSON.stringify({ results: [...new Set(fps)].map((fingerprint) => ({ fingerprint, ...one })) }) };
    }
    return { ok: false, reason: 'unexpected prompt', stdout: '' };
  });
}

const kindOf = (job) => (job.prompt.includes('security hunter') ? 'hunter' : job.prompt.includes('independent security verifier') ? 'verifier' : 'other');

test('more leads than check calls: every call is used and no lead is left unchecked', () => withHome(async () => {
  const root = repo(3);
  try {
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'quick', budget: 4, runJobs: engines(calls, { leadsPerArea: 3 }) });
    const verifierCalls = calls.filter((j) => kindOf(j) === 'verifier').length;
    const confirmed = res.records.filter((r) => r.verdict === 'confirmed').length;
    assert.ok(res.meta.invocations.used <= 4, JSON.stringify(res.meta.invocations));
    assert.ok(confirmed > verifierCalls, `${confirmed} confirmed in ${verifierCalls} calls`);
    assert.deepStrictEqual(res.meta.unchecked, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a quick run whose first wave finds nothing spends spare calls reading more areas', () => withHome(async () => {
  const root = repo(30);
  try {
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'quick', budget: 8, runJobs: engines(calls, { leadsPerArea: 0 }) });
    const plan = audit.budgetPlan('quick', 8);
    const hunters = calls.filter((j) => kindOf(j) === 'hunter').length;
    assert.ok(hunters > plan.hunters, `${hunters} hunter calls`);
    assert.ok(res.meta.invocations.used <= 8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('areas whose hunter call failed go first in the extra quick wave', () => withHome(async () => {
  const root = repo(30);
  try {
    const calls = [];
    const inner = engines(calls, { leadsPerArea: 0 });
    let failedOnce = null;
    const runJobs = async (jobs) => (await inner(jobs)).map((a, i) => {
      if (failedOnce === null && kindOf(jobs[i]) === 'hunter') {
        failedOnce = [...jobs[i].prompt.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
        return { ok: false, reason: 'exit_1', stdout: '' };
      }
      return a;
    });
    const res = await audit.runAudit({ root, profile: 'quick', budget: 8, runJobs });
    assert.ok(failedOnce && failedOnce.length);
    const byId = new Map(res.ledger.map((u) => [u.coverage_id, u]));
    for (const id of failedOnce) assert.strictEqual(byId.get(id).status, 'covered', id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

// A hunter call that fails in the engine read nothing. It gets one more try
// at once, and the failed call's last error line is kept so the cause shows.
test('a hunter call that fails in the engine is retried once, right away', () => withHome(async () => {
  const root = repo(3);
  try {
    const calls = [];
    const inner = engines(calls, { leadsPerArea: 0 });
    let failed = 0;
    const runJobs = async (jobs) => (await inner(jobs)).map((a, i) => {
      if (failed === 0 && kindOf(jobs[i]) === 'hunter') {
        failed += 1;
        return { ok: false, reason: 'exit_1', stdout: '', stderr: 'reading prompt\nERROR: stream disconnected before completion: rate limit reached for sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n' };
      }
      return a;
    });
    const logs = [];
    const res = await audit.runAudit({ root, profile: 'quick', budget: 8, runJobs, log: (l) => logs.push(l) });
    assert.ok(logs.some((l) => /retrying 1 hunter call that failed \(exit_1\)/.test(l)), logs.join('\n'));
    assert.ok(calls.some((j) => / h1-\d+r$/.test(j.label)));
    assert.strictEqual(res.meta.run_status, 'complete');
    assert.deepStrictEqual(res.meta.unread_areas, []);
    assert.ok(res.meta.invocations.used <= 8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

// Audit item: a run whose reading tool failed must never look clean, even
// when other parts were read, or carried over from an earlier run.
test('areas the reading tool never read make the run incomplete and are listed by name', () => withHome(async () => {
  const root = repo(3);
  try {
    await audit.runAudit({ root, profile: 'quick', budget: 8, runJobs: engines([], { leadsPerArea: 0 }) });
    fs.appendFileSync(path.join(root, 'svc0', 'run.js'), '// changed\n');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'change'], { cwd: root });
    const runJobs = async (jobs) => jobs.map((job) => (kindOf(job) === 'hunter' ? { ok: false, reason: 'exit_1', stdout: '', stderr: 'Error: quota exceeded\n' } : { ok: false, reason: 'unexpected', stdout: '' }));
    const res = await audit.runAudit({ root, profile: 'quick', budget: 8, runJobs });
    assert.strictEqual(res.meta.run_status, 'incomplete');
    assert.strictEqual(res.meta.incomplete_reason, 'areas_not_read');
    assert.strictEqual(res.meta.coverage_clean, false);
    assert.ok(res.meta.unread_areas.length > 0);
    assert.ok(res.meta.unread_areas.every((u) => /hunter codex failed: exit_1 \(Error: quota exceeded\)/.test(u.why)), JSON.stringify(res.meta.unread_areas));
    assert.ok(res.meta.unread_areas.some((u) => u.paths.some((p) => p.startsWith('svc0'))));
    const report = fs.readFileSync(path.join(res.dir, 'REPORT.md'), 'utf8');
    assert.match(report, /This run is incomplete: areas not read/);
    assert.match(report, /## Not read\n\nThe reading tool failed on these areas/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a long id or key in an engine error is cut out of the reason', () => {
  const tail = audit.engineErrorTail({ stderr: 'ok\nError: bad key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n' });
  assert.match(tail, /Error: bad key/);
  assert.doesNotMatch(tail, /abcdefghijklmnop/);
  assert.strictEqual(audit.engineErrorTail({ stderr: '' }), '');
});

// Audit item: on a training app the code execution lead was left unchecked
// while weaker leads were checked. Code execution and takeover go first.
test('code execution and account takeover leads are checked first', () => {
  const lead = (fingerprint, extra) => ({ fingerprint, proposed_verdict: 'confirmed', severity: { overall: 'high' }, attack_class: 'access-control', title: 'A user reads another user\'s list', ...extra });
  const leads = [
    lead('a/x.js:f/read-other'),
    lead('b/y.js:g/eval-body', { attack_class: 'code-injection', title: 'Request body is evaluated', severity: { overall: 'medium' }, proposed_verdict: 'needs_validation' }),
    lead('c/z.js:h/reset-link', { title: 'Anyone can take over an account through the reset link', severity: { overall: 'medium' } }),
    lead('d/w.js:i/note', { severity: { overall: 'critical' } }),
  ];
  assert.deepStrictEqual(leads.slice().sort(audit.verifyOrder).map((l) => l.fingerprint), ['c/z.js:h/reset-link', 'b/y.js:g/eval-body', 'd/w.js:i/note', 'a/x.js:f/read-other']);
  assert.ok(audit.graveLead({ title: 'An authenticated user can execute JavaScript on the server' }));
  assert.ok(!audit.graveLead({ title: 'A user can run a report for another team' }));
});

// The reading tool's own safety check refused the request. Asking it again
// is often refused again, so the one retry goes to the checking tool.
test('a hunter call the engine refuses is retried on the other local engine', () => withHome(async () => {
  const root = repo(3);
  try {
    const calls = [];
    const inner = engines(calls, { leadsPerArea: 0 });
    let refused = 0;
    const runJobs = async (jobs) => (await inner(jobs)).map((a, i) => {
      if (kindOf(jobs[i]) === 'hunter' && jobs[i].engine === 'codex' && refused === 0) {
        refused += 1;
        return { ok: false, reason: 'exit_1', stdout: '', stderr: '47,566\nERROR: This content was flagged for possible cybersecurity risk.\n' };
      }
      return a;
    });
    const res = await audit.runAudit({ root, profile: 'quick', budget: 8, hunter: 'codex', verifier: 'claude', runJobs });
    const retried = calls.filter((j) => / h1-\d+r$/.test(j.label));
    assert.strictEqual(retried.length, 1);
    assert.strictEqual(retried[0].engine, 'claude');
    assert.deepStrictEqual(res.meta.unread_areas, []);
    assert.match(audit.engineErrorTail({ stderr: '47,566\nERROR: This content was flagged for possible cybersecurity risk.\n' }), /flagged for possible cybersecurity risk/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));
