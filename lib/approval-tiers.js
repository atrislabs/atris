'use strict';

// Approval tiers: how much checking finished work needs before it is accepted
// without a person. Decided only by what the change touches (its file paths and
// its protected lane), never by a model's opinion.
//
//   tier 0  docs, copy, notes and tests only. Accepted when its done check passes
//           and the hosted checks are green. No review pass is needed.
//   tier 1  ordinary code. One review pass by someone who never built the work,
//           after the builder's latest hand-in, then it is accepted.
//   tier 2  money, billing, deploy and release, security, customer-facing sends
//           and the approval and landing machinery itself. Waits for the owner.
//
// A change takes the highest tier of anything it touches. A change whose files
// cannot be read from git is tier 1 at least, never 0. The builder's own passes
// never count. The defaults below can be tightened in the policy file
// (.atris/policy/autoland.json, key approval_tiers): owner patterns for tier 1
// and tier 2 are added to the defaults, an owner tier 0 list replaces the
// default one, and review_passes can only go up.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const reviewIntegrity = require('./review-integrity');

const DEFAULT_APPROVAL_TIERS = Object.freeze({
  review_passes: 1,
  merge_means_hosted_green: true,
  tier0: Object.freeze([
    'docs/**',
    'atris/MAP.md',
    'atris/refs/**',
    'atris/wiki/**',
    'atris/runs/**',
    'atris/logs/**',
    'atris/features/**',
    'atris/plans/**',
    'atris/research/**',
    'atris/notes/**',
    '**/*.md',
    'test/**',
    'tests/**',
    '**/__tests__/**',
    '**/*.test.js',
    '**/*.test.mjs',
    '**/*.test.cjs',
    '**/*.test.ts',
  ]),
  // Markdown that agents obey as instructions is not plain docs.
  tier1: Object.freeze([
    'CLAUDE.md',
    '**/CLAUDE.md',
    'AGENTS.md',
    '**/AGENTS.md',
    '**/SKILL.md',
    '**/skills/**',
    'atris/team/**',
    'atris/PERSONA.md',
    'atris/atris.md',
    'atris/taste/**',
    'atris/policies/**',
    '**/rules.md',
    '.claude/**',
  ]),
  tier2: Object.freeze([
    // the approval and landing machinery, and its own tests
    'atris.md',
    '.atris/policy/**',
    'lib/approval-tiers.js',
    'lib/auto-accept-certified.js',
    'lib/accept-verify-gate.js',
    'lib/autoland.js',
    'lib/member-autoland.js',
    'commands/autoland.js',
    'lib/land-green.js',
    'lib/landing-proof.js',
    'lib/protected-lane.js',
    'lib/mission-protected-lane.js',
    'lib/review-integrity.js',
    'lib/trust-tiers.js',
    'lib/job-code-verify.js',
    'lib/verify-worktree-rewrite.js',
    'lib/receipt-evidence.js',
    'lib/task-proof.js',
    'lib/skill-eval-gate.js',
    'lib/policy-lessons.js',
    'lib/idle-review-sweep.js',
    'lib/task-db.js',
    'commands/task.js',
    'commands/worktree.js',
    'lib/worktree-core.js',
    'test/*approval-tier*',
    'test/*auto-accept*',
    'test/*autoland*',
    'test/*accept-verify*',
    'test/*land-green*',
    'test/*landing*',
    'test/*protected-lane*',
    'test/*review-integrity*',
    'test/*trust-tier*',
    'test/*skill-eval-gate*',
    // release, deploy and the hosted checks
    'package.json',
    'package-lock.json',
    '.npmignore',
    '.github/**',
    'scripts/ci-*',
    'scripts/release*',
  ]),
  // A code or test file whose name holds one of these words is tier 2 wherever
  // it lives. Docs and notes are judged by their folder instead.
  tier2_words: Object.freeze([
    'billing', 'payment', 'payout', 'stripe', 'wallet', 'invoice', 'checkout', 'pricing', 'price', 'money', 'refund', 'credit',
    'deploy', 'release', 'publish',
    'security', 'secret', 'credential', 'token', 'auth', 'oauth', 'keychain', 'vault', 'password', 'guard', 'sandbox', 'sentinel',
    'email', 'mail', 'gmail', 'imessage', 'sms', 'slack', 'outreach', 'notify', 'send', 'webhook',
  ]),
});

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst']);

function globToRegExp(glob) {
  let out = '';
  const text = String(glob || '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '*') {
      if (text[index + 1] === '*') {
        if (text[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(filePath, patterns) {
  return patterns.find((pattern) => globToRegExp(pattern).test(filePath)) || null;
}

function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : null;
}

// Defaults merged with the owner's policy so the owner can only tighten tiers 1
// and 2. Tier 0 is the owner's own list when one is given (an empty list turns
// the fast lane off).
function resolveApprovalTiers(policy) {
  const owner = policy && typeof policy === 'object' && policy.approval_tiers && typeof policy.approval_tiers === 'object'
    ? policy.approval_tiers
    : {};
  const ownerPasses = Number(owner.review_passes);
  return {
    review_passes: Number.isFinite(ownerPasses) && ownerPasses > DEFAULT_APPROVAL_TIERS.review_passes
      ? Math.floor(ownerPasses)
      : DEFAULT_APPROVAL_TIERS.review_passes,
    merge_means_hosted_green: owner.merge_means_hosted_green === false ? false : DEFAULT_APPROVAL_TIERS.merge_means_hosted_green,
    tier0: stringList(owner.tier0) || [...DEFAULT_APPROVAL_TIERS.tier0],
    tier1: [...new Set([...DEFAULT_APPROVAL_TIERS.tier1, ...(stringList(owner.tier1) || [])])],
    tier2: [...new Set([...DEFAULT_APPROVAL_TIERS.tier2, ...(stringList(owner.tier2) || [])])],
    tier2_words: [...new Set([...DEFAULT_APPROVAL_TIERS.tier2_words, ...(stringList(owner.tier2_words) || []).map((w) => w.toLowerCase())])],
  };
}

function readApprovalTiers(root) {
  let policy = null;
  try {
    policy = JSON.parse(fs.readFileSync(path.join(root || process.cwd(), '.atris', 'policy', 'autoland.json'), 'utf8'));
  } catch {}
  return resolveApprovalTiers(policy);
}

function nameWords(filePath) {
  const base = path.posix.basename(filePath).toLowerCase().replace(/\.[^.]*$/, '');
  return base.split(/[^a-z0-9]+/).filter(Boolean);
}

function wordHit(filePath, words) {
  const tokens = nameWords(filePath);
  for (const word of words) {
    for (const token of tokens) {
      if (token === word || token === `${word}s` || token === `${word}es` || token === `${word}ing` || token === `${word}ment` || token === `${word}ments`) {
        return word;
      }
    }
  }
  return null;
}

// One path's tier and the rule that set it. Anything no rule names is tier 1.
function classifyPath(filePath, tiers = resolveApprovalTiers(null)) {
  const file = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!file) return { path: file, tier: 1, rule: 'unclassified' };
  const tier2 = matchesAny(file, tiers.tier2);
  if (tier2) return { path: file, tier: 2, rule: tier2 };
  if (!DOC_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) {
    const word = wordHit(file, tiers.tier2_words);
    if (word) return { path: file, tier: 2, rule: `word:${word}` };
  }
  const tier1 = matchesAny(file, tiers.tier1);
  if (tier1) return { path: file, tier: 1, rule: tier1 };
  const tier0 = matchesAny(file, tiers.tier0);
  if (tier0) return { path: file, tier: 0, rule: tier0 };
  return { path: file, tier: 1, rule: 'unclassified' };
}

function git(root, args) {
  try {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  } catch {
    return { status: 1, stdout: '' };
  }
}

const COMMIT_RE = /^[0-9a-f]{7,64}$/i;

// The merge commit the job recorded, from either place ready --merge keeps it.
function recordedMergeCommit(task) {
  const metadata = (task && task.metadata) || {};
  const pullRequest = metadata.pull_request && typeof metadata.pull_request === 'object' ? metadata.pull_request : {};
  const sha = String(metadata.merge_commit || pullRequest.merge_commit || '').trim();
  return COMMIT_RE.test(sha) ? sha : null;
}

// The files a recorded merge brought in, read from git: the merge against its
// first parent, or a single commit against its parent. Null when git cannot say.
function mergeCommitScope(task, root) {
  const sha = recordedMergeCommit(task);
  if (!sha) return null;
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]);
  if (parents.status !== 0) return null;
  const ids = String(parents.stdout || '').trim().split(/\s+/).filter(Boolean);
  if (ids.length < 2) return null;
  const names = git(root, ['diff', '--name-only', '-z', `${ids[1]}`, ids[0]]);
  if (names.status !== 0) return null;
  const paths = String(names.stdout || '').split('\0').filter(Boolean);
  if (!paths.length) return null;
  return { sha: ids[0], paths };
}

function landedOnTarget(sha, root) {
  for (const ref of ['origin/master', 'origin/main']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue;
    if (git(root, ['merge-base', '--is-ancestor', sha, ref]).status === 0) return ref;
  }
  return null;
}

// Hosted checks are green when the job says so in a structured field, or when its
// recorded merge sits on the target branch and the owner's policy treats a merge
// there as green (a branch that only takes changes through required checks).
function hostedChecksGreen(task, root, tiers = resolveApprovalTiers(null)) {
  const metadata = (task && task.metadata) || {};
  const recorded = String(metadata.hosted_checks || '').trim().toLowerCase();
  if (['green', 'success', 'passed'].includes(recorded)) return { green: true, source: 'recorded' };
  if (recorded) return { green: false, source: 'recorded', detail: recorded };
  if (!tiers.merge_means_hosted_green) return { green: false, source: 'policy' };
  const sha = recordedMergeCommit(task);
  if (!sha) return { green: false, source: 'no_merge_recorded' };
  const ref = landedOnTarget(sha, root);
  return ref ? { green: true, source: 'merge_on_target', ref } : { green: false, source: 'merge_not_on_target' };
}

// The tier of the whole change. `scope` is what the landing gate already knows
// (declared paths or the branch diff). Only git can lower a change to tier 0:
// declared paths are the builder's own word, so they can raise the tier but never
// make it 0.
function classifyChange({ task, scope, root, tiers, protectedLane }) {
  const resolvedTiers = tiers || readApprovalTiers(root);
  if (protectedLane) {
    return { tier: 2, reason: `protected_lane_${protectedLane}`, source: 'lane', paths: [], rules: [] };
  }
  const gitPaths = new Set();
  const sources = [];
  const declaredPaths = [];
  if (scope && scope.certain && scope.source === 'branch') {
    for (const entry of scope.paths || []) gitPaths.add(entry);
    sources.push('branch');
  } else if (scope && scope.certain && scope.source === 'declared') {
    declaredPaths.push(...(scope.paths || []));
  }
  const merged = mergeCommitScope(task, root);
  if (merged) {
    for (const entry of merged.paths) gitPaths.add(entry);
    sources.push('merge_commit');
  }
  const all = [...new Set([...gitPaths, ...declaredPaths])];
  const rules = all.map((entry) => classifyPath(entry, resolvedTiers));
  const highest = rules.reduce((max, rule) => Math.max(max, rule.tier), -1);
  if (highest === 2) {
    const hit = rules.find((rule) => rule.tier === 2);
    return { tier: 2, reason: 'touches_tier2_path', source: sources.join('+') || 'declared', paths: all, rules, first: hit };
  }
  if (!gitPaths.size) {
    return { tier: 1, reason: declaredPaths.length ? 'declared_paths_only' : 'scope_unknown', source: declaredPaths.length ? 'declared' : 'unknown', paths: all, rules };
  }
  return {
    tier: Math.max(0, highest),
    reason: highest <= 0 ? 'docs_notes_tests_only' : 'ordinary_code',
    source: sources.join('+'),
    paths: all,
    rules,
  };
}

// Review passes that count: actors who never built the job, after the builder's
// latest proof. A pass on an older proof is about work that has since changed.
// With no builder on record at all, independence takes two distinct actors.
function independentPassesSinceHandIn(task) {
  const events = Array.isArray(task && task.events) ? task.events : [];
  const authors = reviewIntegrity.taskAuthors(task);
  const builder = reviewIntegrity.taskBuilder(task);
  if (builder) authors.add(builder);
  const actorOf = (event) => reviewIntegrity.normalizeActor(event.actor || (event.payload && event.payload.actor));
  if (!authors.size) {
    const actors = reviewIntegrity.reviewEventActors(task);
    return actors.size >= 2 ? actors.size - 1 : 0;
  }
  let start = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.event_type === 'proof_ready' && authors.has(actorOf(event))) {
      start = index + 1;
      break;
    }
  }
  const reviewers = new Set();
  for (const event of events.slice(start)) {
    if (!event || !['proof_ready', 'reviewed'].includes(event.event_type)) continue;
    const actor = actorOf(event);
    if (actor && !authors.has(actor)) reviewers.add(actor);
  }
  return reviewers.size;
}

module.exports = {
  DEFAULT_APPROVAL_TIERS,
  classifyChange,
  classifyPath,
  globToRegExp,
  hostedChecksGreen,
  independentPassesSinceHandIn,
  mergeCommitScope,
  readApprovalTiers,
  resolveApprovalTiers,
};
