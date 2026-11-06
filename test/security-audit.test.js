'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');

// A tiny target with one real hole: a task title reaches a shell.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-target-'));
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
  fs.writeFileSync(path.join(root, 'lib', 'files.js'), [
    "const fs = require('fs');",
    'function save(name, body) {',
    '  fs.writeFileSync(name, body);',
    '}',
    'module.exports = { save };',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'run.test.js'), "require('child_process').execSync('ls');\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
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

function idsIn(prompt) {
  return [...prompt.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
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
  severity: { likelihood: { score: 'medium', reason: 'tasks come from other people' }, impact: { score: 'high', reason: 'code execution' }, overall: 'critical' },
  remediation: { strategy: 'use execFileSync with an argv array', regression_test: 'a title with $(touch x) creates no file' },
};

// Fake engines: hunters answer per unit, the verifier confirms, the critic
// finds nothing, the recheck agrees.
function fakeEngines(calls, { hallucinate = false, verdict = 'confirmed' } = {}) {
  return async (jobs) => jobs.map((job) => {
    calls.push(job);
    const p = job.prompt;
    if (p.includes('security hunter')) {
      const ids = idsIn(p);
      const isRun = p.includes('starting paths: lib/run.js') && p.includes('command-injection');
      const cand = hallucinate ? { ...CANDIDATE, trace: [{ kind: 'sink', file: 'lib/nope.js', line: 9, description: 'made up' }] } : CANDIDATE;
      return {
        ok: true,
        stdout: `here you go\n\`\`\`json\n${JSON.stringify({
          units: ids.map((id) => ({
            coverage_id: id,
            disposition: isRun ? 'candidate' : 'covered',
            reviewed_paths: [isRun ? 'lib/run.js' : 'lib/files.js'],
            checks: [{ invariant: 'input never becomes shell text', method: 'source', result: isRun ? 'title reaches execSync' : 'only the local user picks the name', reviewed_paths: [isRun ? 'lib/run.js' : 'lib/files.js'] }],
            candidate_fingerprints: isRun ? [CANDIDATE.fingerprint] : [],
            unresolved: [],
          })),
          candidates: isRun ? [{ ...cand, coverage_ids: ids }] : [],
          hardening: [],
          uncovered: [],
        })}\n\`\`\``,
      };
    }
    if (p.includes('independent security verifier')) {
      return { ok: true, stdout: JSON.stringify({ verdict, reason: 'line 4 interpolates the title into a shell string', preventing_layer: null, corrected: { severity: CANDIDATE.severity }, blockers: ['who can create tasks is set in deployment'], validation_plan: [{ context: 'deployment', step: 'check who can create tasks' }] }) };
    }
    if (p.includes('coverage critic')) return { ok: true, stdout: JSON.stringify({ missing_units: [], reassign_ids: [], stop: true }) };
    if (p.includes('final record checker')) return { ok: true, stdout: '{"ok": true}' };
    return { ok: false, reason: 'unexpected prompt', stdout: '' };
  });
}

test('coverage ids are lossless and stable', () => {
  const a = audit.coverageId({ surface: 'lib/a b.js', boundary: 'x', subsystem: 'lib', attack_class: 'classes#c' });
  assert.strictEqual(a, 'lib%2Fa%20b.js::x::lib::classes%23c');
  assert.notStrictEqual(a, audit.coverageId({ surface: 'lib/a_b.js', boundary: 'x', subsystem: 'lib', attack_class: 'classes#c' }));
  assert.throws(() => audit.encodeRef(' padded'));
});

test('map seeds units from source, skips tests, and validates', () => {
  const root = makeRepo();
  try {
    const { units } = audit.mapTarget(root, { profile: 'standard' });
    const pairs = units.map((u) => `${u.starting_paths[0]} ${u.attack_class}`);
    assert.ok(pairs.includes('lib/run.js command-injection'));
    assert.ok(pairs.includes('lib/files.js path-traversal'));
    assert.ok(!pairs.some((p) => p.startsWith('test/')));
    assert.deepStrictEqual(audit.validateLedger(units), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('map sees Ruby and Go entry points, crypto, and gem manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-polyglot-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'invoices_controller.rb'), [
      'class InvoicesController < ApplicationController',
      '  skip_before_action :authenticate_user!',
      '  def show',
      '    @invoice = Invoice.where("account_id = #{params[:account]}").first',
      '  end',
      'end',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'app', 'cipher.rb'), [
      'def decrypt(data, key)',
      '  c = OpenSSL::Cipher.new("aes-128-cfb")',
      '  c.decrypt',
      'end',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'main.go'), [
      'package main',
      'func main() {',
      '  http.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {',
      '    exec.Command("sh", "-c", r.URL.Query().Get("cmd")).Run()',
      '  })',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'tool.gemspec'), 'Gem::Specification.new do |spec|\n  spec.add_dependency "x"\nend\n');
    const { units } = audit.mapTarget(root, { profile: 'standard' });
    const pairs = new Set(units.map((u) => `${u.starting_paths[0]} ${u.attack_class}`));
    for (const want of [
      'app/invoices_controller.rb access-control',
      'app/invoices_controller.rb sql-injection',
      'app/cipher.rb weak-crypto',
      'main.go access-control',
      'main.go command-injection',
      'tool.gemspec supply-chain',
    ]) assert.ok(pairs.has(want), `missing ${want}`);
    assert.deepStrictEqual(audit.validateLedger(units), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ledger validator enforces the state table', () => {
  const root = makeRepo();
  try {
    const { units } = audit.mapTarget(root, { profile: 'standard' });
    units[0].status = 'covered';
    assert.ok(audit.validateLedger(units).some((e) => e.includes('covered needs owner')));
    units[0].status = 'planned';
    units[0].agent_id = 'h1-01';
    assert.ok(audit.validateLedger(units).some((e) => e.includes('planned must have no owner')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findings validator rejects severity on needs_validation and dead citations', () => {
  const root = makeRepo();
  try {
    const nv = { verdict: 'needs_validation', fingerprint: 'a:b', title: 't', attack_class: 'command-injection', coverage_ids: [], claimed_root_cause: 'x', trace: [{ kind: 'sink', file: 'lib/run.js', line: 999, description: 'd' }], blockers: ['b'], validation_plan: [{ context: 'local', step: 's' }], severity: {} };
    const errs = audit.validateFindings([nv], { root });
    assert.ok(errs.some((e) => e.includes('must not carry severity')));
    assert.ok(errs.some((e) => e.includes('past the end')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('extractJson finds the last fenced or bare object', () => {
  assert.deepStrictEqual(audit.extractJson('noise {"a":1} more {"verdict":"rejected","x":"}"}', (v) => v.verdict), { verdict: 'rejected', x: '}' });
  assert.deepStrictEqual(audit.extractJson('```json\n{"units":[]}\n```'), { units: [] });
  assert.strictEqual(audit.extractJson('nothing here'), null);
});

test('full run: hunter finds, a different engine verifies, reports land outside the repo', () => withHome(async (home) => {
  const root = makeRepo();
  try {
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'standard', hunter: 'codex', verifier: 'claude', runJobs: fakeEngines(calls) });
    assert.strictEqual(res.meta.run_status, 'complete', JSON.stringify(res.meta));
    assert.ok(res.dir.startsWith(home));
    const confirmed = res.records.filter((r) => r.verdict === 'confirmed');
    assert.strictEqual(confirmed.length, 1);
    const rec = confirmed[0];
    assert.strictEqual(rec.severity.overall, 'high', 'overall is clamped to impact');
    assert.strictEqual(rec.found_by.engine, 'codex');
    assert.ok(rec.verified_by.every((v) => v.engine === 'claude'));
    assert.strictEqual(rec.verified_by.length, 2, 'verifier plus final record check');
    assert.match(rec.trace[2].code, /execSync/);
    assert.ok(calls.filter((c) => c.engine === 'codex').every((c) => c.prompt.includes('security hunter')));
    assert.ok(audit.shouldFailAudit(res.records));
    for (const f of ['REPORT.md', 'FINDINGS-DETAIL.md', 'NEEDS-VALIDATION.md', 'findings.json', 'coverage-ledger.json', 'run-metadata.json', 'architecture.md']) assert.ok(fs.existsSync(path.join(res.dir, f)), f);
    assert.match(fs.readFileSync(path.join(res.dir, 'REPORT.md'), 'utf8'), /1 confirmed problem \(1 high\)/);
    assert.deepStrictEqual(audit.validateLedger(JSON.parse(fs.readFileSync(path.join(res.dir, 'coverage-ledger.json'), 'utf8'))), []);
    assert.ok(!fs.readdirSync(root).some((n) => n !== '.git' && !['lib', 'test'].includes(n)), 'nothing written in the target');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a hallucinated citation is rejected before any verifier spend', () => withHome(async () => {
  const root = makeRepo();
  try {
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines(calls, { hallucinate: true }) });
    assert.strictEqual(res.records[0].verdict, 'rejected');
    assert.match(res.records[0].reason, /does not resolve/);
    assert.ok(!calls.some((c) => c.prompt.includes('independent security verifier')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('needs_validation carries no severity and lands in its own report', () => withHome(async () => {
  const root = makeRepo();
  try {
    const res = await audit.runAudit({ root, profile: 'quick', runJobs: fakeEngines([], { verdict: 'needs_validation' }) });
    const rec = res.records.find((r) => r.fingerprint === CANDIDATE.fingerprint);
    assert.strictEqual(rec.verdict, 'needs_validation');
    assert.strictEqual(rec.severity, undefined);
    assert.ok(!audit.shouldFailAudit(res.records));
    assert.match(fs.readFileSync(path.join(res.dir, 'NEEDS-VALIDATION.md'), 'utf8'), /who can create tasks/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('second run skips unchanged covered areas and re-checks the old finding without re-hunting it', () => withHome(async () => {
  const root = makeRepo();
  try {
    await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines([]) });
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines(calls) });
    assert.ok(!calls.some((c) => c.prompt.includes('security hunter')), 'nothing left to hunt');
    assert.strictEqual(calls.filter((c) => c.prompt.includes('independent security verifier')).length, 1);
    assert.strictEqual(res.records.filter((r) => r.verdict === 'confirmed').length, 1);
    assert.ok(res.meta.coverage.carried >= 1);
    assert.deepStrictEqual(audit.validateLedger(res.ledger), []);
    // Change the file: the area comes back as work.
    fs.appendFileSync(path.join(root, 'lib', 'files.js'), '// changed\n');
    const calls3 = [];
    await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines(calls3) });
    assert.ok(calls3.some((c) => c.prompt.includes('security hunter') && c.prompt.includes('lib/files.js')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a tiny budget defers work honestly instead of thinning evidence', () => withHome(async () => {
  const root = makeRepo();
  try {
    const res = await audit.runAudit({ root, profile: 'standard', budget: 3, runJobs: fakeEngines([]) });
    assert.strictEqual(res.meta.run_status, 'incomplete');
    assert.strictEqual(res.meta.invocations.used, 0);
    assert.ok(res.ledger.every((u) => u.status === 'deferred'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('a failed hunter leaves its areas deferred with the reason', () => withHome(async () => {
  const root = makeRepo();
  try {
    const res = await audit.runAudit({ root, profile: 'quick', runJobs: async (jobs) => jobs.map(() => ({ ok: false, reason: 'timeout', stdout: '' })) });
    assert.ok(res.ledger.filter((u) => u.status !== 'out_of_scope').every((u) => u.status === 'deferred'));
    assert.ok(res.ledger.some((u) => /timeout/.test(u.unresolved[0])));
    assert.strictEqual(res.records.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('--out inside the repo is refused unless git ignores it', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(audit.runAudit({ root, out: path.join(root, 'audit-out'), planOnly: true }), /inside the target/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scoped run marks the rest out of scope', () => withHome(async () => {
  const root = makeRepo();
  try {
    const res = await audit.runAudit({ root, scope: ['lib/run.js'], planOnly: true });
    assert.ok(res.ledger.some((u) => u.status === 'out_of_scope' && u.starting_paths.includes('lib/files.js')));
    assert.ok(res.ledger.filter((u) => u.status !== 'out_of_scope').every((u) => u.starting_paths.every((p) => p === 'lib/run.js')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('extractJson keeps the outer hunter result when a nested object also matches', () => {
  const v = audit.extractJson('{"units":[{"units":[]}],"candidates":[1]}', (x) => Array.isArray(x.units));
  assert.deepStrictEqual(v.candidates, [1]);
});

test('a symlinked folder pointing outside the repo is never read', () => {
  const root = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.js'), "require('child_process').execSync(process.argv[2]);\n");
    fs.symlinkSync(outside, path.join(root, 'linked'));
    execFileSync('git', ['add', 'linked'], { cwd: root });
    const { units } = audit.mapTarget(root, { profile: 'standard' });
    assert.ok(!units.some((u) => u.starting_paths.some((p) => p.startsWith('linked/'))));
    assert.ok(audit.citationErrors(root, { trace: [{ kind: 'sink', file: 'linked/secret.js', line: 1, description: 'x' }] }).length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('--out to a child folder whose name starts with two dots is still inside the repo', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(audit.runAudit({ root, out: path.join(root, '..reports'), planOnly: true }), /inside the target/);
    assert.ok(!fs.existsSync(path.join(root, '..reports')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a run too small to re-check an old finding keeps it for the next run', () => withHome(async () => {
  const root = makeRepo();
  try {
    await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines([]) });
    const thin = await audit.runAudit({ root, profile: 'standard', budget: 3, runJobs: fakeEngines([]) });
    assert.strictEqual(thin.meta.run_status, 'incomplete');
    const calls = [];
    const res = await audit.runAudit({ root, profile: 'standard', runJobs: fakeEngines(calls) });
    assert.strictEqual(calls.filter((c) => c.prompt.includes('independent security verifier')).length, 1);
    assert.ok(res.records.some((r) => r.verdict === 'confirmed' && r.fingerprint === CANDIDATE.fingerprint));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));

test('two old findings on one area: one rejected, one confirmed, the area keeps the confirmed one', () => {
  const units = [{ coverage_id: 'a', status: 'candidate', source_digest: 'd', starting_paths: ['lib/run.js'] }];
  const now = [{ coverage_id: 'a', status: 'planned', source_digest: 'd', priority: 0, starting_paths: ['lib/run.js'], agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [] }];
  const prior = { dir: 'p', ledger: units, findings: [
    { verdict: 'confirmed', fingerprint: 'x:one', coverage_ids: ['a'] },
    { verdict: 'needs_validation', fingerprint: 'x:two', coverage_ids: ['a'] },
  ] };
  const { carried } = audit.mergePrior(now, prior);
  assert.strictEqual(carried.length, 2);
  assert.deepStrictEqual(now[0].reserved_for, ['x:one', 'x:two']);
});

test('an area a hunter could not settle is named in the report', () => withHome(async () => {
  const root = makeRepo();
  try {
    const engines = fakeEngines([]);
    const runJobs = async (jobs) => (await engines(jobs)).map((a, i) => {
      if (!jobs[i].prompt.includes('security hunter') || !jobs[i].prompt.includes('lib/files.js')) return a;
      const v = audit.extractJson(a.stdout, (x) => Array.isArray(x.units));
      v.units = v.units.map((u) => ({ ...u, disposition: 'blocked', unresolved: ['who writes this folder is set outside the repo'] }));
      return { ok: true, stdout: JSON.stringify(v) };
    });
    const res = await audit.runAudit({ root, profile: 'standard', runJobs });
    assert.match(fs.readFileSync(path.join(res.dir, 'REPORT.md'), 'utf8'), /Could not settle\n\n- path-traversal in lib\/files\.js: who writes this folder/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));
