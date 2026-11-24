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
