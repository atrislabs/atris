'use strict';

// The confirm gate: a lead that holds in source is confirmed only when an
// outside attacker gains something from it. The four shapes below each came
// from a false "confirmed" on real outside code, and each must land as a
// hardening note, never dropped. Plus the header-trust scanner.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const { CONFIRM_CHECKS, CLASS_BY_ID } = require('../lib/security-audit-classes');
const { scanHeaderTrust } = require('../lib/security-audit-headers');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

const FILES = {
  'lib/pay.js': 'exports.charge = (payin) => cards.charge(payin.card);\nexports.page = (req) => charge(req.payin);\n',
  'internal/integrationtests/run.go': 'package integrationtests\nfunc Run() { log.Printf("%+v", login) }\n',
};

function cand(extra = {}) {
  return {
    fingerprint: 'lib/pay.js:page/charge-on-get',
    title: 'A read-only session can finish a payment',
    description: 'd',
    attack_class: 'access-control',
    attacker: 'a stale session',
    root_cause: 'the page charges on GET',
    intended_behavior: 'charges need a full session',
    impact: 'the payment the user started completes',
    trace: [{ kind: 'entrypoint', file: 'lib/pay.js', line: 2, description: 'page' }, { kind: 'sink', file: 'lib/pay.js', line: 1, description: 'charge' }],
    conditions: [],
    severity: { likelihood: { score: 'low', reason: 'r' }, impact: { score: 'medium', reason: 'r' }, overall: 'medium' },
    remediation: { strategy: 'check write permission', summary: 'Ask for a full session before charging', regression_test: 't' },
    found_by: { engine: 'codex', agent_id: 'h-01' },
    ...extra,
  };
}

const by = { engine: 'claude', agent_id: 'v-01' };
const PASS = Object.fromEntries(CONFIRM_CHECKS.map((c) => [c.key, c.pass]));
const answer = (o) => ({ ok: true, stdout: JSON.stringify({ reason: 'read it', ...o }) });
// A line of lib/pay.js that a dismissal can point at.
const ON_PAY = [{ file: 'lib/pay.js', line: 1, quote: 'exports.charge = (payin) => cards.charge(payin.card);' }];
const evidence = (...keys) => Object.fromEntries(keys.map((k) => [k, ON_PAY]));

// Hunters still propose these shapes. Telling hunters to drop them made a
// hunter skip a real access hole on the bench, and a lead the hunter drops
// leaves no trail. Only the verifier, with the checks, turns one into a note.
test('the checks belong to the verifier, not the hunters', () => {
  const { CANDIDATE_GATE } = require('../lib/security-audit-classes');
  assert.deepStrictEqual(CONFIRM_CHECKS.map((c) => c.key), ['attacker_gain', 'shipped_code', 'deliberate_setting', 'hygiene_only', 'insider_only']);
  assert.ok(!CANDIDATE_GATE.some((l) => /insider access/.test(l) || /deliberate setting/.test(l)));
});

test('a confirmed lead whose checks all pass stays confirmed', () => {
  const root = repo(FILES);
  try {
    const rec = audit.decide(root, cand(), answer({ verdict: 'confirmed', checks: PASS }), by);
    assert.strictEqual(rec.verdict, 'confirmed');
    assert.ok(!audit.isNote(rec));
    // An older answer with no checks is judged as before.
    assert.strictEqual(audit.decide(root, cand(), answer({ verdict: 'confirmed' }), by).verdict, 'confirmed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('each failed check turns a confirm into a kept note that names it', () => {
  const root = repo(FILES);
  try {
    for (const c of CONFIRM_CHECKS) {
      const checks = { ...PASS, [c.key]: c.pass === 'yes' ? 'no' : 'yes' };
      const rec = audit.decide(root, cand(), answer({ verdict: 'confirmed', checks, dismissal_evidence: evidence(c.key), note: 'Charges on a GET request' }), by);
      assert.strictEqual(rec.verdict, 'rejected', c.key);
      assert.ok(audit.isNote(rec), c.key);
      assert.deepStrictEqual(rec.failed_checks, [c.key]);
      assert.match(rec.note, new RegExp(c.note));
      assert.match(rec.note, /lib\/pay\.js:1/);
      assert.strictEqual(rec.severity, undefined);
      assert.deepStrictEqual(audit.validateFindings([rec], { root }), []);
    }
    // Booleans count as answers too.
    assert.ok(audit.isNote(audit.decide(root, cand(), answer({ verdict: 'confirmed', checks: { ...PASS, insider_only: true }, dismissal_evidence: evidence('insider_only') }), by)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the note verdict and a needs_validation lead that needs insider access are both notes', () => {
  const root = repo(FILES);
  try {
    assert.ok(audit.isNote(audit.decide(root, cand(), answer({ verdict: 'note', note: 'documented setting' }), by)));
    const nv = audit.decide(root, cand(), answer({ verdict: 'needs_validation', checks: { ...PASS, insider_only: 'yes' }, dismissal_evidence: evidence('insider_only'), blockers: ['log level'], validation_plan: [{ context: 'deployment', step: 's' }] }), by);
    assert.ok(audit.isNote(nv));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A spotted hole is waved off only on a live line of this repo. A claim in
// a README or a comment ("this is a training app", "intentional") describes
// the hole; it does not stop it.
test('a failed check with no line of code to show it is ignored and the lead stays confirmed', () => {
  const root = repo({
    ...FILES,
    'README.md': 'This is a deliberately insecure training app.\n',
    'docs/security.md': 'Operators choose to trust every caller.\n',
    'lib/pay.js': 'exports.charge = (payin) => cards.charge(payin.card);\n// intentional: charging on GET is by design\nexports.page = (req) => charge(req.payin);\n',
  });
  try {
    for (const key of ['attacker_gain', 'deliberate_setting', 'hygiene_only', 'insider_only']) {
      const c = CONFIRM_CHECKS.find((x) => x.key === key);
      const checks = { ...PASS, [key]: c.pass === 'yes' ? 'no' : 'yes' };
      const none = audit.decide(root, cand(), answer({ verdict: 'note', checks, note: 'n' }), by);
      assert.strictEqual(none.verdict, 'confirmed', `${key} with no evidence`);
      assert.match(none.verified_by[0].reason, new RegExp(`Waved off on ${key}`));
      const comment = audit.decide(root, cand(), answer({ verdict: 'note', checks, dismissal_evidence: { [key]: [{ file: 'lib/pay.js', line: 2, quote: 'intentional: charging on GET is by design' }] } }), by);
      assert.strictEqual(comment.verdict, 'confirmed', `${key} on a comment`);
      const wrongQuote = audit.decide(root, cand(), answer({ verdict: 'note', checks, dismissal_evidence: { [key]: [{ file: 'lib/pay.js', line: 1, quote: 'requireAdmin(req.user)' }] } }), by);
      assert.strictEqual(wrongQuote.verdict, 'confirmed', `${key} quoting a line that is not there`);
      const missing = audit.decide(root, cand(), answer({ verdict: 'note', checks, dismissal_evidence: { [key]: [{ file: 'lib/nope.js', line: 1, quote: 'exports.charge = (payin)' }] } }), by);
      assert.strictEqual(missing.verdict, 'confirmed', `${key} on a missing file`);
    }
    for (const key of ['attacker_gain', 'deliberate_setting', 'hygiene_only']) {
      const c = CONFIRM_CHECKS.find((x) => x.key === key);
      const checks = { ...PASS, [key]: c.pass === 'yes' ? 'no' : 'yes' };
      for (const doc of [{ file: 'README.md', line: 1, quote: 'deliberately insecure training app' }, { file: 'docs/security.md', line: 1, quote: 'Operators choose to trust every caller' }]) {
        assert.strictEqual(audit.decide(root, cand(), answer({ verdict: 'note', checks, dismissal_evidence: { [key]: [doc] } }), by).verdict, 'confirmed', `${key} on ${doc.file}`);
      }
    }
    // A line near the cited one, with spacing that differs, still counts.
    const near = audit.decide(root, cand(), answer({ verdict: 'note', checks: { ...PASS, insider_only: 'yes' }, dismissal_evidence: { insider_only: [{ file: './lib/pay.js', line: 2, quote: 'exports.page = (req)  =>  charge(req.payin);' }] } }), by);
    assert.ok(audit.isNote(near));
    // shipped_code is settled by the path, so it needs no line.
    assert.ok(audit.isNote(audit.decide(root, cand(), answer({ verdict: 'confirmed', checks: { ...PASS, shipped_code: 'no' } }), by)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Published advisories count a hole behind another user's random id, or
// behind a request captured from them, as a hole. It is kept, confirmed one
// step lower, with the condition in plain words.
test('a hole behind a random id or a captured request is confirmed lower, not dropped', () => {
  const root = repo(FILES);
  try {
    const sev = (overall, impact = overall) => ({ likelihood: { score: 'medium', reason: 'r' }, impact: { score: impact, reason: 'r' }, overall });
    for (const [from, to] of [['critical', 'medium'], ['high', 'medium'], ['medium', 'low'], ['low', 'low'], ['informational', 'informational']]) {
      const rec = audit.decide(root, cand({ severity: sev(from) }), answer({ verdict: 'note', checks: { ...PASS, insider_only: 'yes' }, dismissal_evidence: evidence('insider_only'), secret_barrier: 'random_id' }), by);
      assert.strictEqual(rec.verdict, 'confirmed', from);
      assert.strictEqual(rec.severity.overall, to, from);
      assert.strictEqual(rec.severity.likelihood.score, 'low');
      assert.ok(rec.conditions.some((c) => /another user's id, which is random but can leak through links or logs/.test(c.description)));
      assert.deepStrictEqual(audit.validateFindings([rec], { root }), []);
    }
    const replay = audit.decide(root, cand({ severity: sev('high') }), answer({ verdict: 'confirmed', checks: PASS, secret_barrier: 'captured request' }), by);
    assert.strictEqual(replay.severity.overall, 'medium');
    assert.ok(replay.conditions.some((c) => /captured from another user/.test(c.description)));
    // Lowering twice (a re-check) keeps one condition and one step.
    const again = audit.lowerForBarrier(replay, 'captured_request');
    assert.strictEqual(again.severity.overall, 'medium');
    assert.strictEqual(again.conditions.filter((c) => /captured from another user/.test(c.description)).length, 1);
    // Real insider access, with no leaked-value barrier, is still a note.
    assert.ok(audit.isNote(audit.decide(root, cand(), answer({ verdict: 'note', checks: { ...PASS, insider_only: 'yes' }, dismissal_evidence: evidence('insider_only'), secret_barrier: 'none' }), by)));
    // A barrier never lets another failed check through.
    assert.ok(audit.isNote(audit.decide(root, cand(), answer({ verdict: 'note', checks: { ...PASS, attacker_gain: 'no' }, dismissal_evidence: evidence('attacker_gain'), secret_barrier: 'random_id' }), by)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the verifier is told a claim of intent is not a control, and to quote the line behind a dismissal', () => {
  const p = audit.verifierPrompt({ candidate: cand(), cls: CLASS_BY_ID.get('access-control') });
  assert.match(p, /dismissal_evidence/);
  assert.match(p, /training or demo app/);
  assert.match(p, /not a control that stops it/);
  const { CANDIDATE_GATE } = require('../lib/security-audit-classes');
  assert.ok(CANDIDATE_GATE.some((l) => /signature checks turned off/.test(l)));
  assert.ok(CANDIDATE_GATE.some((l) => /admin, metrics, health, debug or support listener/.test(l)));
});

test('a path that starts in integration test code is a note even when every check passes', () => {
  const root = repo(FILES);
  try {
    const trace = [{ kind: 'entrypoint', file: 'internal/integrationtests/run.go', line: 2, description: 'logs the login' }, { kind: 'sink', file: 'lib/pay.js', line: 1, description: 'x' }];
    const rec = audit.decide(root, cand({ trace }), answer({ verdict: 'confirmed', checks: PASS }), by);
    assert.ok(audit.isNote(rec));
    assert.deepStrictEqual(rec.failed_checks, ['shipped_code']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('test path covers integration tests, test helpers, fixtures and mocks but not product code', () => {
  for (const p of ['internal/integrationtests/x.go', 'cmd/integration_tests.go', 'internal/testutils/a.go', 'pkg/tenant/fixtures.go', 'pkg/auth/mocks.go', 'tests/test_api.py', 'app/test_views.py']) assert.ok(audit.TEST_PATH.test(p), p);
  for (const p of ['internal/serve/middleware/api_keys_middleware.go', 'lib/testimonials.js', 'src/contest.js', 'app/views.py', 'internal/integrations/github.go']) assert.ok(!audit.TEST_PATH.test(p), p);
});

test('header scanner seeds an address check on a forwarded header and stays quiet on logging', () => {
  const allowlist = [
    'func clientIP(r *http.Request) string {',
    '  for _, h := range []string{"X-Forwarded-For", "X-Real-IP"} {',
    '    if v := r.Header.Get(h); v != "" { return v }',
    '  }',
    '  return r.RemoteAddr',
    '}',
    'if !key.IsAllowedIP(clientIP(r)) { deny() }',
  ].join('\n');
  assert.deepStrictEqual(scanHeaderTrust(allowlist).map((h) => h.line), [2]);
  const office = "const OFFICE_IPS = ['203.0.113.10'];\nconst ip = req.headers['x-forwarded-for'];\nif (!OFFICE_IPS.includes(ip)) deny();\n";
  assert.deepStrictEqual(scanHeaderTrust(office).map((h) => h.line), [2]);
  assert.deepStrictEqual(scanHeaderTrust("const f = req.headers['x-forwarded-for'];\nconsole.log({ f });\n"), []);
  assert.deepStrictEqual(scanHeaderTrust("const key = req.headers['x-real-ip'] || req.socket.remoteAddress;\nhits.set(key, n);\n"), []);
  assert.deepStrictEqual(scanHeaderTrust("app.set('trust proxy', 'loopback');\nif (!allowList.includes(req.ip)) deny();\n"), []);
  assert.strictEqual(scanHeaderTrust("app.set('trust proxy', true);\nif (!allowList.includes(req.ip)) deny();\n").length, 1);
});

test('header scanner seeds path override headers and reset links built from the host', () => {
  assert.strictEqual(scanHeaderTrust('String o = req.getHeader("X-Original-URL");').length, 1);
  const reset = "def forgot_password(request):\n    token = make_token(email)\n    link = 'https://' + request.get_host() + '/reset/' + token\n    send_mail('Reset', link)\n";
  assert.strictEqual(scanHeaderTrust(reset).length, 1);
  assert.deepStrictEqual(scanHeaderTrust("def asset_url(request, name):\n    return 'https://' + request.get_host() + '/static/' + name\n"), []);
  assert.deepStrictEqual(scanHeaderTrust("request.hostname = ''\n"), []);
});

test('a full run lists a note with the hardening notes, not as confirmed or disproved', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-gate-home-'));
  const prev = process.env.ATRIS_SECURITY_AUDIT_HOME;
  process.env.ATRIS_SECURITY_AUDIT_HOME = home;
  const root = repo({ 'lib/run.js': "const { execSync } = require('child_process');\nfunction runTask(task) {\n  return execSync(`echo ${task.title}`);\n}\nmodule.exports = { runTask };\n" });
  const c = {
    ...cand(),
    fingerprint: 'lib/run.js:runTask/shell-from-title',
    title: 'Task title runs as shell code',
    attack_class: 'command-injection',
    trace: [{ kind: 'entrypoint', file: 'lib/run.js', line: 2, description: 'task' }, { kind: 'sink', file: 'lib/run.js', line: 3, description: 'shell' }],
    proposed_verdict: 'confirmed',
  };
  delete c.found_by;
  const verifierPrompts = [];
  const runJobs = async (jobs) => jobs.map((job) => {
    const p = job.prompt;
    if (p.includes('security hunter')) {
      const ids = [...p.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
      const mine = p.includes('starting paths: lib/run.js') && p.includes('command-injection');
      return { ok: true, stdout: JSON.stringify({ units: ids.map((id) => ({ coverage_id: id, disposition: mine ? 'candidate' : 'covered', reviewed_paths: ['lib/run.js'], checks: [{ invariant: 'i', method: 'source', result: 'r', reviewed_paths: ['lib/run.js'] }], candidate_fingerprints: mine ? [c.fingerprint] : [], unresolved: [] })), candidates: mine ? [{ ...c, coverage_ids: ids }] : [], hardening: [], uncovered: [] }) };
    }
    if (p.includes('independent security verifier')) verifierPrompts.push(p);
    if (p.includes('independent security verifier')) return answer({ verdict: 'note', checks: { ...PASS, insider_only: 'yes' }, dismissal_evidence: { insider_only: [{ file: 'lib/run.js', line: 3, quote: 'return execSync(`echo ${task.title}`);' }] }, note: 'Only the person who runs the tool picks the title' });
    if (p.includes('coverage critic')) return { ok: true, stdout: JSON.stringify({ missing_units: [], reassign_ids: [], stop: true }) };
    return { ok: false, reason: 'unexpected', stdout: '' };
  });
  try {
    const res = await audit.runAudit({ root, profile: 'quick', hunter: 'codex', verifier: 'claude', runJobs });
    assert.strictEqual(verifierPrompts.length, 1);
    assert.match(verifierPrompts[0], /## Before you confirm/);
    for (const k of CONFIRM_CHECKS) assert.ok(verifierPrompts[0].includes(`${k.key} [${k.pass}]`), k.key);
    assert.match(verifierPrompts[0], /confirmed\|needs_validation\|note\|rejected/);
    assert.strictEqual(res.meta.counts.confirmed, 0);
    assert.strictEqual(res.meta.counts.rejected, 0);
    assert.strictEqual(res.meta.counts.notes, 1);
    const report = fs.readFileSync(path.join(res.dir, 'REPORT.md'), 'utf8');
    assert.match(report, /1 lead kept as hardening notes\. 0 disproved/);
    const hardening = report.split('## Hardening notes (not findings)')[1].split('## Coverage')[0];
    assert.match(hardening, /Only the person who runs the tool picks the title \(lib\/run\.js:3; not a finding: needs insider access first\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
    else process.env.ATRIS_SECURITY_AUDIT_HOME = prev;
  }
});

test('quick mode reads the header allowlist first, ahead of other classes', () => {
  const root = repo({
    'internal/serve/middleware/api_keys_middleware.go': 'package middleware\nfunc clientIP(r *http.Request) string {\n  if v := r.Header.Get("X-Forwarded-For"); v != "" { return v }\n  return r.RemoteAddr\n}\nfunc check(k APIKey, r *http.Request) bool { return k.IsAllowedIP(clientIP(r)) }\n',
    'lib/run.js': "const { execSync } = require('child_process');\nexports.run = (n) => execSync(`make ${n}`);\n",
    'lib/report.js': "exports.q = (c) => pool.query(\"SELECT * FROM t WHERE c = '\" + c + \"'\");\n",
    'lib/fetch.js': 'exports.get = (u) => fetch(u);\n',
    'lib/view.js': 'exports.show = (el, h) => { el.innerHTML = h; };\n',
  });
  try {
    const { units } = audit.mapTarget(root, { profile: 'quick' });
    const wave = audit.firstWave(units, 'quick');
    assert.ok(CLASS_BY_ID.has('header-trust'));
    assert.strictEqual(wave[0].attack_class, 'header-trust');
    assert.deepStrictEqual(wave[0].starting_paths, ['internal/serve/middleware/api_keys_middleware.go']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A developer tool run in the operator's own project folder: a settings file
// or symlink committed there is the operator's own, so a hole that needs only
// that is insider access. Tools that handle strangers' folders, and files that
// arrive from outside, stay findings. Only the verifier makes this call.
test('the project folder a developer tool runs in counts as the operator\'s own, with plain exceptions', () => {
  const { CANDIDATE_GATE } = require('../lib/security-audit-classes');
  const ask = CONFIRM_CHECKS.find((c) => c.key === 'insider_only').ask;
  assert.match(ask, /project folder the operator runs a command-line or developer tool in/);
  assert.match(ask, /code reviewer, a scanner, a bot or CI on outside pull requests/);
  assert.match(ask, /arrives from outside/);
  assert.ok(!CANDIDATE_GATE.some((l) => /project folder/.test(l)));
});
