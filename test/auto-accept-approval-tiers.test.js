'use strict';

// The landing gate sorts approval by what a change touches. Real git repos, real
// merges, the real evaluator: tier 0 lands with no review once its check passes
// and the merge is on the target, tier 1 needs one review by someone who never
// built it, tier 2 waits for the owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { approvalTierOf, evaluateAutoAccept, mayBeTierZero } = require('../lib/auto-accept-certified');

const roots = [];
const originalPath = process.env.PATH;
test.after(() => {
  process.env.PATH = originalPath;
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

// A fake GitHub on PATH that reports one passing check on every commit, so tier 0
// sees a real host answer through the real parsing, with no network.
(function fakeGreenGitHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tier-gate-gh-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/bin/sh',
    'case "$2" in',
    `  *check-runs*) echo '${JSON.stringify({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] })}' ;;`,
    `  *status*) echo '${JSON.stringify({ state: 'pending', total_count: 0, statuses: [] })}' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
})();

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

// Where each repo's job started and what it handed in, as the task store stamps them.
const starts = new Map();
const works = new Map();

// A repo whose master holds a merge of `files`, pushed to origin/master.
function landedRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tier-gate-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 'tiers@example.com');
  git(root, 'config', 'user.name', 'tiers');
  git(root, 'remote', 'add', 'origin', 'git@github.com:example/tiers.git');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'ok.test.js'), "require('node:test')('ok', () => {});\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  starts.set(root, git(root, 'rev-parse', 'HEAD'));
  git(root, 'checkout', '-q', '-b', 'work');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'work');
  works.set(root, git(root, 'rev-parse', 'HEAD'));
  git(root, 'checkout', '-q', 'master');
  git(root, 'merge', '-q', '--no-ff', 'work', '-m', 'merge work');
  const merge = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/master', merge);
  return { root, merge };
}

const PROOF = 'node --test test/ok.test.js passed with exit 0 on the merged code; the new notes read cleanly.';

function job(root, { merge = null, events = null, passCount = 1, extra = {} } = {}) {
  return {
    id: 'tier-job',
    display_id: 'TIER-1',
    status: 'review',
    tag: null,
    claimed_by: 'builder',
    workspace_root: root,
    metadata: {
      approval_status: 'pending',
      built_by: 'builder',
      agent_review_pass_count: passCount,
      latest_agent_proof: PROOF,
      verify: 'node --test test/ok.test.js',
      ...(merge ? { merge_commit: merge, start_commit: starts.get(root), work_commit: works.get(root) } : {}),
      ...extra,
    },
    review: { approval_status: 'pending', agent_review_pass_count: passCount, proof: PROOF },
    events: events || [
      { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
      { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    ],
  };
}

test('tier 0: docs and tests merged on the target land with no review pass once the check passes', () => {
  const { root, merge } = landedRepo({ 'docs/guide.md': '# guide\n', 'test/more.test.js': "require('node:test')('more', () => {});\n" });
  const result = evaluateAutoAccept(job(root, { merge }), { strictVerify: true });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.approval_tier, 0);
  assert.equal(result.reason, 'tier0_checks_only');
});

test('tier 0 still needs its done check to pass', () => {
  const { root, merge } = landedRepo({ 'docs/guide.md': '# guide\n', 'test/bad.test.js': "require('node:test')('bad', () => { throw new Error('no'); });\n" });
  const task = job(root, { merge, extra: { verify: 'node --test test/bad.test.js' } });
  const result = evaluateAutoAccept(task, { strictVerify: true });
  assert.equal(result.eligible, false);
  assert.match(String(result.reason), /verify_failed/);
});

test('tier 0 still needs the hosted checks green: a merge not on the target is not enough', () => {
  const { root, merge } = landedRepo({ 'docs/guide.md': '# guide\n' });
  git(root, 'update-ref', '-d', 'refs/remotes/origin/master');
  const result = evaluateAutoAccept(job(root, { merge }), { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_agent_certified');
});

test('never: a docs job whose files git cannot read is not tier 0 and waits for a review', () => {
  const { root } = landedRepo({ 'docs/guide.md': '# guide\n' });
  const task = job(root, { extra: { artifact_paths: ['docs/guide.md'], hosted_checks: 'green' } });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_agent_certified');
});

test('tier 1: ordinary code lands after one review by someone who never built it', () => {
  const { root, merge } = landedRepo({ 'lib/plain.js': 'module.exports = 1;\n' });
  const events = [
    { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'autoland-verifier' },
  ];
  const task = job(root, { merge, events, passCount: 2, extra: { agent_certified: true } });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.approval_tier, 1);
  assert.equal(result.independent_passes, 1);
});

test('tier 1 without a review waits, even with the hosted checks green', () => {
  const { root, merge } = landedRepo({ 'lib/plain.js': 'module.exports = 1;\n' });
  const result = evaluateAutoAccept(job(root, { merge }), { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_agent_certified');
});

test('never: the builder reviewing its own work does not count as the review', () => {
  const { root, merge } = landedRepo({ 'lib/plain.js': 'module.exports = 1;\n' });
  const events = [
    { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    { event_type: 'reviewed', actor: 'builder' },
  ];
  const result = evaluateAutoAccept(job(root, { merge, events, passCount: 2 }), { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.ok(['needs_independent_reviewer', 'probation_needs_review'].includes(result.reason), result.reason);
});

test('a review of an older proof does not count after the builder hands in again', () => {
  const { root, merge } = landedRepo({ 'lib/plain.js': 'module.exports = 1;\n' });
  const events = [
    { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    { event_type: 'reviewed', actor: 'codex-review' },
    { event_type: 'proof_ready', actor: 'builder' },
  ];
  const task = job(root, { merge, events, passCount: 3, extra: { agent_certified: true } });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.ok(['needs_independent_reviewer', 'probation_needs_review'].includes(result.reason), result.reason);
  assert.equal(result.independent_passes, 0);
});

test('tier 2: a change to the landing machinery waits for the owner even when reviewed', () => {
  const { root, merge } = landedRepo({ 'lib/plain.js': 'module.exports = 1;\n', 'lib/auto-accept-certified.js': 'module.exports = {};\n' });
  const events = [
    { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'autoland-verifier' },
  ];
  const task = job(root, { merge, events, passCount: 2, extra: { agent_certified: true } });
  const result = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'approval_tier_2');
  assert.equal(result.path, 'lib/auto-accept-certified.js');
  const owner = evaluateAutoAccept(task, { strictVerify: true, executeVerify: false, includeProtected: true });
  assert.equal(owner.eligible, true, 'the owner policy that lets protected work land still decides');
});

test('tier 2 holds a change with money code in it, in the accept-all lane too', () => {
  const { root, merge } = landedRepo({ 'docs/pay.md': '# pay\n', 'lib/billing.js': 'module.exports = 1;\n' });
  const events = [
    { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
    { event_type: 'proof_ready', actor: 'builder', payload: { handed_in_by: 'builder' } },
    { event_type: 'reviewed', actor: 'validator' },
  ];
  const result = evaluateAutoAccept(job(root, { merge, events, passCount: 2 }), { strictVerify: true, executeVerify: false, acceptAll: true });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'approval_tier_2');
});

test('the owner can turn the tier 0 lane off in the policy file', () => {
  const { root, merge } = landedRepo({ 'docs/guide.md': '# guide\n' });
  fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true, approval_tiers: { tier0: [] } }));
  const result = evaluateAutoAccept(job(root, { merge }), { strictVerify: true, executeVerify: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_agent_certified');
});

test('a job reads its own tier from its recorded merge, and the cheap first look needs a check and a merge', () => {
  const { root, merge } = landedRepo({ 'docs/guide.md': '# guide\n', 'lib/plain.js': 'module.exports = 1;\n' });
  const task = job(root, { merge });
  assert.equal(approvalTierOf(task).tier, 1);
  assert.deepEqual(approvalTierOf(task).paths.sort(), ['docs/guide.md', 'lib/plain.js']);
  assert.equal(mayBeTierZero(task), true);
  assert.equal(mayBeTierZero(job(root)), false, 'no merge recorded');
  assert.equal(mayBeTierZero(job(root, { merge, extra: { verify: '' } })), false, 'no check recorded');
});
