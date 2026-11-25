'use strict';

// Sentinel never says "no problems found", and never finishes as a pass,
// when it did not really look. Each test is a case from the 2026-11-24
// audit. Real temp git repos and fake engines: no real AI tool, no network,
// no credits, and the audit home is a temp folder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const audit = require('../lib/security-audit');
const realCloud = require('../lib/sentinel-cloud');
const rec = require('../lib/sentinel-record');
const { auditCommand } = require('../commands/security-review');

const made = [];
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
const priorHome = process.env.ATRIS_SECURITY_AUDIT_HOME;
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
  else process.env.ATRIS_SECURITY_AUDIT_HOME = priorHome;
});

// A fresh audit home per test, so no test sees another's runs.
function freshHome() {
  const home = tmp('sentinel-honest-home-');
  process.env.ATRIS_SECURITY_AUDIT_HOME = path.join(home, 'audits');
  return home;
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
}

const HOLE = [
  "const { execSync } = require('child_process');",
  'function runTask(task) {',
  '  const title = task.title;',
  '  return execSync(`echo ${title}`);',
  '}',
  'module.exports = { runTask };',
  '',
].join('\n');

function makeRepo(dir, files = { 'lib/run.js': HOLE }, remote = null) {
  const root = dir || tmp('sentinel-honest-repo-');
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, 'init', '-q');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return fs.realpathSync(root);
}

test('a local Sentinel review binds its evidence to the scoped source before and after reading', async (t) => {
  const route = "function show(req, res) { return res.json({ name: req.query.name }); }\n";
  const cases = [
    ['unchanged tracked source', () => {}, 'matched'],
    ['unchanged dirty source', () => {}, 'matched', true],
    ['different bytes while already dirty', (root) => fs.appendFileSync(path.join(root,'lib/view.js'),'// edited again\n'), 'changed', true],
    ['HEAD advances while reading', (root) => git(root,'commit','--allow-empty','-qm','advance'), 'changed'],
    ['tracked source added', (root) => { fs.writeFileSync(path.join(root,'lib/more.js'),'const colour = 1;'); git(root,'add','lib/more.js'); }, 'changed'],
    ['tracked source removed', (root) => git(root,'rm','-q','lib/other.js'), 'changed'],
    ['out-of-scope edit', (root) => fs.appendFileSync(path.join(root,'elsewhere.js'),'// unrelated\n'), 'matched'],
    ['out-of-scope SQL actually used for preparation', (root) => fs.appendFileSync(path.join(root,'policy.sql'),'-- adjustment\n'), 'changed'],
    ['indexed source cannot be read', (root) => fs.unlinkSync(path.join(root,'lib/other.js')), 'unverified'],
    ['source in a plain folder changes', (root) => fs.appendFileSync(path.join(root,'lib/view.js'),'// local edit\n'), 'changed', false, true],
  ];
  for (const [label, mutate, expected, dirty, plain] of cases) {
    await t.test(label, async () => {
      const home = freshHome();
      const root = makeRepo(null, {'lib/view.js':route,'lib/other.js':'const a = 1;\n','elsewhere.js':'const b = 2;\n','policy.sql':'-- sample database settings\n'});
      if (dirty) fs.appendFileSync(path.join(root,'lib/view.js'),'// already dirty\n');
      if (plain) fs.rmSync(path.join(root,'.git'), {recursive:true,force:true});
      let called = false;
      const fake = engines({clean:true});
      const uploads = [];
      const runJobs = async (jobs) => {
        if (!called) { called = true; mutate(root); }
        return fake(jobs);
      };
      const result = await capture(() => auditCommand(['lib','--json','--upload'], deps(root,home,{runJobs,token:'tok',cloud:cloudCatching(uploads)})));
      assert.equal(called,true);
      const json=JSON.parse(result.stdout);
      assert.equal(json.meta.source_integrity.state,expected);
      assert.equal(json.meta.source_integrity.start.dirty,plain ? null : !!dirty);
      if (expected==='matched') {
        assert.equal(result.code,0);
        assert.equal(json.meta.run_status,'complete');
        assert.equal(uploads.length,1);
      } else {
        assert.equal(result.code,1);
        assert.equal(json.ok,false);
        assert.equal(json.meta.run_status,'incomplete');
        assert.equal(uploads.length,0);
        assert.equal(audit.shouldFailRun(json.dir,json.findings),true);
        assert.ok(fs.existsSync(path.join(json.dir,'unverified-review.json')));
        assert.match(fs.readFileSync(path.join(json.dir,'REPORT.md'),'utf8'),/source (changed|for this review)/i);
        const status=await capture(() => auditCommand(['status'],deps(root,home)));
        assert.equal(status.code,1);
        const saved=await capture(() => auditCommand(['status','--json'],deps(root,home)));
        assert.equal(saved.code,1);
        assert.deepEqual(JSON.parse(saved.stdout).meta.source_integrity,json.meta.source_integrity);
        assert.throws(() => realCloud.buildUploadBody(json.dir), /source/i);
        const entry=rec.entryFromRun(json.dir);
        assert.equal(entry.counts.complete,0);
        assert.match(entry.summary,/source/i);
        assert.match(status.out,/source (changed|for this review)/i);
        assert.doesNotMatch(status.out,/no problems found/i);
      }
    });
  }
});

test('untracked supporting source affects the result only when the reader used it', async (t) => {
  for (const [cited, edited, expected] of [[true,false,'matched'], [true,true,'changed'], [false,true,'matched']]) {
    await t.test(`cited=${cited} edited=${edited}`, async () => {
      const home = freshHome();
      const root = makeRepo(null, {'lib/view.js': 'function show(req,res) { return res.json(req.query.name); }\n'});
      const rel = 'lib/local.js';
      fs.writeFileSync(path.join(root,rel),'const label = "initial";');
      const reader = engines({clean:true});
      const result = await capture(() => auditCommand(['--json','--no-upload'], deps(root,home,{runJobs:async (jobs) => {
        const answers = await reader(jobs);
        for (const answer of answers) {
          const payload = JSON.parse(answer.stdout);
          if (!Array.isArray(payload.units)) continue;
          if (edited) fs.writeFileSync(path.join(root,rel),'const label = "edited";');
          if (cited) for (const unit of payload.units) {
            unit.reviewed_paths.push(rel);
            unit.checks[0].reviewed_paths.push(rel);
          }
          answer.stdout = JSON.stringify(payload);
        }
        return answers;
      }})));
      const run=JSON.parse(result.stdout);
      assert.equal(run.meta.source_integrity.state,expected);
      assert.equal(run.meta.source_integrity.start.untracked_files || 0,Number(cited));
      assert.equal(run.meta.source_ref.dirty,cited);
    });
  }
});

test('an unresolvable HEAD in a Git checkout cannot be treated as a verified plain folder', async () => {
  const home=freshHome();
  const root=makeRepo(null,{'lib/view.js':'function show(req,res) { return res.json(req.query.name); }\n'});
  git(root,'update-ref','-d','HEAD');
  const result=await capture(() => auditCommand(['--json','--no-upload'],deps(root,home,{runJobs:engines({clean:true})})));
  const run=JSON.parse(result.stdout);
  assert.equal(run.meta.source_integrity.state,'unverified');
  assert.equal(run.meta.source_integrity.start.commit,null);
  assert.equal(run.meta.source_integrity.end.commit,null);
  assert.equal(result.code,1);
});

test('invalid saved source proof blocks exporting the summary', async () => {
  const home=freshHome();
  const root=makeRepo(null,{'lib/view.js':'function show(req,res) { return res.json(req.query.name); }\n'});
  const run=await audit.runAudit({root,runJobs:engines({clean:true})});
  const file=path.join(run.dir,'run-metadata.json');
  const meta=JSON.parse(fs.readFileSync(file,'utf8'));
  meta.source_integrity.end.digest=null;
  fs.writeFileSync(file,JSON.stringify(meta));
  assert.equal(audit.shouldFailRun(run.dir,run.records),true);
  assert.throws(() => realCloud.buildUploadBody(run.dir),/could not verify/);
  const saved=await capture(() => auditCommand(['status'],deps(root,home)));
  assert.equal(saved.code,1);
  assert.match(saved.out,/could not verify/);
});

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

// Fake engines. The hunter finds the hole in lib/run.js unless `clean`;
// `verify` is what the checker does: confirm it, or give no answer.
function engines({ clean = false, verify = 'confirm', calls = [] } = {}) {
  return async (jobs) => jobs.map((job) => {
    calls.push(job);
    const p = job.prompt;
    if (p.includes('security hunter')) {
      const ids = [...p.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
      const paths = [...p.matchAll(/starting paths: ([^,\s]+)/g)].map((m) => m[1]);
      const hit = !clean && p.includes('starting paths: lib/run.js') && p.includes('command-injection');
      return {
        ok: true,
        stdout: JSON.stringify({
          units: ids.map((id, i) => ({ coverage_id: id, disposition: hit ? 'candidate' : 'covered', reviewed_paths: [paths[i] || paths[0]], checks: [{ invariant: 'input never becomes shell text', method: 'source', result: 'read it', reviewed_paths: [paths[i] || paths[0]] }], candidate_fingerprints: hit ? [CANDIDATE.fingerprint] : [], unresolved: [] })),
          candidates: hit ? [{ ...CANDIDATE, coverage_ids: ids }] : [],
          hardening: [],
          uncovered: [],
        }),
      };
    }
    if (p.includes('independent security verifier')) {
      if (verify !== 'confirm') return { ok: false, stdout: '', reason: 'budget' };
      return { ok: true, stdout: JSON.stringify({ verdict: 'confirmed', reason: 'line 4 puts the title in a shell string', preventing_layer: null, corrected: {} }) };
    }
    if (p.includes('coverage critic')) return { ok: true, stdout: JSON.stringify({ missing_units: [], reassign_ids: [], stop: true }) };
    return { ok: true, stdout: '{"ok": true}' };
  });
}

// Fake codex and claude on PATH, so the command picks local tools.
function localEnv() {
  const bin = tmp('sentinel-honest-bin-');
  for (const n of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  return { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, ATRIS_SECURITY_AUDIT_HOME: process.env.ATRIS_SECURITY_AUDIT_HOME };
}

// The real cloud module with uploads caught, never sent.
function cloudCatching(uploads) {
  return { ...realCloud, uploadRun: async (dir) => { uploads.push(dir); return { ok: true, body: { findings: [] } }; } };
}

async function capture(fn) {
  const out = [];
  const stdout = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => { const line = a.join(' '); stdout.push(line); out.push(line); };
  console.error = (...a) => out.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), stdout: stdout.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function deps(root, home, extra = {}) {
  return { root, token: '', env: localEnv(), quiet: true, homeDir: home, ...extra };
}

function runFolders(home) {
  const base = path.join(home, 'audits');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((n) => n !== 'records').flatMap((n) => fs.readdirSync(path.join(base, n)).filter((r) => /^run-\d+$/.test(r)).map((r) => `${n}/${r}`));
}

// ---------------------------------------------------------------- audit item 3

test('a review that crashes or is stopped never erases open findings: the next run still has them, and status works', async () => {
  const home = freshHome();
  const root = makeRepo();
  const first = await capture(() => auditCommand(['--quick', '--no-upload'], deps(root, home, { runJobs: engines() })));
  assert.strictEqual(first.code, 1, first.out);
  assert.match(first.out, /1 confirmed \(1 high\)/);

  // A tool that throws is a failed read, never a clean one.
  const broken = await capture(() => auditCommand(['--quick', '--no-upload'], deps(root, home, { runJobs: async () => { throw new Error('codex crashed'); } })));
  assert.notStrictEqual(broken.code, 0, broken.out);
  assert.doesNotMatch(broken.out, /no problems found/);
  // The review itself crashes mid-way: its run folder is left half written.
  await assert.rejects(audit.runAudit({ root, profile: 'quick', runJobs: engines({ clean: true }), log: (m) => { if (!/^mapping/.test(m)) throw new Error('crashed'); } }), /crashed/);
  // And a review stopped with Ctrl-C leaves a run that never finished.
  const stopped = path.join(path.dirname(audit.latestRun(root).dir), 'run-9');
  fs.mkdirSync(stopped);
  fs.writeFileSync(path.join(stopped, 'run-metadata.json'), JSON.stringify({ run_status: 'in_progress', started_at: '2026-11-24T00:00:00.000Z' }));
  fs.writeFileSync(path.join(stopped, 'coverage-ledger.json'), '[]');

  const status = await capture(() => auditCommand(['status'], { root }));
  assert.strictEqual(status.code, 0, status.out);
  assert.match(status.out, /did not finish/);
  assert.match(status.out, /Task title runs as shell code/);
  assert.strictEqual(path.basename(audit.latestRun(root).dir), 'run-2', 'the crashed run-3 and the stopped run-9 are passed over');

  // A normal run after both: the hole is still open, and it is no pass.
  const next = await capture(() => auditCommand(['--quick', '--no-upload'], deps(root, home, { runJobs: engines({ clean: true }) })));
  assert.strictEqual(next.code, 1, next.out);
  assert.doesNotMatch(next.out, /no problems found/);
  assert.match(next.out, /Task title runs as shell code/);
});

// ---------------------------------------------------------------- audit item 4

test('a word that is no file, folder or command is refused: nothing runs and nothing uploads', async () => {
  const home = freshHome();
  const root = makeRepo();
  const uploads = [];
  const calls = [];
  const r = await capture(() => auditCommand(['powers'], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads), runJobs: engines({ calls }) })));
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /nothing was reviewed: there is no file or folder called powers here/);
  assert.match(r.out, /atris sentinel help all/);
  assert.deepStrictEqual([calls.length, uploads.length, runFolders(home).length], [0, 0, 0]);
});

test('an empty folder or a language it cannot read says nothing was reviewed, is not a pass, and calls and uploads nothing', async () => {
  const cases = {
    empty: { 'README.md': '# hi\n' },
    csharp: { 'Program.cs': 'class P { static void Main(string[] a) { System.Diagnostics.Process.Start("sh", a[0]); } }\n' },
    swift: { 'main.swift': 'import Foundation\nlet t = Process()\nt.arguments = CommandLine.arguments\n' },
    kotlin: { 'Main.kt': 'fun main(args: Array<String>) { Runtime.getRuntime().exec(args[0]) }\n' },
    elixir: { 'lib/app.ex': 'defmodule App do\n  def run(cmd), do: System.cmd("sh", ["-c", cmd])\nend\n' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const home = freshHome();
    const root = makeRepo(null, files);
    const uploads = [];
    const calls = [];
    const r = await capture(() => auditCommand([], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads), runJobs: engines({ calls }) })));
    assert.strictEqual(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, /nothing was reviewed: there is no code Sentinel can read at/, name);
    assert.match(r.out, /it reads JavaScript, TypeScript, Python/, name);
    assert.match(r.out, /this is not a clean result/, name);
    assert.doesNotMatch(r.out, /no problems found|0 confirmed/, name);
    assert.deepStrictEqual([calls.length, uploads.length, runFolders(home).length], [0, 0, 0], name);
    const json = await capture(() => auditCommand(['--json'], deps(root, home, { runJobs: engines() })));
    assert.strictEqual(json.code, 2);
    assert.strictEqual(JSON.parse(json.out).ok, false);
  }
});

test('a scope folder with no code in it is not a review either', async () => {
  const home = freshHome();
  const root = makeRepo(null, { 'lib/run.js': HOLE, 'docs/readme.md': 'words\n' });
  const r = await capture(() => auditCommand(['docs', '--no-upload'], deps(root, home, { runJobs: engines() })));
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /nothing was reviewed/);
  assert.deepStrictEqual(runFolders(home), []);
});

test('a review that read nothing uploads nothing, and an old empty run cannot be uploaded by hand', async () => {
  const home = freshHome();
  const root = makeRepo();
  const uploads = [];
  const failing = async (jobs) => jobs.map(() => ({ ok: false, stdout: '', reason: 'spawn_error' }));
  // --upload: the person said yes, and an empty review is still not saved.
  const r = await capture(() => auditCommand(['--quick', '--upload'], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads), runJobs: failing })));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /nothing was saved to your atris account: that review read nothing/);
  assert.deepStrictEqual(uploads, []);
  const dir = path.join(home, 'audits', runFolders(home)[0]);
  const byHand = await capture(() => auditCommand(['upload', dir], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads) })));
  assert.strictEqual(byHand.code, 2);
  assert.match(byHand.out, /was not saved: that review read nothing/);
  assert.deepStrictEqual(uploads, []);
  // The signed record says it read nothing, never that it found nothing.
  const entry = rec.entryFromRun(dir);
  assert.match(entry.summary, /read none of the code, so it says nothing about problems in it/);
  assert.strictEqual(entry.counts.complete, 0);
});

// ---------------------------------------------------------------- audit item 7

test('a review that leaves a serious lead unchecked is not a pass and says what is left', async () => {
  const home = freshHome();
  const root = makeRepo();
  const r = await capture(() => auditCommand(['--no-upload'], deps(root, home, { runJobs: engines({ verify: 'none' }) })));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /unchecked Task title runs as shell code \(lib\/run\.js:4\), high if real/);
  assert.match(r.out, /this review is not a pass: that lead could be high or critical and was never checked/);
  assert.doesNotMatch(r.out, /no problems found/);
  const json = await capture(() => auditCommand(['--no-upload', '--json'], deps(root, home, { runJobs: engines({ verify: 'none' }) })));
  assert.strictEqual(json.code, 1);
  assert.strictEqual(JSON.parse(json.out).ok, false);
  // An unchecked low lead alone is listed and does not fail the run.
  const meta = { unchecked: [{ title: 'x', severity: 'low' }, { title: 'y', severity: 'critical' }, { title: 'z' }] };
  assert.deepStrictEqual(audit.seriousUnchecked(meta).map((u) => u.title), ['y', 'z']);
  assert.deepStrictEqual(audit.seriousUnchecked({ unchecked: [{ title: 'x', severity: 'medium' }] }), []);
});

// ---------------------------------------------------------------- audit item 9

test('a plan never replaces the real review: status, fix and upload keep using it, and the plan report says nothing was read', async () => {
  const home = freshHome();
  const root = makeRepo();
  assert.strictEqual((await capture(() => auditCommand(['--quick', '--no-upload'], deps(root, home, { runJobs: engines() })))).code, 1);
  const plan = await capture(() => auditCommand(['--plan', '--no-upload'], deps(root, home)));
  assert.strictEqual(plan.code, 0, plan.out);
  const planDir = path.join(path.dirname(audit.latestRun(root).dir), 'run-2');
  const report = fs.readFileSync(path.join(planDir, 'REPORT.md'), 'utf8');
  assert.match(report, /Plan only\. No AI tool was called and no code was read/);
  assert.match(report, /A review would have codex look and claude double-check\. Nothing was read this time\./);
  assert.doesNotMatch(report, /Found by codex, checked by claude/);

  assert.strictEqual(path.basename(audit.latestRun(root).dir), 'run-1');
  const status = await capture(() => auditCommand(['status'], { root }));
  assert.match(status.out, /1 confirmed \(1 high\)/);
  assert.doesNotMatch(status.out, /plan only/);
  const { fixCommand } = require('../commands/sentinel-fix');
  const fix = await capture(() => fixCommand([], { root, env: process.env }));
  assert.match(fix.out, /Task title runs as shell code/);
  assert.doesNotMatch(fix.out, /no confirmed|run atris sentinel first/);

  const uploads = [];
  const up = await capture(() => auditCommand(['upload'], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads) })));
  assert.strictEqual(up.code, 0, up.out);
  assert.deepStrictEqual(uploads.map((d) => path.basename(d)), ['run-1']);
  const planUp = await capture(() => auditCommand(['upload', planDir], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads) })));
  assert.strictEqual(planUp.code, 2);
  assert.match(planUp.out, /was not saved: it is a plan/);

  // Record backfill adds the review and never the plan.
  const recOpts = { recordHome: path.join(home, 'audits'), homeDir: home };
  const filled = rec.backfill(root, recOpts);
  assert.ok(filled.skipped.includes('run-2'));
  assert.deepStrictEqual(rec.readEntries(rec.recordPath(root, recOpts)).map((e) => e.source_run), ['run-1']);
});

// ---------------------------------------------------------------- audit item 10

test('two projects with the same folder name keep their own history, records and fixes', async () => {
  const home = freshHome();
  const a = makeRepo(path.join(tmp('sentinel-honest-a-'), 'app'));
  const b = makeRepo(path.join(tmp('sentinel-honest-b-'), 'app'), { 'lib/run.js': "module.exports = () => 1;\nconst { execSync } = require('child_process');\nexecSync('ls');\n" });
  assert.strictEqual(audit.repoName(a), audit.repoName(b), 'same label');
  assert.notStrictEqual(audit.historyFolder(a), audit.historyFolder(b));
  assert.strictEqual((await capture(() => auditCommand(['--quick', '--no-upload'], deps(a, home, { runJobs: engines() })))).code, 1);

  assert.strictEqual(audit.latestRun(b), null, 'b has no review');
  const status = await capture(() => auditCommand(['status'], { root: b }));
  assert.match(status.out, /no finished sentinel review of this folder yet/);
  const { fixCommand } = require('../commands/sentinel-fix');
  const fix = await capture(() => fixCommand([], { root: b, env: process.env }));
  assert.doesNotMatch(fix.out, /Task title runs as shell code/);
  const recheck = await capture(() => auditCommand(['recheck'], deps(b, home, { runJobs: engines() })));
  assert.match(recheck.out, /no earlier review of this project to re-check/);
  const recOpts = { recordHome: path.join(home, 'audits'), homeDir: home };
  assert.deepStrictEqual(rec.backfill(b, recOpts).added, [], 'b never claims a\'s review');
  assert.deepStrictEqual(rec.readEntries(rec.recordPath(b, recOpts)), []);
  rec.backfill(a, recOpts);
  assert.deepStrictEqual(rec.readEntries(rec.recordPath(a, recOpts)).map((e) => e.source_run), ['run-1']);

  // Same remote, two clones: one project.
  const c1 = makeRepo(path.join(tmp('sentinel-honest-c1-'), 'web'), undefined, 'git@github.com:acme/web.git');
  const c2 = makeRepo(path.join(tmp('sentinel-honest-c2-'), 'other-name'), undefined, 'https://github.com/acme/web');
  assert.strictEqual(audit.historyFolder(c1), audit.historyFolder(c2));
  // A fork with the same repo name is another project.
  const fork = makeRepo(path.join(tmp('sentinel-honest-fork-'), 'web'), undefined, 'git@github.com:someone/web.git');
  assert.notStrictEqual(audit.historyFolder(c1), audit.historyFolder(fork));
});

test('history saved under the bare name by older versions moves to its own project, and only its own runs', () => {
  const home = freshHome();
  const a = makeRepo(path.join(tmp('sentinel-honest-old-a-'), 'app'));
  const b = makeRepo(path.join(tmp('sentinel-honest-old-b-'), 'app'));
  const moved = makeRepo(path.join(tmp('sentinel-honest-old-m-'), 'app'), { 'lib/moved.js': 'module.exports = 3;\n' });
  const movedCommit = git(moved, 'rev-parse', 'HEAD').trim();
  const old = path.join(home, 'audits', 'app');
  const write = (n, meta, findings) => {
    const dir = path.join(old, `run-${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ run_id: `run-${n}`, run_status: 'complete', finished_at: `2026-11-0${n}T00:00:00.000Z`, coverage: { in_scope: 1, fresh: 1, carried: 0 }, ...meta }));
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings));
    fs.writeFileSync(path.join(dir, 'coverage-ledger.json'), '[]');
  };
  write(1, { target: a }, [{ ...CANDIDATE, verdict: 'confirmed' }]);
  write(2, { target: b }, []);
  // A run whose folder was moved since: claimed by the repo that has its commit.
  write(3, { target: path.join(os.tmpdir(), 'gone-away', 'app'), source_ref: { commit: movedCommit } }, []);
  write(4, {}, []);

  assert.strictEqual(path.basename(audit.latestRun(a).dir), 'run-1');
  assert.strictEqual(audit.latestRun(a).records[0].title, CANDIDATE.title);
  assert.strictEqual(path.basename(audit.latestRun(b).dir), 'run-2');
  assert.deepStrictEqual(audit.latestRun(b).records, [], 'b never sees a\'s finding');
  assert.strictEqual(path.basename(audit.latestRun(moved).dir), 'run-3');
  // A run with no project named stays where it was, never handed to anyone.
  assert.deepStrictEqual(fs.readdirSync(old), ['run-4']);
});

// ---------------------------------------------------------------- audit item 34

test('two reviews of one project at once never share a run folder', async () => {
  const home = freshHome();
  const root = makeRepo();
  const outRoot = path.join(home, 'audits', audit.historyFolder(root));
  // Another review just took run-1; this one listed the folder a moment before.
  const theirs = path.join(outRoot, 'run-1');
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, 'run-metadata.json'), JSON.stringify({ run_status: 'in_progress', marker: 'theirs' }));
  const realReaddir = fs.readdirSync;
  let hidden = false;
  fs.readdirSync = function patched(p, ...rest) {
    if (path.resolve(String(p)) === outRoot) { hidden = true; return []; }
    return realReaddir.call(fs, p, ...rest);
  };
  let res;
  try { res = await audit.runAudit({ root, profile: 'quick', planOnly: true }); } finally { fs.readdirSync = realReaddir; }
  assert.ok(hidden, 'the stale listing was used');
  assert.notStrictEqual(res.dir, theirs);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(theirs, 'run-metadata.json'), 'utf8')).marker, 'theirs');
});
