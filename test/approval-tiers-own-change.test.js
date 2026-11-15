'use strict';

// The tier comes from the job's own change, read from git, never from one commit
// the builder names. These are the reviewer's repros, kept as regression tests:
// a commit pushed straight to master before a docs tip, a docs merge that is not
// the job's, a merge made on the branch side, a moved file, a declared path the
// gate cannot read, and instruction files that ship to user projects. Hosted
// checks are green only when the host says so: a fake `gh` on PATH stands in for
// GitHub, so the parsing that runs is the real one and no test needs a network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tasks = require('../lib/task-db');
const { approvalTierOf, evaluateAutoAccept } = require('../lib/auto-accept-certified');
const {
  classifyChange,
  classifyPath,
  hostedChecksGreen,
  readApprovalTiers,
  resolveApprovalTiers,
} = require('../lib/approval-tiers');

const roots = [];
const originalPath = process.env.PATH;
test.after(() => {
  process.env.PATH = originalPath;
  try { tasks.close(); } catch {}
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function write(root, files) {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
}

function commit(root, files, message) {
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-own-change-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 'tiers@example.com');
  git(root, 'config', 'user.name', 'tiers');
  git(root, 'remote', 'add', 'origin', 'git@github.com:example/tiers.git');
  const base = commit(root, {
    'test/ok.test.js': "require('node:test')('ok', () => {});\n",
    'lib/plain.js': 'module.exports = 0;\n',
    'lib/billing.js': 'module.exports = 0;\n',
    'lib/auto-accept-certified.js': 'module.exports = {};\n',
  }, 'base');
  return { root, base };
}

function publish(root, sha) {
  git(root, 'update-ref', 'refs/remotes/origin/master', sha);
}

// A fake GitHub: every commit has the given check runs.
function fakeGitHub(runs, statuses = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fake-gh-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify({ total_count: runs.length, check_runs: runs }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: statuses.length ? statuses[0].state : 'pending', total_count: statuses.length, statuses }));
  fs.writeFileSync(path.join(dir, 'calls.log'), '');
  const script = [
    '#!/bin/sh',
    `echo "$@" >> "${path.join(dir, 'calls.log')}"`,
    'case "$2" in',
    `  *check-runs*) cat "${path.join(dir, 'runs.json')}" ;;`,
    `  *status*) cat "${path.join(dir, 'status.json')}" ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return dir;
}

const GREEN = [{ name: 'test', status: 'completed', conclusion: 'success' }];
const PROOF = 'node --test test/ok.test.js passed with exit 0 on the merged code; the notes read cleanly.';

function job(root, { merge, start, work, extra = {} }) {
  return {
    id: 'own-change-job',
    display_id: 'OWN-1',
    status: 'review',
    tag: null,
    claimed_by: 'builder',
    workspace_root: root,
    metadata: {
      approval_status: 'pending',
      built_by: 'builder',
      agent_review_pass_count: 1,
      latest_agent_proof: PROOF,
      verify: 'node --test test/ok.test.js',
      ...(merge ? { merge_commit: merge } : {}),
      ...(start ? { start_commit: start } : {}),
      ...(work ? { work_commit: work } : {}),
      ...extra,
    },
    review: { approval_status: 'pending', agent_review_pass_count: 1, proof: PROOF },
    events: [
      { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder', ...(start ? { start_commit: start } : {}) } },
      { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    ],
  };
}

// A docs job done the normal way: branch from master, merge with a merge commit.
function docsMerge() {
  const { root, base } = repo();
  git(root, 'checkout', '-q', '-b', 'work');
  const work = commit(root, { 'docs/guide.md': '# guide\n' }, 'docs');
  git(root, 'checkout', '-q', 'master');
  git(root, 'merge', '-q', '--no-ff', 'work', '-m', 'merge work');
  const merge = git(root, 'rev-parse', 'HEAD');
  publish(root, merge);
  return { root, base, work, merge };
}

test('the honest tier 0 path still lands: a docs merge of the job own work, checks green on the host', () => {
  fakeGitHub(GREEN);
  const { root, base, work, merge } = docsMerge();
  const result = evaluateAutoAccept(job(root, { merge, start: base, work }), { strictVerify: true });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.reason, 'tier0_checks_only');
});

test('own change (a): billing pushed straight to master before a docs tip is read, so it is not tier 0', () => {
  fakeGitHub(GREEN);
  const { root, base } = repo();
  commit(root, { 'lib/billing.js': 'module.exports = 1;\n' }, 'billing straight to master');
  const tip = commit(root, { 'docs/note.md': '# note\n' }, 'docs straight to master');
  publish(root, tip);
  const task = job(root, { merge: tip, start: base, work: tip });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'tier0_checks_only');
  const change = approvalTierOf(task);
  assert.equal(change.tier, 2, JSON.stringify(change));
  assert.equal(change.first.path, 'lib/billing.js');
  // Reviewed by someone else, it still waits for the owner: billing is tier 2.
  const reviewed = { ...task, metadata: { ...task.metadata, agent_certified: true, agent_review_pass_count: 2 } };
  reviewed.events = [...task.events, { event_type: 'reviewed', actor: 'validator' }];
  const held = evaluateAutoAccept(reviewed, { strictVerify: true, executeVerify: false });
  assert.equal(held.reason, 'approval_tier_2', JSON.stringify(held));
  assert.equal(held.path, 'lib/billing.js');
});

test('own change (a), end to end on a real task database: claim, commit, hand in with the tip, not accepted', (t) => {
  fakeGitHub(GREEN);
  const { root } = repo();
  const dbPath = path.join(root, '.atris-test-tasks.db');
  const db = tasks.open(dbPath);
  t.after(() => tasks.close());
  const { id } = tasks.addTask(db, { title: 'write a note', workspaceRoot: root });
  assert.equal(tasks.claimTask(db, { id, claimedBy: 'builder' }).claimed, true);
  commit(root, { 'lib/billing.js': 'module.exports = 2;\n' }, 'billing straight to master');
  const tip = commit(root, { 'docs/note.md': '# note\n' }, 'docs straight to master');
  publish(root, tip);
  const ready = tasks.readyTask(db, { id, actor: 'builder', proof: PROOF, workRoot: root, merge: { merge_commit: tip } });
  assert.equal(ready.ready, true, JSON.stringify(ready));
  const row = tasks.taskProjection(db, { taskId: id }).tasks[0];
  row.metadata.verify = 'node --test test/ok.test.js';
  assert.ok(row.metadata.start_commit, 'claim stamped the start');
  assert.equal(row.metadata.work_commit, tip, 'hand-in stamped the work');
  const result = evaluateAutoAccept(row, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'tier0_checks_only');
});

test('own change (b): a docs merge that is not the job work does not make the job tier 0', () => {
  fakeGitHub(GREEN);
  const { root, base } = repo();
  git(root, 'checkout', '-q', '-b', 'gate-work');
  const work = commit(root, { 'lib/auto-accept-certified.js': 'module.exports = { open: true };\n' }, 'gate change');
  git(root, 'checkout', '-q', 'master');
  git(root, 'checkout', '-q', '-b', 'someone-else');
  commit(root, { 'docs/other.md': '# other\n' }, 'other docs');
  git(root, 'checkout', '-q', 'master');
  git(root, 'merge', '-q', '--no-ff', 'someone-else', '-m', 'merge other docs');
  const merge = git(root, 'rev-parse', 'HEAD');
  publish(root, merge);
  const task = job(root, { merge, start: base, work });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'tier0_checks_only');
  assert.equal(approvalTierOf(task).tier, 2);
  assert.equal(approvalTierOf(task).landed, false, 'the merge is not this job landing');
});

test('own change (c): a merge made on the branch side is read from the job side too', () => {
  fakeGitHub(GREEN);
  const { root, base } = repo();
  git(root, 'checkout', '-q', '-b', 'work');
  const work = commit(root, { 'lib/auto-accept-certified.js': 'module.exports = { open: true };\n' }, 'gate change');
  git(root, 'checkout', '-q', 'master');
  commit(root, { 'docs/meanwhile.md': '# meanwhile\n' }, 'docs on master');
  git(root, 'checkout', '-q', 'work');
  git(root, 'merge', '-q', '--no-ff', 'master', '-m', 'bring master into the branch');
  const merge = git(root, 'rev-parse', 'HEAD');
  publish(root, merge);
  git(root, 'checkout', '-q', 'master');
  const task = job(root, { merge, start: base, work });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'tier0_checks_only');
  assert.equal(approvalTierOf(task).tier, 2);
  // Even with no start or work commit on record, every side of the merge is read.
  const bare = classifyChange({ task: { metadata: { merge_commit: merge } }, scope: null, root, tiers: resolveApprovalTiers(null) });
  assert.equal(bare.tier, 2);
});

test('never tier 0 from a named commit alone: without the job own start and work commits it is tier 1', () => {
  fakeGitHub(GREEN);
  const { root, merge } = docsMerge();
  const change = classifyChange({ task: { metadata: { merge_commit: merge } }, scope: null, root, tiers: resolveApprovalTiers(null) });
  assert.equal(change.tier, 1, JSON.stringify(change));
  const result = evaluateAutoAccept(job(root, { merge }), { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.notEqual(result.reason, 'tier0_checks_only');
});

test('hosted checks: a merge on the target with no check run on the host is not green', () => {
  const { root, base, work, merge } = docsMerge();
  fakeGitHub([]);
  const task = job(root, { merge, start: base, work });
  assert.equal(hostedChecksGreen(task, root).green, false);
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'tier0_checks_only');
  // An old policy file that said a merge means green no longer turns the guess on.
  const old = resolveApprovalTiers({ approval_tiers: { merge_means_hosted_green: true } });
  assert.equal(hostedChecksGreen(task, root, old).green, false);
});

test('hosted checks: failing, pending or unreadable host results are not green, and a builder note is not evidence', () => {
  const { root, base, work, merge } = docsMerge();
  const task = job(root, { merge, start: base, work });
  fakeGitHub([{ name: 'test', status: 'completed', conclusion: 'failure' }]);
  assert.equal(hostedChecksGreen(task, root).green, false, 'failure');
  fakeGitHub([{ name: 'test', status: 'in_progress', conclusion: null }]);
  assert.equal(hostedChecksGreen(task, root).green, false, 'pending');
  fakeGitHub(GREEN, [{ context: 'ci', state: 'failure' }]);
  assert.equal(hostedChecksGreen(task, root).green, false, 'a failing commit status');
  fakeGitHub([]);
  assert.equal(hostedChecksGreen({ ...task, metadata: { ...task.metadata, hosted_checks: 'green' } }, root).green, false, 'the builder saying green is not the host saying it');
  process.env.PATH = '/nonexistent-bin';
  assert.equal(hostedChecksGreen(task, root).green, false, 'no gh at all');
  process.env.PATH = originalPath;
  fakeGitHub(GREEN);
  assert.equal(hostedChecksGreen(task, root).green, true, 'green when the host reports success');
  git(root, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/a/b.git');
  assert.equal(hostedChecksGreen(task, root).green, false, 'not a host we can ask');
});

test('a moved file shows as deleted, so moving the gate out of lib is not tests only', () => {
  fakeGitHub(GREEN);
  const { root, base } = repo();
  git(root, 'checkout', '-q', '-b', 'work');
  git(root, 'mv', 'lib/auto-accept-certified.js', 'test/fixtures-old-gate.js');
  git(root, 'mv', 'lib/plain.js', 'test/plain-helper.js');
  git(root, 'commit', '-q', '-m', 'move the gate');
  const work = git(root, 'rev-parse', 'HEAD');
  // The branch read, as the landing gate does it, with the branch checked out.
  const branchTask = job(root, { extra: { branch: 'work', base_ref: 'master' } });
  assert.equal(approvalTierOf(branchTask).tier, 2, JSON.stringify(approvalTierOf(branchTask)));
  git(root, 'checkout', '-q', 'master');
  git(root, 'merge', '-q', '--no-ff', 'work', '-m', 'merge move');
  const merge = git(root, 'rev-parse', 'HEAD');
  publish(root, merge);
  const task = job(root, { merge, start: base, work });
  const change = approvalTierOf(task);
  assert.equal(change.tier, 2, JSON.stringify(change));
  assert.ok(change.paths.includes('lib/auto-accept-certified.js'));
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.notEqual(result.reason, 'tier0_checks_only');
});

test('a declared path the gate cannot read keeps the change at tier 1 or higher', () => {
  fakeGitHub(GREEN);
  const { root, base, work, merge } = docsMerge();
  const glob = job(root, { merge, start: base, work, extra: { changed_files: 'lib/*.js, docs/other.md' } });
  const globChange = approvalTierOf(glob);
  assert.ok(globChange.tier >= 1, JSON.stringify(globChange));
  assert.equal(globChange.tier, 2, 'the glob covers lib/billing.js and the gate itself');
  assert.equal(evaluateAutoAccept(glob, { strictVerify: true, executeVerify: false }).eligible, false);
  const outside = job(root, { merge, start: base, work, extra: { changed_files: '../elsewhere/notes.md' } });
  const outsideChange = approvalTierOf(outside);
  assert.equal(outsideChange.tier, 1, JSON.stringify(outsideChange));
  const outsideResult = evaluateAutoAccept(outside, { strictVerify: true, executeVerify: false });
  assert.equal(outsideResult.eligible, false);
  assert.notEqual(outsideResult.reason, 'tier0_checks_only');
});

test('instruction files that ship to user projects are not tier 0, and docs/ holds only docs', () => {
  const tiers = resolveApprovalTiers(null);
  for (const file of [
    'atris/GEMINI.md', 'FOR_AGENTS.md', 'PERSONA.md',
    'templates/business-starter/atris.md', 'templates/business-starter/instructions.md',
    'templates/business-starter/team/lead/MEMBER.md', 'templates/business-starter/team/lead/SOUL.md',
    'templates/business-starter/policies/refunds.md', 'docs/install.sh',
  ]) {
    assert.ok(classifyPath(file, tiers).tier >= 1, `${file} is ${classifyPath(file, tiers).tier}`);
  }
  assert.equal(classifyPath('docs/guide.md', tiers).tier, 0);
  assert.equal(classifyPath('test/fixtures/a.json', tiers).tier, 0);
});

test('every file the package ships is tier 1 or higher, read from this repo package.json', () => {
  const root = path.resolve(__dirname, '..');
  const tiers = readApprovalTiers(root);
  const files = require(path.join(root, 'package.json')).files;
  const listed = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const ships = (file) => files.some((entry) => {
    if (entry.endsWith('/')) return file.startsWith(entry);
    if (entry.includes('*')) return path.dirname(file) === path.dirname(entry) && file.endsWith(path.extname(entry));
    return file === entry || file.startsWith(`${entry}/`);
  });
  const shipped = listed.filter(ships);
  assert.ok(shipped.length > 90, `found ${shipped.length} shipped files`);
  const zero = shipped.filter((file) => classifyPath(file, tiers).tier === 0);
  assert.deepEqual(zero, []);
});
