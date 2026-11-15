'use strict';

// Approval tiers: how much checking finished work needs before it is accepted
// without a person. Decided only by what the change touches (its file paths and
// its protected lane), never by a model's opinion.
//
//   tier 0  docs, copy, notes and tests only. Accepted when its done check passes
//           and the host (GitHub) reports green checks on its merge. No review
//           pass is needed.
//   tier 1  ordinary code. One review pass by someone who never built the work,
//           after the builder's latest hand-in, then it is accepted.
//   tier 2  money, billing, deploy and release, security, customer-facing sends
//           and the approval and landing machinery itself. Waits for the owner.
//
// A change takes the highest tier of anything it touches. The tier is read from
// the job's own change: the commits from where it started (start_commit, stamped
// at claim) to what it handed in (work_commit, stamped at hand-in), and every
// side of the merge that landed it. A commit the builder names is never read on
// its own. A change git cannot read in full is tier 1 at least, never 0. Moved
// files count as deleted and added. Files the package ships to user projects are
// never tier 0. The builder's own passes never count. The defaults below can be tightened in the policy file
// (.atris/policy/autoland.json, key approval_tiers): owner patterns for tier 1
// and tier 2 are added to the defaults, an owner tier 0 list replaces the
// default one, and review_passes can only go up.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const reviewIntegrity = require('./review-integrity');

const DEFAULT_APPROVAL_TIERS = Object.freeze({
  review_passes: 1,
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
    '**/GEMINI.md',
    '**/FOR_AGENTS.md',
    '**/PERSONA.md',
    '**/MEMBER.md',
    '**/SOUL.md',
    '**/START_HERE.md',
    '**/MISSION.md',
    '**/STEERING.md',
    '**/instructions.md',
    '**/atris.md',
    '**/policies/**',
    'templates/**',
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

// Tests are tier 0 whatever their type. Anything else a tier 0 rule names must be
// a doc by its extension, so a script kept under docs/ is code.
const TEST_PATTERNS = Object.freeze(['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*']);

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
    tier0: stringList(owner.tier0) || [...DEFAULT_APPROVAL_TIERS.tier0],
    tier1: [...new Set([...DEFAULT_APPROVAL_TIERS.tier1, ...(stringList(owner.tier1) || [])])],
    tier2: [...new Set([...DEFAULT_APPROVAL_TIERS.tier2, ...(stringList(owner.tier2) || [])])],
    tier2_words: [...new Set([...DEFAULT_APPROVAL_TIERS.tier2_words, ...(stringList(owner.tier2_words) || []).map((w) => w.toLowerCase())])],
  };
}

// The files a project ships (package.json "files"), as globs. They reach user
// projects, so a change to one is never tier 0.
function shippedPatterns(root) {
  let files = null;
  try {
    files = JSON.parse(fs.readFileSync(path.join(root || process.cwd(), 'package.json'), 'utf8')).files;
  } catch {}
  if (!Array.isArray(files)) return [];
  const patterns = [];
  for (const entry of files) {
    const text = String(entry || '').trim().replace(/^\.\//, '').replace(/^\//, '');
    if (!text || text.startsWith('!')) continue;
    if (text.endsWith('/')) {
      patterns.push(`${text}**`);
      continue;
    }
    patterns.push(text);
    if (!/[*?]/.test(text)) patterns.push(`${text}/**`);
  }
  return patterns;
}

function readApprovalTiers(root) {
  let policy = null;
  try {
    policy = JSON.parse(fs.readFileSync(path.join(root || process.cwd(), '.atris', 'policy', 'autoland.json'), 'utf8'));
  } catch {}
  return { ...resolveApprovalTiers(policy), shipped: shippedPatterns(root) };
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
  const shipped = matchesAny(file, tiers.shipped || []);
  if (shipped) return { path: file, tier: 1, rule: `shipped:${shipped}` };
  const tier0 = matchesAny(file, tiers.tier0);
  if (tier0 && (DOC_EXTENSIONS.has(path.posix.extname(file).toLowerCase()) || matchesAny(file, TEST_PATTERNS))) {
    return { path: file, tier: 0, rule: tier0 };
  }
  return { path: file, tier: 1, rule: tier0 ? 'not_a_doc' : 'unclassified' };
}

function git(root, args, timeout = 10000) {
  try {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout });
  } catch {
    return { status: 1, stdout: '' };
  }
}

const COMMIT_RE = /^[0-9a-f]{7,64}$/i;

function commitField(value) {
  const sha = String(value || '').trim();
  return COMMIT_RE.test(sha) ? sha : null;
}

// The merge commit the job recorded, from either place ready --merge keeps it.
function recordedMergeCommit(task) {
  const metadata = (task && task.metadata) || {};
  const pullRequest = metadata.pull_request && typeof metadata.pull_request === 'object' ? metadata.pull_request : {};
  return commitField(metadata.merge_commit || pullRequest.merge_commit);
}

// Where the job started and what it handed in, both stamped by the task store
// (claim and the builder's own ready), never typed by the builder. The start on
// the claim's history entry must agree with the row when both are there.
function recordedJobCommits(task) {
  const metadata = (task && task.metadata) || {};
  const start = commitField(metadata.start_commit);
  const work = commitField(metadata.work_commit);
  const events = Array.isArray(task && task.events) ? task.events : [];
  const claimed = events.find((event) => event && event.event_type === 'claimed' && event.payload && event.payload.start_commit);
  const claimedStart = claimed ? commitField(claimed.payload.start_commit) : null;
  if (claimedStart && start && claimedStart !== start) return { start: null, work, conflict: true };
  return { start: start || claimedStart, work, conflict: false };
}

function fullCommit(root, sha) {
  if (!sha) return null;
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  const full = String(result.stdout || '').trim();
  return result.status === 0 && /^[0-9a-f]{40,64}$/.test(full) ? full : null;
}

// File names in a diff. Renames are off, so a moved file shows as deleted at its
// old path and added at its new one: moving code out of lib/ is still a change to lib/.
function diffNames(root, args) {
  const result = git(root, ['diff', '--no-renames', '--name-only', '-z', ...args]);
  if (result.status !== 0) return null;
  return String(result.stdout || '').split('\0').filter(Boolean);
}

// Every file the recorded merge touches, read against each of its parents. Which
// side is the job's work depends on how the merge was made (a pull request puts
// the branch second, a merge on the branch puts it first), so every side is read.
// This only ever adds paths. Null when git cannot read the commit.
function mergeCommitScope(task, root) {
  const sha = recordedMergeCommit(task);
  if (!sha) return null;
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]);
  if (parents.status !== 0) return null;
  const ids = String(parents.stdout || '').trim().split(/\s+/).filter(Boolean);
  if (ids.length < 2) return null;
  const paths = new Set();
  for (const parent of ids.slice(1)) {
    const names = diffNames(root, [parent, ids[0]]);
    if (!names) return null;
    names.forEach((entry) => paths.add(entry));
  }
  if (!paths.size) return null;
  return { sha: ids[0], parents: ids.slice(1), paths: [...paths] };
}

// The job's own change, read in full: from its start to its hand-in, plus what
// the merge brought onto the target beside the job's work. Certain only when the
// recorded merge is a real merge with the handed-in commit as one of its parents,
// so the merge is this job's landing and not some other commit the builder named.
function landedChangeScope(task, root) {
  const merge = mergeCommitScope(task, root);
  const { start, work, conflict } = recordedJobCommits(task);
  const paths = new Set(merge ? merge.paths : []);
  const fullStart = fullCommit(root, start);
  const fullWork = fullCommit(root, work);
  // The start to hand-in range is read for a job that recorded a merge, the only
  // kind that can reach tier 0. A job with no merge keeps its earlier reading.
  let own = null;
  if (recordedMergeCommit(task) && fullStart && fullWork) {
    own = diffNames(root, [`${fullStart}...${fullWork}`]);
    if (own) own.forEach((entry) => paths.add(entry));
  }
  const why = (() => {
    if (conflict) return 'start_commit_disagrees';
    if (!recordedMergeCommit(task)) return 'no_merge_recorded';
    if (!merge) return 'merge_not_a_merge';
    if (!fullStart) return 'no_start_commit';
    if (!fullWork) return 'no_work_commit';
    if (!own) return 'own_change_unreadable';
    if (!own.length) return 'own_change_empty';
    if (!merge.parents.includes(fullWork)) return 'merge_is_not_this_work';
    return null;
  })();
  return { certain: !why, reason: why || 'read_in_full', sha: merge ? merge.sha : null, paths: [...paths] };
}

function landedOnTarget(sha, root) {
  for (const ref of ['origin/master', 'origin/main']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) continue;
    if (git(root, ['merge-base', '--is-ancestor', sha, ref]).status === 0) return ref;
  }
  return null;
}

function githubRepo(root) {
  const result = git(root, ['remote', 'get-url', 'origin']);
  const url = String(result.stdout || '').trim();
  const match = url.match(/github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return result.status === 0 && match ? `${match[1]}/${match[2]}` : null;
}

function ghJson(root, endpoint) {
  try {
    const result = spawnSync('gh', ['api', endpoint], { cwd: root, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) return null;
    return JSON.parse(String(result.stdout || ''));
  } catch {
    return null;
  }
}

const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

// What the host says about the checks on one commit. Green needs at least one
// check that passed and none failing or still running. No answer is not green.
function hostedCheckResult(sha, root) {
  const repo = githubRepo(root);
  if (!repo) return { green: false, source: 'no_github_remote' };
  const runs = ghJson(root, `repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  const status = ghJson(root, `repos/${repo}/commits/${sha}/status`);
  if (!runs || !Array.isArray(runs.check_runs) || !status) return { green: false, source: 'host_unreadable' };
  const list = runs.check_runs;
  const statuses = Array.isArray(status.statuses) ? status.statuses : [];
  if (Number(runs.total_count || 0) > list.length) return { green: false, source: 'host_too_many_checks' };
  if (!list.length && !statuses.length) return { green: false, source: 'no_hosted_checks' };
  const runsOk = list.every((run) => run && run.status === 'completed' && GREEN_CONCLUSIONS.has(String(run.conclusion || '')));
  const statusesOk = statuses.every((entry) => entry && entry.state === 'success');
  const passed = list.some((run) => run && run.conclusion === 'success') || statuses.some((entry) => entry && entry.state === 'success');
  if (runsOk && statusesOk && passed) return { green: true, source: 'host', checks: list.length + statuses.length };
  return { green: false, source: 'host_not_green' };
}

// Hosted checks are green only when the host reports green checks on the
// recorded merge, and that merge sits on the target branch. A merge on the target
// is not evidence by itself: pushes can skip the checks. The job's own note can
// only say red, never green.
function hostedChecksGreen(task, root) {
  const metadata = (task && task.metadata) || {};
  const recorded = String(metadata.hosted_checks || '').trim().toLowerCase();
  if (recorded && !['green', 'success', 'passed'].includes(recorded)) return { green: false, source: 'recorded', detail: recorded };
  const sha = fullCommit(root, recordedMergeCommit(task));
  if (!sha) return { green: false, source: 'no_merge_recorded' };
  const ref = landedOnTarget(sha, root);
  if (!ref) return { green: false, source: 'merge_not_on_target' };
  return { ...hostedCheckResult(sha, root), ref };
}

const GLOB_CHARS = /[*?[\]{}]/;

// Declared paths the gate could not take as plain workspace paths. A glob is
// matched against the tracked files so it can raise the tier; anything else is
// read as a path for its name. Either way the change cannot be tier 0.
function unreadableDeclaredPaths(raw, root) {
  const values = (Array.isArray(raw) ? raw : []).map((entry) => String(entry || '').trim()).filter(Boolean);
  if (!values.length) return [];
  let tracked = null;
  const out = [];
  for (const value of values) {
    const cleaned = value.replace(/\\/g, '/').replace(/^['"`]|['"`]$/g, '').replace(/^(?:\.\.?\/)+/, '');
    if (GLOB_CHARS.test(cleaned)) {
      if (!tracked) {
        const listed = git(root, ['ls-files', '-z']);
        tracked = listed.status === 0 ? String(listed.stdout || '').split('\0').filter(Boolean) : [];
      }
      const matcher = globToRegExp(cleaned);
      out.push(...tracked.filter((file) => matcher.test(file)));
    }
    if (cleaned) out.push(cleaned);
  }
  return [...new Set(out)];
}

// The tier of the whole change. `scope` is what the landing gate already knows
// (declared paths or the branch diff). Only git can lower a change to tier 0, and
// only when it reads the job's own change in full: the branch, or the start to
// hand-in range together with its merge. Declared paths are the builder's own
// word, so they can raise the tier but never make it 0, and one the gate cannot
// read keeps the change at tier 1 or higher.
function classifyChange({ task, scope, root, tiers, protectedLane }) {
  const resolvedTiers = tiers || readApprovalTiers(root);
  if (protectedLane) {
    return { tier: 2, reason: `protected_lane_${protectedLane}`, source: 'lane', paths: [], rules: [], landed: false };
  }
  const readPaths = new Set();
  const sources = [];
  const declaredPaths = [];
  let fullRead = false;
  let floor = 0;
  if (scope && scope.certain && scope.source === 'branch') {
    const names = Array.isArray(scope.paths_no_renames) ? scope.paths_no_renames : scope.paths || [];
    for (const entry of names) readPaths.add(entry);
    sources.push('branch');
    fullRead = readPaths.size > 0;
  } else if (scope && scope.certain && scope.source === 'declared') {
    declaredPaths.push(...(scope.paths || []));
  } else if (scope && !scope.certain && scope.source === 'declared') {
    declaredPaths.push(...unreadableDeclaredPaths(scope.raw, root || scope.root || process.cwd()));
    floor = 1;
  }
  const landed = task && root ? landedChangeScope(task, root) : null;
  if (landed && landed.paths.length) {
    for (const entry of landed.paths) readPaths.add(entry);
    sources.push(landed.certain ? 'landed' : 'merge_commit');
  }
  if (landed && landed.certain) fullRead = true;
  const all = [...new Set([...readPaths, ...declaredPaths])];
  const rules = all.map((entry) => classifyPath(entry, resolvedTiers));
  const highest = rules.reduce((max, rule) => Math.max(max, rule.tier), -1);
  const landedCertain = Boolean(landed && landed.certain);
  if (highest === 2) {
    const hit = rules.find((rule) => rule.tier === 2);
    return { tier: 2, reason: 'touches_tier2_path', source: sources.join('+') || 'declared', paths: all, rules, first: hit, landed: landedCertain };
  }
  if (!fullRead || floor > 0) {
    const reason = floor > 0
      ? 'declared_paths_unreadable'
      : declaredPaths.length && !readPaths.size ? 'declared_paths_only'
        : readPaths.size ? `own_change_not_read_in_full:${landed ? landed.reason : 'unknown'}` : 'scope_unknown';
    return { tier: 1, reason, source: sources.join('+') || (declaredPaths.length ? 'declared' : 'unknown'), paths: all, rules, landed: landedCertain };
  }
  return {
    tier: Math.max(0, highest),
    reason: highest <= 0 ? 'docs_notes_tests_only' : 'ordinary_code',
    source: sources.join('+'),
    paths: all,
    rules,
    landed: landedCertain,
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
