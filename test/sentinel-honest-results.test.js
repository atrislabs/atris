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
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n') };
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
  const r = await capture(() => auditCommand(['--quick'], deps(root, home, { token: 'tok', cloud: cloudCatching(uploads), runJobs: failing })));
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
