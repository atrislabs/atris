'use strict';

// Approval tiers are decided by what a change touches, never by a model's
// opinion. These pin each rule, the three "never" cases included: an
// unclassifiable change is never tier 0, the builder's own review never counts,
// and the owner's policy can only tighten tiers 1 and 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_APPROVAL_TIERS,
  classifyChange,
  classifyPath,
  globToRegExp,
  hostedChecksGreen,
  independentPassesSinceHandIn,
  mergeCommitScope,
  readApprovalTiers,
  resolveApprovalTiers,
} = require('../lib/approval-tiers');

const tiers = resolveApprovalTiers(null);

test('globs match whole repo paths, with ** crossing folders and * staying in one', () => {
  assert.equal(globToRegExp('docs/**').test('docs/a/b.md'), true);
  assert.equal(globToRegExp('**/*.md').test('README.md'), true);
  assert.equal(globToRegExp('**/*.md').test('a/b/c.md'), true);
  assert.equal(globToRegExp('test/*autoland*').test('test/autoland-tick.test.js'), true);
  assert.equal(globToRegExp('test/*autoland*').test('test/sub/autoland.test.js'), false);
  assert.equal(globToRegExp('lib/a.js').test('lib/a-js'), false);
});

test('docs, notes and tests are tier 0', () => {
  for (const file of ['README.md', 'docs/guide.md', 'atris/wiki/x.md', 'atris/runs/review.md', 'atris/refs/MAP-NOTES.md', 'test/foo.test.js', 'test/fixtures/a.json']) {
    assert.equal(classifyPath(file, tiers).tier, 0, file);
  }
});

test('ordinary code and anything no rule names are tier 1', () => {
  for (const file of ['lib/plain.js', 'commands/feed.js', 'bin/atris.js', 'scripts/build-thing.js', 'Makefile', 'weird/file.xyz']) {
    assert.equal(classifyPath(file, tiers).tier, 1, file);
  }
  assert.equal(classifyPath('weird/file.xyz', tiers).rule, 'unclassified');
});

test('markdown agents obey as instructions is tier 1, not plain docs', () => {
  for (const file of ['CLAUDE.md', 'atris/CLAUDE.md', 'AGENTS.md', 'atris/skills/design/SKILL.md', 'atris/team/navigator/MEMBER.md']) {
    assert.equal(classifyPath(file, tiers).tier, 1, file);
  }
});

test('money, deploy and release, security, sends and the landing machinery are tier 2', () => {
  for (const file of [
    'lib/auto-accept-certified.js', 'lib/approval-tiers.js', 'lib/land-green.js', 'commands/autoland.js', 'lib/task-db.js',
    'atris.md', '.atris/policy/autoland.json', 'package.json', '.github/workflows/ci.yml',
    'lib/billing.js', 'lib/stripe-checkout.js', 'commands/deploy.js', 'lib/release-notes.js', 'lib/secrets.js',
    'lib/gmail-send.js', 'lib/imessage.js', 'test/payments.test.js', 'test/auto-accept-certified.test.js',
  ]) {
    assert.equal(classifyPath(file, tiers).tier, 2, file);
  }
});

test('a doc whose name holds a risky word is judged by its folder, not its name', () => {
  assert.equal(classifyPath('atris/runs/release-notes.md', tiers).tier, 0);
  assert.equal(classifyPath('docs/billing.md', tiers).tier, 0);
});

test('a change takes the highest tier of anything it touches', () => {
  const scope = (paths) => ({ certain: true, source: 'branch', paths });
  assert.equal(classifyChange({ scope: scope(['README.md', 'test/a.test.js']), tiers }).tier, 0);
  assert.equal(classifyChange({ scope: scope(['README.md', 'lib/plain.js']), tiers }).tier, 1);
  assert.equal(classifyChange({ scope: scope(['README.md', 'lib/plain.js', 'lib/auto-accept-certified.js']), tiers }).tier, 2);
});

test('never: a change git cannot read is tier 1 or higher, never 0', () => {
  assert.equal(classifyChange({ scope: { certain: false, source: 'unknown', paths: [] }, tiers }).tier, 1);
  assert.equal(classifyChange({ scope: null, tiers }).tier, 1);
  // Declared paths are the builder's own word: they can raise the tier, never lower it to 0.
  const declaredDocs = classifyChange({ scope: { certain: true, source: 'declared', paths: ['README.md'] }, tiers });
  assert.equal(declaredDocs.tier, 1);
  assert.equal(declaredDocs.reason, 'declared_paths_only');
  const declaredMachinery = classifyChange({ scope: { certain: true, source: 'declared', paths: ['lib/land-green.js'] }, tiers });
  assert.equal(declaredMachinery.tier, 2);
});

test('a protected lane is tier 2 whatever the files are', () => {
  const change = classifyChange({ scope: { certain: true, source: 'branch', paths: ['README.md'] }, tiers, protectedLane: 'billing' });
  assert.equal(change.tier, 2);
});

test('never: the owner policy can tighten tiers 1 and 2 but not loosen them', () => {
  const owned = resolveApprovalTiers({
    approval_tiers: {
      tier2: ['lib/plain.js'],
      tier1: ['docs/rules/**'],
      review_passes: 0,
    },
  });
  assert.equal(classifyPath('lib/plain.js', owned).tier, 2, 'owner added a tier 2 path');
  assert.equal(classifyPath('docs/rules/x.md', owned).tier, 1, 'owner raised a docs folder');
  assert.equal(classifyPath('lib/auto-accept-certified.js', owned).tier, 2, 'defaults still apply');
  assert.equal(owned.review_passes, 1, 'review passes never drop below one');
  const emptied = resolveApprovalTiers({ approval_tiers: { tier2: [], tier2_words: [] } });
  assert.equal(classifyPath('lib/land-green.js', emptied).tier, 2, 'an empty owner list removes nothing');
  assert.equal(classifyPath('lib/billing.js', emptied).tier, 2);
  assert.equal(resolveApprovalTiers({ approval_tiers: { review_passes: 2 } }).review_passes, 2);
  const noFastLane = resolveApprovalTiers({ approval_tiers: { tier0: [] } });
  assert.equal(classifyPath('README.md', noFastLane).tier, 1, 'an empty tier 0 list turns the fast lane off');
});

test('the policy file is read from the workspace, with defaults when it is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tiers-policy-'));
  try {
    assert.deepEqual(readApprovalTiers(root).tier2, [...DEFAULT_APPROVAL_TIERS.tier2]);
    fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true, approval_tiers: { tier2: ['lib/plain.js'] } }));
    assert.equal(classifyPath('lib/plain.js', readApprovalTiers(root)).tier, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('never: the builder own passes never count as review', () => {
  const builderOnly = {
    metadata: { built_by: 'builder' },
    claimed_by: 'builder',
    events: [
      { event_type: 'claimed', actor: 'builder', payload: { claimed_by: 'builder' } },
      { event_type: 'proof_ready', actor: 'builder' },
      { event_type: 'reviewed', actor: 'builder' },
      { event_type: 'proof_ready', actor: 'builder' },
    ],
  };
  assert.equal(independentPassesSinceHandIn(builderOnly), 0);
  const reviewed = { ...builderOnly, events: [...builderOnly.events, { event_type: 'proof_ready', actor: 'autoland-verifier' }] };
  assert.equal(independentPassesSinceHandIn(reviewed), 1);
});

test('a review of an older proof stops counting once the builder hands in again', () => {
  const task = {
    metadata: { built_by: 'builder' },
    events: [
      { event_type: 'proof_ready', actor: 'builder' },
      { event_type: 'reviewed', actor: 'codex-review' },
      { event_type: 'proof_ready', actor: 'builder' },
    ],
  };
  assert.equal(independentPassesSinceHandIn(task), 0);
  task.events.push({ event_type: 'reviewed', actor: 'validator' });
  assert.equal(independentPassesSinceHandIn(task), 1);
});

test('with no builder on record, independence takes two distinct reviewers', () => {
  assert.equal(independentPassesSinceHandIn({ events: [{ event_type: 'reviewed', actor: 'a' }] }), 0);
  assert.equal(independentPassesSinceHandIn({ events: [{ event_type: 'reviewed', actor: 'a' }, { event_type: 'reviewed', actor: 'b' }] }), 1);
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function repoWithMerge(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tiers-git-'));
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 'tiers@example.com');
  git(root, 'config', 'user.name', 'tiers');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'work');
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'work');
  git(root, 'checkout', '-q', 'master');
  git(root, 'merge', '-q', '--no-ff', 'work', '-m', 'merge work');
  const merge = git(root, 'rev-parse', 'HEAD');
  return { root, merge };
}

test('a recorded merge gives the files it brought in, and green means it sits on the target', () => {
  const { root, merge } = repoWithMerge({ 'docs/a.md': 'a\n', 'test/a.test.js': '\n' });
  try {
    const task = { metadata: { merge_commit: merge } };
    assert.deepEqual(mergeCommitScope(task, root).paths.sort(), ['docs/a.md', 'test/a.test.js']);
    assert.equal(classifyChange({ task, scope: null, root, tiers }).tier, 0);
    assert.equal(hostedChecksGreen(task, root, tiers).green, false, 'not on origin yet');
    git(root, 'update-ref', 'refs/remotes/origin/master', merge);
    assert.equal(hostedChecksGreen(task, root, tiers).green, true);
    const strict = resolveApprovalTiers({ approval_tiers: { merge_means_hosted_green: false } });
    assert.equal(hostedChecksGreen(task, root, strict).green, false, 'owner can require a recorded hosted result');
    assert.equal(hostedChecksGreen({ metadata: { hosted_checks: 'green' } }, root, strict).green, true);
    assert.equal(hostedChecksGreen({ metadata: { hosted_checks: 'failure', merge_commit: merge } }, root, tiers).green, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
