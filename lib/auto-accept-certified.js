'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { taskProofState, taskProofExecutionState } = require('./task-proof');
const { extractReceiptEvidence } = require('./receipt-evidence');
const reviewIntegrity = require('./review-integrity');
const { computeTrustTier } = require('./trust-tiers');
const { policyLessonsForFiles, readPolicyLessons } = require('./policy-lessons');
const { skillEvalGate } = require('./skill-eval-gate');

const AGENT_CERTIFICATION_REVIEW_PASSES = 2;

// Verifier wall clock. The old flat 120s ceiling was measured against this
// workspace's real suites: the largest single test file needs ~123s and
// `npm run test` needs ~268s, so honest full-suite proofs could never land.
// Default is now 10 minutes with an ATRIS_VERIFY_TIMEOUT_MS override; agents
// should still prefer fast single-file verifiers, but a slow honest check
// must time out as "too slow", never silently fail as "unproven".
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
function verifyTimeoutMs() {
  const raw = Number(process.env.ATRIS_VERIFY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60 * 60 * 1000) : DEFAULT_VERIFY_TIMEOUT_MS;
}
// Kept for compat with older callers/tests; the pass-count landing lane it
// once powered is gone. Passes alone never land work, an independent
// reviewer does.
const AUTO_ACCEPT_HIGH_CONFIDENCE_PASSES = 3;
const DENIED_TAGS = new Set(['billing', 'money', 'payments', 'deploy', 'feedback', 'security', 'customer', 'external']);

const SIMPLE_VERIFY_TOKEN_RE = /^[a-zA-Z0-9_./:@=+-]+$/;
const GIT_WORKTREE_PATH_RE = /^[a-zA-Z0-9_./@=+-]+$/;
const GIT_REV_TOKEN_RE = /^[a-zA-Z0-9_./@=+~^-]+$/;
const SAFE_RELATIVE_PATH_RE = /^[a-zA-Z0-9_./-]+$/;
const SAFE_ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_ENV_VALUE_RE = /^[A-Za-z0-9._/:-]*$/;
const PYTHON_SHORT_FLAG_RE = /^-[a-zA-Z-]+$/;
const PYTHON_LONG_FLAG_RE = /^--[a-zA-Z-]+(?:=[A-Za-z0-9._:-]+)?$/;
const NODE_TEST_PATTERN_RE = /^[A-Za-z0-9 _.,:!?@#%&=+|()[\]{}*^$~\\/-]+$/;

function hasUnsafePathSegment(token) {
  const text = String(token || '');
  return text.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(text)
    || text.split(/[\\/]+/).includes('..');
}

function safeVerifyToken(token) {
  return SIMPLE_VERIFY_TOKEN_RE.test(token) && !hasUnsafePathSegment(token);
}

function safeRelativePathToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && !text.startsWith('-')
    && !text.includes(':')
    && safeVerifyToken(text);
}

function safeGitWorktreePathToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && !text.startsWith('-')
    && !text.includes(':')
    && GIT_WORKTREE_PATH_RE.test(text)
    && !text.split(/[\\/]+/).includes('..');
}

function safeGitRevToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && !text.startsWith('-')
    && !text.includes(':')
    && GIT_REV_TOKEN_RE.test(text)
    && !text.split(/[\\/]+/).includes('..');
}

function safeNodePathArgs(args) {
  return args.every(token => safeRelativePathToken(token));
}

function safeCdPathToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && !text.startsWith('-')
    && !text.includes(':')
    && SAFE_RELATIVE_PATH_RE.test(text)
    && !hasUnsafePathSegment(text);
}

function safePythonPathToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && SAFE_RELATIVE_PATH_RE.test(text)
    && !/^[a-zA-Z]:[\\/]/.test(text);
}

function safePythonBinaryToken(token) {
  const text = String(token || '');
  return text === 'python'
    || text === 'python3'
    || (safePythonPathToken(text) && /(^|\/)venv\/bin\/python3?$/.test(text));
}

function safePythonRelativePathToken(token) {
  const text = String(token || '');
  return Boolean(text)
    && !text.startsWith('-')
    && !text.includes(':')
    && SAFE_RELATIVE_PATH_RE.test(text)
    && !hasUnsafePathSegment(text);
}

function safePythonFlagToken(token) {
  const text = String(token || '');
  return PYTHON_SHORT_FLAG_RE.test(text) || PYTHON_LONG_FLAG_RE.test(text);
}

function safePytestArg(token) {
  return safePythonRelativePathToken(token) || safePythonFlagToken(token);
}

function safePythonScriptPath(token) {
  const text = String(token || '');
  return text.startsWith('scripts/')
    && text.endsWith('.py')
    && safePythonRelativePathToken(text);
}

function safePythonScriptArg(token) {
  return safePythonRelativePathToken(token) || safePythonFlagToken(token);
}

function safeNodeTestArgs(args) {
  let expectPattern = false;
  for (const token of args) {
    if (expectPattern) {
      if (!NODE_TEST_PATTERN_RE.test(token) || token.length > 500) return false;
      expectPattern = false;
      continue;
    }
    if (token === '--test-name-pattern') {
      expectPattern = true;
      continue;
    }
    if (String(token || '').startsWith('--test-name-pattern=')) {
      const pattern = String(token).slice('--test-name-pattern='.length);
      if (!pattern || !NODE_TEST_PATTERN_RE.test(pattern) || pattern.length > 500) return false;
      continue;
    }
    if (!safeRelativePathToken(token)) return false;
  }
  return !expectPattern;
}

function safeGitDiffCheckArgs(args) {
  return args.length === 0 || (args.length <= 2 && args.every(safeGitRevToken));
}

function isAllowedGitDiffCheck(argv) {
  const [bin, first, second, third, fourth] = argv;
  if (bin !== 'git') return false;
  if (first === 'diff' && second === '--check') {
    return safeGitDiffCheckArgs(argv.slice(3));
  }
  if (first === '-C' && safeGitWorktreePathToken(second) && third === 'diff' && fourth === '--check') {
    return safeGitDiffCheckArgs(argv.slice(5));
  }
  return false;
}

function isAllowedAtrisCleanDryRun(argv) {
  return argv.length === 5
    && argv[0] === 'node'
    && argv[1] === 'bin/atris.js'
    && argv[2] === 'clean'
    && argv[3] === '--dry-run'
    && argv[4] === '--json';
}

// `atris verify artifact <path>` is read-only by contract: it reads one file
// and prints substance checks. Allow the path plus numeric/json flags only;
// quoted --objective text stays outside the strict re-execution allowlist.
function isAllowedAtrisVerifyArtifact(argv) {
  let rest = null;
  if (argv[0] === 'atris' && argv[1] === 'verify' && argv[2] === 'artifact') rest = argv.slice(3);
  if (argv[0] === 'node' && argv[1] === 'bin/atris.js' && argv[2] === 'verify' && argv[3] === 'artifact') rest = argv.slice(4);
  if (!rest || !rest.length || !safeRelativePathToken(rest[0])) return false;
  let index = 1;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--json') { index += 1; continue; }
    if ((token === '--min-lines' || token === '--max-age-hours') && /^\d{1,6}$/.test(rest[index + 1] || '')) {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

function isInsidePath(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function parentArenaDir(workspace) {
  let cursor = path.resolve(workspace);
  while (cursor && cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'arena') return cursor;
    cursor = path.dirname(cursor);
  }
  return path.dirname(path.resolve(workspace));
}

function validateCommandCwd(parsed, workspaceRoot) {
  const workspace = path.resolve(workspaceRoot || process.cwd());
  if (!parsed.cwd) return { ok: true, cwd: workspace };
  const target = path.resolve(workspace, parsed.cwd);
  if (!isInsidePath(target, workspace)) return { ok: false, reason: 'verify_command_not_allowed' };
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { ok: false, reason: 'verify_workdir_missing' };
    }
  } catch {
    return { ok: false, reason: 'verify_workdir_missing' };
  }
  return { ok: true, cwd: target };
}

function validateGitWorktreePath(argv, workspaceRoot, commandCwd) {
  if (!(argv[0] === 'git' && argv[1] === '-C')) return { ok: true };
  const workspace = path.resolve(workspaceRoot || process.cwd());
  const target = path.resolve(commandCwd || workspace, argv[2]);
  const allowedRoot = path.dirname(workspace);
  if (!isInsidePath(target, workspace) && !isInsidePath(target, allowedRoot)) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  if (!fs.existsSync(target)) return { ok: false, reason: 'verify_worktree_missing' };
  return { ok: true };
}

function validatePythonBinaryPath(argv, workspaceRoot, commandCwd) {
  const bin = argv[0];
  if (bin === 'python' || bin === 'python3' || !safePythonBinaryToken(bin)) return { ok: true };
  const workspace = path.resolve(workspaceRoot || process.cwd());
  const target = path.resolve(commandCwd || workspace, bin);
  const allowedRoot = parentArenaDir(workspace);
  if (!isInsidePath(target, workspace) && !isInsidePath(target, allowedRoot)) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  return { ok: true };
}

function reviewPassCount(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  const count = Number(metadata.agent_review_pass_count ?? review.agent_review_pass_count);
  return Number.isFinite(count) ? count : 0;
}

function isAgentCertified(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  const handoff = review.handoff && typeof review.handoff === 'object' ? review.handoff : {};
  return metadata.agent_certified === true
    || review.agent_certified === true
    || handoff.native_goal_status === 'agent_certified'
    || reviewPassCount(task) >= AGENT_CERTIFICATION_REVIEW_PASSES;
}

function latestProof(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  return String(metadata.latest_agent_proof || review.proof || '').trim();
}

function proofSentences(proof) {
  return String(proof || '')
    .replace(/([.!?])\s+/g, '$1\n')
    .split(/[\n\r]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function sentenceHasPullRequestReference(sentence) {
  return /\bPR\s*#?\d+\b/i.test(sentence)
    || /\bpull request\s*#?\d+\b/i.test(sentence)
    || /\bgithub\.com\/\S+\/pull\/\d+\b/i.test(sentence)
    || /#\d+\b/.test(sentence);
}

function sentenceHasUnmergedPullRequestBoundary(sentence) {
  return sentenceHasPullRequestReference(sentence)
    && (/\bopen\s+draft\b/i.test(sentence)
      || /\bopen\/draft\b/i.test(sentence)
      || /\bopen\s+and\s+draft\s*=\s*true\b/i.test(sentence)
      || /\bdraft\s*=\s*true\b/i.test(sentence)
      || /\bisDraft\s*[:=]\s*true\b/i.test(sentence)
      || /\bmergedAt\s*[:=]\s*null\b/i.test(sentence)
      || /\bclosed\s+(?:with\s+)?mergedAt\s*[:=]\s*null\b/i.test(sentence));
}

function proofHasUnmergedPullRequestBoundary(proof) {
  return proofSentences(proof).some(sentenceHasUnmergedPullRequestBoundary);
}

function unmergedPullRequestBoundaryResult(ref, proof) {
  return {
    eligible: false,
    ref,
    reason: 'proof_unmerged_or_draft_pr_boundary',
    next_action: 'revise the task out of Review or narrow the proof to draft/local-proof only before auto-accept',
    proof,
  };
}

function distinctReviewActors(task) {
  return reviewIntegrity.reviewEventActors(task);
}

function parseCdPrefix(cmd) {
  const match = cmd.match(/^cd\s+(\S+)\s+&&\s+(.+)$/);
  if (!match) return { ok: true, command: cmd };
  const cwd = match[1];
  const command = String(match[2] || '').trim();
  if (!safeCdPathToken(cwd) || !command) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  return { ok: true, cwd, command };
}

function parseLeadingEnv(tokens) {
  const env = {};
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const equals = token.indexOf('=');
    if (equals <= 0) break;
    const key = token.slice(0, equals);
    const value = token.slice(equals + 1);
    if (!SAFE_ENV_KEY_RE.test(key) || !SAFE_ENV_VALUE_RE.test(value)) {
      return { ok: false, reason: 'verify_command_not_allowed' };
    }
    env[key] = value;
    index += 1;
  }
  return { ok: true, env, argv: tokens.slice(index) };
}

function safeVerifyArgv(argv) {
  if (argv[0] === 'node' && argv[1] === '--test') {
    return safeNodeTestArgs(argv.slice(2));
  }
  return argv.every((token, index) => {
    if (safePythonBinaryToken(argv[0]) && index === 0) return true;
    if (argv[0] === 'git' && argv[1] === '-C' && index === 2) {
      return safeGitWorktreePathToken(token);
    }
    if (argv[0] === 'git' && ['diff', '-C'].includes(argv[1]) && index >= (argv[1] === '-C' ? 5 : 3)) {
      return safeGitRevToken(token);
    }
    return safeVerifyToken(token);
  });
}

// Parse enough shell quoting to recover direct argv without ever invoking a
// shell. Operators are rejected outside quotes; quoted test-name regexes are
// passed as one literal argument to spawnSync({ shell: false }).
function tokenizeVerifyCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  const flush = () => {
    if (!started) return;
    tokens.push(current);
    current = '';
    started = false;
  };
  for (const char of String(command || '')) {
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\n' || char === '\r') return { ok: false, reason: 'verify_command_not_allowed' };
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (/[;&|`$<>\\]/.test(char)) return { ok: false, reason: 'verify_command_not_allowed' };
    current += char;
    started = true;
  }
  if (quote) return { ok: false, reason: 'verify_command_not_allowed' };
  flush();
  return { ok: true, tokens };
}

function isAllowedPythonCommand(argv) {
  const [bin, first, second] = argv;
  if (!safePythonBinaryToken(bin)) return false;
  if (first === '-m' && second === 'pytest') {
    return argv.slice(3).every(safePytestArg);
  }
  if (safePythonScriptPath(first)) {
    return argv.slice(2).every(safePythonScriptArg);
  }
  return false;
}

function parseVerifyCommand(verify) {
  const cmd = String(verify || '').trim();
  if (!cmd) return { ok: false, reason: 'no_verify_command' };
  const prefixed = parseCdPrefix(cmd);
  if (!prefixed.ok) return prefixed;
  const tokenized = tokenizeVerifyCommand(prefixed.command);
  if (!tokenized.ok) return tokenized;
  const envParsed = parseLeadingEnv(tokenized.tokens);
  if (!envParsed.ok) return envParsed;
  const argv = envParsed.argv;
  if (!argv.length || !safeVerifyArgv(argv)) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  const [bin, first, second] = argv;
  const allowed = (bin === 'npm' && (
    (first === 'test' && argv.length === 2)
    || (first === 'run' && Boolean(second) && !second.startsWith('-') && argv.length === 3)
  ))
    || (bin === 'node' && (
      (first === '--test' && safeNodeTestArgs(argv.slice(2)))
      || (first === '--check' && argv.length === 3 && safeRelativePathToken(second))
      || (/^scripts\/[a-zA-Z0-9_./-]+$/.test(first || '') && safeNodePathArgs(argv.slice(1)))
    ))
    || (bin === 'tsc' && argv.length === 1)
    // Mission verifiers use `test -s <artifact>`; accept the read-only
    // file-check shapes so honest verifiers are recordable at review time.
    || (bin === 'test' && argv.length === 3 && (first === '-s' || first === '-f') && safeRelativePathToken(second))
    || isAllowedAtrisCleanDryRun(argv)
    || isAllowedAtrisVerifyArtifact(argv)
    || isAllowedGitDiffCheck(argv)
    || isAllowedPythonCommand(argv);
  if (!allowed) return { ok: false, reason: 'verify_command_not_allowed' };
  return {
    ok: true,
    argv,
    ...(prefixed.cwd ? { cwd: prefixed.cwd } : {}),
    ...(Object.keys(envParsed.env).length ? { env: envParsed.env } : {}),
  };
}

function isAutoCertifyVerifyCommandAllowed(verify) {
  return parseVerifyCommand(verify).ok;
}

// Re-entrancy guard: every verify child carries ATRIS_VERIFY_IN_PROGRESS=1
// (see verifyCommandEnv). A verify that shells back into the CLI and reaches
// another verify would otherwise recurse without bound — that cycle
// fork-bombed the fleet on 2026-07-29 when a stored pytest called
// `atris task status` and the read path re-ran the verify. Refuse loudly.
const VERIFY_IN_PROGRESS_ENV = 'ATRIS_VERIFY_IN_PROGRESS';

// Spawn cap: a single CLI process has no legitimate reason to run dozens of
// verifies. Beyond the cap something is looping; refuse and report instead
// of silently bounding.
const VERIFY_SPAWN_CAP = 25;
let verifySpawnCount = 0;

function verifyRefusal(unrunnableCause, extra) {
  return {
    ok: false,
    reason: 'verify_unrunnable',
    unrunnable_cause: unrunnableCause,
    alarm: true,
    ...(extra || {}),
  };
}

function runVerifyCommand(verify, workspaceRoot) {
  if (process.env[VERIFY_IN_PROGRESS_ENV]) {
    return verifyRefusal('verify_reentrant', {
      detail: `${VERIFY_IN_PROGRESS_ENV} is set: a verify is already running up the call chain; refusing to nest another one`,
    });
  }
  if (verifySpawnCount >= VERIFY_SPAWN_CAP) {
    return verifyRefusal('verify_spawn_cap', {
      detail: `this process already ran ${verifySpawnCount} verifies (cap ${VERIFY_SPAWN_CAP}); refusing more`,
    });
  }
  verifySpawnCount += 1;
  const parsed = parseVerifyCommand(verify);
  if (!parsed.ok) return parsed;
  const cwdCheck = validateCommandCwd(parsed, workspaceRoot);
  if (!cwdCheck.ok) return cwdCheck;
  const gitPathCheck = validateGitWorktreePath(parsed.argv, workspaceRoot, cwdCheck.cwd);
  if (!gitPathCheck.ok) return gitPathCheck;
  const pythonPathCheck = validatePythonBinaryPath(parsed.argv, workspaceRoot, cwdCheck.cwd);
  if (!pythonPathCheck.ok) return pythonPathCheck;
  const result = spawnSync(parsed.argv[0], parsed.argv.slice(1), {
    cwd: cwdCheck.cwd,
    env: verifyCommandEnv(parsed.env),
    shell: false,
    encoding: 'utf8',
    timeout: verifyTimeoutMs(),
  });
  // "I could not run the check" is not "the check failed". Collapsing the two
  // let a broken harness read as broken code: under cron's PATH every
  // `npm run ...` verifier returned ENOENT, mapped to verify_failed, and 16
  // landable tasks were skipped silently every hour for 20 days. A verifier
  // the harness cannot execute must be loud and must never look like a
  // verdict on the work.
  const unrunnable = unrunnableVerifyReason(result);
  if (unrunnable) {
    return {
      ok: false,
      reason: 'verify_unrunnable',
      unrunnable_cause: unrunnable,
      alarm: true,
      command: parsed.argv.join(' '),
      status: result.status,
      stderr: String(result.stderr || '').slice(0, 400),
    };
  }
  return {
    ok: result.status === 0,
    reason: result.status === 0 ? 'verify_passed' : 'verify_failed',
    status: result.status,
    stderr: String(result.stderr || '').slice(0, 400),
  };
}

// Verifiers run with shell:false, so the child gets no PATH resolution beyond
// whatever the parent inherited. Cron has no Homebrew PATH — that is why every
// cron entry hardcodes an absolute node path. `npm`, `npx` and friends live in
// the same bin directory as the node binary currently executing, so seeding
// PATH with it makes recorded checks runnable from cron with zero config: no
// crontab PATH line to keep in sync, no new env var.
function verifyCommandEnv(extraEnv) {
  const base = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
  const binDir = path.dirname(process.execPath);
  const current = String(base.PATH || '');
  const alreadyPresent = current.split(path.delimiter).includes(binDir);
  if (binDir && !alreadyPresent) {
    base.PATH = current ? `${binDir}${path.delimiter}${current}` : binDir;
  }
  base[VERIFY_IN_PROGRESS_ENV] = '1';
  // A verifier that inherits a test-runner context joins the outer runner as
  // a child and reports instant exit 0 without running anything. Strip it so
  // recorded checks are real runs, not phantom passes.
  delete base.NODE_TEST_CONTEXT;
  return base;
}

// ENOENT: the binary is not on PATH at all. ETIMEDOUT: the verify ceiling cut
// it off before it could reach a verdict. Neither is evidence about the diff.
function unrunnableVerifyReason(result) {
  const code = result && result.error ? result.error.code : null;
  if (code === 'ENOENT') return 'command_not_found';
  if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') return 'verify_timed_out';
  if (code) return String(code).toLowerCase();
  // spawnSync reports a null status with no error object when the child was
  // killed outright; treat that as unrunnable rather than a silent failure.
  if (result && result.status === null) return 'no_exit_status';
  return null;
}

function runVerifyCommandCached(verify, workspaceRoot, cache = null) {
  if (!(cache instanceof Map)) return runVerifyCommand(verify, workspaceRoot);
  const key = `${path.resolve(workspaceRoot || process.cwd())}\u0000${String(verify || '').trim()}`;
  if (cache.has(key)) return { ...cache.get(key), reused: true };
  const result = runVerifyCommand(verify, workspaceRoot);
  cache.set(key, result);
  return { ...result, reused: false };
}

// Pre-land hygiene: dead exports used to surface only AFTER landing, when the
// full suite's repo-hygiene ratchet went red on master (lesson:
// engine-dead-exports — engines export every internal helper, the task's own
// verify command stays green, and the breakage lands). In repos that carry the
// ratchet (test/repo-hygiene.test.js), run the same detector before landing so
// the gate refuses the work instead of master discovering it. Memoized per
// root: one scan covers every task in a sweep.
const repoHygieneCache = new Map();

function repoHygieneGate(workspaceRoot) {
  const root = path.resolve(workspaceRoot || process.cwd());
  // Skill receipts are mutable workspace state, so recompute this gate before
  // consulting the repo-wide dead-code cache. A new receipt can unblock a
  // landing, while a later SKILL.md edit must make an older receipt stale.
  const skillEval = skillEvalGate(root);
  if (!skillEval.ok) return skillEval;
  if (repoHygieneCache.has(root)) return repoHygieneCache.get(root);
  let result = { ok: true, skipped: true };
  if (fs.existsSync(path.join(root, 'test', 'repo-hygiene.test.js'))) {
    try {
      const { findDeadCode, findOrphanedExports, listJsFiles } = require('../commands/slop');
      const dead = findDeadCode(root).dead;
      const files = ['commands', 'lib'].flatMap((d) => listJsFiles(path.join(root, d)));
      const orphans = findOrphanedExports(root, files, listJsFiles(root));
      const offenders = [
        ...dead.map((f) => path.relative(root, f)),
        ...orphans.map((o) => `${path.relative(root, o.file)} → ${o.name}`),
      ];
      result = offenders.length
        ? {
          ok: false,
          reason: 'dead_exports',
          offenders: offenders.slice(0, 12),
          message: 'this work leaves code or exports nothing uses, so the full test suite fails right after landing; delete the unused pieces and land again.',
        }
        : { ok: true };
    } catch (err) {
      // "I could not run the detector" is not a verdict on the work — same
      // rule as verify_unrunnable, but hygiene is a repo-wide ratchet the
      // suite still enforces, so failing open here only delays the red.
      result = { ok: true, skipped: true, error: String((err && err.message) || err).slice(0, 200) };
    }
  }
  repoHygieneCache.set(root, result);
  return result;
}

// Shared by both landing lanes so the check cannot ship in one dispatch branch
// and silently skip the sibling (lesson: parallel-paths-drift).
function hygieneBlockResult(task, ref) {
  const hygiene = repoHygieneGate(task.workspace_root || process.cwd());
  if (hygiene.ok) return null;
  return {
    eligible: false,
    ref,
    reason: hygiene.reason,
    message: hygiene.message,
    offenders: hygiene.offenders,
    next_action: hygiene.next_action
      || 'run `node --test test/repo-hygiene.test.js` in the workspace, delete what it names, then re-certify',
  };
}

const CANDIDATE_PATH_KEYS = [
  'files',
  'paths',
  'touched_files',
  'touchedFiles',
  'changed_files',
  'changedFiles',
  'modified_files',
  'modifiedFiles',
  'artifacts',
  'artifact_paths',
  'artifactPaths',
];

function candidatePathValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(candidatePathValues);
  if (typeof value === 'object') {
    for (const key of ['path', 'file', 'filename']) {
      if (typeof value[key] === 'string') return [value[key]];
    }
    return [];
  }
  if (typeof value !== 'string') return [];
  return value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function declaredCandidatePathValues(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const review = task && task.review && typeof task.review === 'object' ? task.review : {};
  const sources = [
    metadata,
    metadata.diff_stats,
    metadata.diffStats,
    metadata.git_diff_stats,
    metadata.gitDiffStats,
    metadata.change_stats,
    metadata.changeStats,
    metadata.result_trace,
    review.result,
    review.result_trace,
  ].filter((source) => source && typeof source === 'object');
  const values = [];
  for (const source of sources) {
    for (const key of CANDIDATE_PATH_KEYS) values.push(...candidatePathValues(source[key]));
  }
  for (const event of Array.isArray(task && task.events) ? task.events : []) {
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    const trace = payload.result_trace && typeof payload.result_trace === 'object' ? payload.result_trace : null;
    if (!trace) continue;
    for (const key of CANDIDATE_PATH_KEYS) values.push(...candidatePathValues(trace[key]));
  }
  return [...new Set(values)];
}

function candidateWorkspaceRoot(task) {
  const workspace = path.resolve(task.workspace_root || process.cwd());
  const metadata = task.metadata || {};
  const declared = metadata.worktree_path
    || metadata.worktreePath
    || metadata.worktree?.path
    || task.worktree_path
    || task.worktree?.path;
  if (!declared) return workspace;
  const target = path.resolve(String(declared));
  const allowedRoot = parentArenaDir(workspace);
  try {
    if (isInsidePath(target, allowedRoot) && fs.statSync(target).isDirectory()) return target;
  } catch {}
  return workspace;
}

function normalizeCandidatePath(value, root) {
  const text = String(value || '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!text || text === '.' || text.includes('://') || /[*?\[\]{}]/.test(text)) return null;
  const absolute = path.resolve(root, text);
  if (!isInsidePath(absolute, root)) return null;
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative === '.') return null;
  if (!relative.includes('/') && !path.extname(relative) && !fs.existsSync(absolute)) return null;
  return relative;
}

function safeCandidateRef(value) {
  const text = String(value || '').trim();
  return safeGitRevToken(text) ? text : null;
}

function candidateGit(root, args) {
  try {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function mergeChangedLineMaps(target, source) {
  for (const [file, lines] of source) {
    const merged = target.get(file) || new Set();
    for (const line of lines) merged.add(line);
    target.set(file, merged);
  }
}

function declaredCandidateChangedLines(root, declaredPaths) {
  const repoCheck = candidateGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (repoCheck.status !== 0 || String(repoCheck.stdout).trim() !== 'true') return null;
  const { gitChangedLines } = require('../commands/slop');
  const changedPaths = new Set();
  const changedLines = new Map();
  const addDiff = (args, lines) => {
    const names = candidateGit(root, args);
    if (names.status !== 0) return;
    String(names.stdout || '').split('\0').filter(Boolean)
      .map((entry) => normalizeCandidatePath(entry, root))
      .filter(Boolean)
      .forEach((entry) => changedPaths.add(entry));
    mergeChangedLineMaps(changedLines, lines);
  };
  addDiff(['diff', '--name-only', '-z'], gitChangedLines(false, root));
  addDiff(['diff', '--cached', '--name-only', '-z'], gitChangedLines(true, root));
  for (const base of ['origin/master', 'origin/main', 'master', 'main']) {
    const baseResult = candidateGit(root, ['rev-parse', base]);
    const headResult = candidateGit(root, ['rev-parse', 'HEAD']);
    if (baseResult.status !== 0 || headResult.status !== 0) continue;
    if (String(baseResult.stdout).trim() === String(headResult.stdout).trim()) break;
    const range = `${base}...HEAD`;
    addDiff(['diff', '--name-only', '-z', range], gitChangedLines(false, root, range));
    break;
  }
  const pathIsChanged = (declaredPath) => [...changedPaths]
    .some((changedPath) => changedPath === declaredPath || changedPath.startsWith(`${declaredPath}/`));
  return declaredPaths.every(pathIsChanged) ? changedLines : null;
}

function candidateBranchScope(task, root) {
  const metadata = task.metadata || {};
  const branch = safeCandidateRef(
    metadata.branch
      || metadata.worktree_branch
      || metadata.git_branch
      || metadata.pr_branch
      || metadata.head_branch
      || metadata.worktree?.branch,
  );
  if (!branch) return null;
  const base = safeCandidateRef(
    metadata.base
      || metadata.base_ref
      || metadata.target_ref
      || metadata.target_branch
      || metadata.worktree?.base,
  );
  if (!base) return { certain: false, source: 'branch', paths: [], detail: 'candidate branch has no exact base ref' };
  const headResult = candidateGit(root, ['rev-parse', 'HEAD']);
  const branchResult = candidateGit(root, ['rev-parse', branch]);
  if (headResult.status !== 0 || branchResult.status !== 0) {
    return { certain: false, source: 'branch', paths: [], detail: 'candidate branch ref is unavailable' };
  }
  if (String(headResult.stdout).trim() !== String(branchResult.stdout).trim()) {
    return { certain: false, source: 'branch', paths: [], detail: 'candidate branch content is not checked out here' };
  }
  const names = candidateGit(root, ['diff', '--name-only', '-z', `${base}...${branch}`]);
  if (names.status !== 0) {
    return { certain: false, source: 'branch', paths: [], detail: 'candidate branch diff is unavailable' };
  }
  const paths = String(names.stdout || '').split('\0').filter(Boolean);
  const normalized = paths.map((entry) => normalizeCandidatePath(entry, root));
  if (normalized.some((entry) => !entry)) {
    return { certain: false, source: 'branch', paths: [], detail: 'candidate branch diff contains an unsafe path' };
  }
  const { gitChangedLines } = require('../commands/slop');
  return {
    certain: true,
    source: 'branch',
    paths: [...new Set(normalized)],
    changed_lines: gitChangedLines(false, root, `${base}...${branch}`),
  };
}

function candidateTouchedScope(task) {
  const root = candidateWorkspaceRoot(task);
  const declared = declaredCandidatePathValues(task);
  if (declared.length) {
    const normalized = declared.map((entry) => normalizeCandidatePath(entry, root));
    if (normalized.some((entry) => !entry)) {
      return { certain: false, source: 'declared', root, paths: [], detail: 'declared candidate paths are ambiguous or outside the workspace' };
    }
    const paths = [...new Set(normalized)];
    return {
      certain: true,
      source: 'declared',
      root,
      paths,
      changed_lines: declaredCandidateChangedLines(root, paths),
    };
  }
  const branch = candidateBranchScope(task, root);
  if (branch) return { root, ...branch };
  return { certain: false, source: 'unknown', root, paths: [], detail: 'no exact diff or declared artifact paths were recorded' };
}

function candidatePolicyGate(task, options = {}) {
  const scope = candidateTouchedScope(task);
  const gate = {
    scope: scope.source,
    paths: scope.paths,
    advisory_only: !scope.certain,
    advisories: [],
    bypassed: false,
  };
  if (!scope.certain) {
    gate.advisories.push({ reason: 'candidate_scope_unknown', detail: scope.detail });
    return { ok: true, gate };
  }

  const { scanPaths } = require('../commands/slop');
  const scanned = scanPaths(scope.paths, {
    root: scope.root,
    changedLines: scope.changed_lines,
  });
  if (scanned.findings.length) {
    const findings = scanned.findings.map((finding) => ({
      file: path.relative(scope.root, finding.file).replace(/\\/g, '/'),
      line: finding.line,
      rule: finding.rule,
      severity: finding.sev,
    }));
    const rules = [...new Set(findings.map((finding) => finding.rule))];
    const offenders = findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`);
    return {
      ok: false,
      eligible: false,
      reason: 'slop_gate',
      rules,
      findings,
      offenders,
      gate,
      message: 'the touched prose or user-facing text breaks a deterministic taste rule, so this work cannot land yet.',
      next_action: `fix ${offenders.join(', ')}, then re-certify`,
    };
  }

  const matchedLessons = policyLessonsForFiles(
    scope.paths,
    readPolicyLessons(scope.root),
    scope.root,
  );
  const failing = [];
  for (const lesson of matchedLessons) {
    if (!lesson.detector) {
      gate.advisories.push({ reason: 'lesson_has_no_detector', lesson_id: lesson.id, matched_path: lesson.matched_path });
      continue;
    }
    if (options.executeDetectors === false) {
      gate.advisories.push({ reason: 'lesson_detector_pending', lesson_id: lesson.id, matched_path: lesson.matched_path });
      continue;
    }
    const result = runVerifyCommandCached(lesson.detector, scope.root, options.verifyCache || null);
    if (result.reason === 'verify_failed' && Number.isInteger(result.status) && result.status !== 0) {
      failing.push({
        lesson_id: lesson.id,
        detector: lesson.detector,
        exit_code: result.status,
        matched_path: lesson.matched_path,
      });
    } else if (!result.ok) {
      gate.advisories.push({
        reason: 'lesson_detector_unrunnable',
        lesson_id: lesson.id,
        detector_reason: result.reason,
        matched_path: lesson.matched_path,
      });
    }
  }
  if (failing.length) {
    const lessonIds = failing.map((entry) => entry.lesson_id);
    return {
      ok: false,
      eligible: false,
      reason: 'lesson_gate',
      lesson_id: lessonIds[0],
      lesson_ids: lessonIds,
      lessons: failing,
      gate,
      message: `the touched work breaks detector-backed lesson ${lessonIds.join(', ')}, so it cannot land yet.`,
      next_action: `repair lesson ${lessonIds.join(', ')} and rerun its detector, then re-certify`,
    };
  }
  return { ok: true, gate };
}

function strictVerifyMissingResult(ref) {
  return {
    eligible: false,
    ref,
    reason: 'strict_verify_missing',
    next_action: 'rerun the review verifier and record a safe metadata.verify command before strict auto-accept',
    review_chat_command: `atris task review-chat ${ref} --as codex-review`,
  };
}

// Receipts named in the proof are read back before landing. A forced
// completion or an explicitly failing receipt blocks auto-accept in every
// policy; a proof that names no receipts is unaffected (absence of a check
// does not block, same rule as verify commands).
function receiptEvidenceBlock(task, ref) {
  const evidence = extractReceiptEvidence(latestProof(task), task.workspace_root || process.cwd());
  if (!evidence) return null;
  if (evidence.any_forced) {
    return { eligible: false, ref, reason: 'forced_completion_needs_human', evidence };
  }
  const failing = evidence.receipts.find((entry) => entry.verifier_passed === false);
  if (failing) {
    return { eligible: false, ref, reason: 'receipt_verifier_failed', receipt: failing.path, evidence };
  }
  return null;
}

// Authors declare protected lanes in the task text, not the tag field. Match
// only explicit, deliberate declarations — an unanchored "security" would
// snag every task that merely mentions the word and wedge the loop shut,
// which is its own failure mode. Kept narrow on purpose.
const PROTECTED_LANE_PHRASES = [
  'protected lane',
  'never self-land',
  'never self land',
  'do not self-land',
  'human accepts',
  'human must accept',
  'human review required',
  'orchestrator reviews pre-land',
  'reviews pre-land',
];

function declaredProtectedLane(task) {
  const haystack = [
    task.title,
    task.objective,
    task.metadata && task.metadata.protected_lane_note,
  ]
    .map((v) => String(v || ''))
    .join('\n')
    .toLowerCase();
  if (!haystack.trim()) return null;
  const phrase = PROTECTED_LANE_PHRASES.find((p) => haystack.includes(p));
  return phrase ? { phrase } : null;
}

// Only consulted when a task carries no tag at all, so this never overrides an
// author who did classify their work. Terms are concrete nouns from the denied
// lanes — things you can only be touching on purpose. Deliberately excludes
// broad words like "auth", "user", or "api" that appear in ordinary frontend
// work and would hold the whole queue.
const PROTECTED_LANE_TERMS = [
  ['billing', ['stripe', 'checkout url', 'checkout_url', 'invoice', 'paywall', 'subscription', 'wallet', 'credit card', 'pricing tier']],
  ['security', ['session minting', 'mints a', 'service token', 'api key', 'credential', 'secret key', 'csrf', 'access token']],
  ['deploy', ['render deploy', 'production deploy', 'deploy to prod', 'migration apply']],
  ['customer', ['send email to', 'customer email', 'outbound email', 'notify users']],
];

function sniffedProtectedLane(task) {
  const haystack = [task.title, task.objective]
    .map((v) => String(v || ''))
    .join('\n')
    .toLowerCase();
  if (!haystack.trim()) return null;
  for (const [lane, terms] of PROTECTED_LANE_TERMS) {
    const term = terms.find((t) => haystack.includes(t));
    if (term) return { lane, term };
  }
  return null;
}

function evaluateAutoAccept(task, options = {}) {
  const {
    strictVerify = true,
    minPasses = AGENT_CERTIFICATION_REVIEW_PASSES,
    acceptAll = false,
    executeVerify = true,
    verifyCache = null,
  } = options;
  const ref = task.display_id || task.legacy_ref || task.id;
  if (task.status !== 'review') return { eligible: false, ref, reason: 'not_in_review' };
  const metadata = task.metadata || {};
  const review = task.review || {};
  const trustTier = computeTrustTier(
    task.claimed_by || metadata.executed_by,
    task.workspace_root || process.cwd(),
  );
  const tierRequiresStrictVerify = trustTier !== 'trusted';
  const requiresStrictVerify = strictVerify || tierRequiresStrictVerify;
  const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
  if (approval && approval !== 'pending' && approval !== 'agent_certified') {
    return { eligible: false, ref, reason: `approval_${approval}` };
  }
  if (metadata.auto_accepted_at) return { eligible: false, ref, reason: 'already_auto_accepted' };

  // 'deploys', 'infra-deploy', and 'Billing ' are the same lanes as their
  // exact-match cousins: match denied lanes on whole words with a plural
  // strip, so a tag variant never slips money/deploy work past the human.
  const tag = String(task.tag || '').trim().toLowerCase();
  const deniedTag = [...DENIED_TAGS].find((d) =>
    tag === d || tag.split(/[^a-z0-9]+/).some((w) => w === d || w.replace(/s$/, '') === d));
  if (deniedTag) return { eligible: false, ref, reason: `denied_tag_${deniedTag}` };

  // A protected lane declared in prose is not a protection, it is a note.
  // WEB-410 said "PROTECTED LANE: auth/session minting ... never self-land"
  // in its own title, carried tag 'endgame', and auto-landed anyway. Routing
  // safety through a tag field that authors leave empty fails open, silently.
  // So read the declaration where authors actually write it.
  const declared = declaredProtectedLane(task);
  if (declared) {
    return {
      eligible: false,
      ref,
      reason: 'declared_protected_lane',
      declared_lane: declared.phrase,
      next_action: 'this task declares a protected lane in its own text; a human accepts it with `atris task accept <ref> --as <human>`',
    };
  }

  // accept-all: the protected lanes above are the only human gate. No
  // certification, pass-count, reviewer, or proof-quality bar — but work
  // is never marked done against evidence it isn't: a proof naming an
  // unmerged draft PR still blocks, and a recorded check that FAILS still
  // blocks (absence of a check does not).
  if (acceptAll) {
    // In this lane the tag IS the safety system — the only human gate. But
    // most rows carry no tag at all (13 of 16 in the 2026-07-25 sweep), so
    // refusing every untagged task would wedge the loop shut, which is the
    // same outage as failing open, just quieter. Instead: when there is no
    // tag to route on, read the task text for the denied lanes themselves.
    // WEB-406 (Stripe checkout + paywall) landed untagged this way.
    if (!tag) {
      const sniffed = sniffedProtectedLane(task);
      if (sniffed) {
        return {
          eligible: false,
          ref,
          reason: 'untagged_protected_lane_text',
          declared_lane: sniffed.lane,
          matched: sniffed.term,
          next_action: `no tag to route on and the text reads as the ${sniffed.lane} lane; tag it or accept explicitly as a human`,
        };
      }
    }
    const proof = latestProof(task);
    if (proofHasUnmergedPullRequestBoundary(proof)) {
      return unmergedPullRequestBoundaryResult(ref, proof);
    }
    const proofCheck = taskProofState(proof);
    if (proofCheck.code === 'suite_green_citation_required') {
      return {
        eligible: false,
        ref,
        reason: proofCheck.reason,
        proof_state: proofCheck.code,
        proof,
      };
    }
    const evidenceBlock = receiptEvidenceBlock(task, ref);
    if (evidenceBlock) return evidenceBlock;
    const verify = metadata.verify;
    if (tierRequiresStrictVerify && !verify) return strictVerifyMissingResult(ref);
    if (verify && executeVerify) {
      const verifyResult = runVerifyCommandCached(verify, task.workspace_root || process.cwd(), verifyCache);
      // A check that runs and fails blocks. So does a check whose worktree
      // is gone — otherwise the daily reap converts "has a failing check"
      // into "lands unchecked" the morning after it clears the worktree.
      // A check that merely isn't in the runnable allowlist counts as no
      // check at all.
      // verify_unrunnable blocks for the same reason worktree_missing does:
      // it used to arrive here as verify_failed, so leaving it out would turn
      // "the harness could not run the check" into "landed unchecked".
      if ((tierRequiresStrictVerify && !verifyResult.ok)
        || verifyResult.reason === 'verify_failed'
        || verifyResult.reason === 'verify_unrunnable'
        || verifyResult.reason === 'verify_worktree_missing'
        || verifyResult.reason === 'verify_workdir_missing') {
        return { eligible: false, ref, reason: verifyResult.reason, verify, ...verifyResult };
      }
    }
    if (trustTier === 'probation' && !reviewIntegrity.hasIndependentReview(task)) {
      return { eligible: false, ref, reason: 'probation_needs_review' };
    }
    // The read-only status path (executeVerify:false) must apply the same
    // command allowlist the landing gate applies, or status promises a landing
    // the gate will refuse every hour: five rows read "lands itself" for a
    // whole night while every tick skipped them as verify_command_not_allowed.
    // Sits after the probation gate so it reports the gate's own refusal
    // order, not a new one.
    if (verify && !executeVerify && !isAutoCertifyVerifyCommandAllowed(verify)) {
      return { eligible: false, ref, reason: 'verify_command_not_allowed', verify };
    }
    let candidateGate = null;
    if (executeVerify) {
      candidateGate = candidatePolicyGate(task, { verifyCache, executeDetectors: true });
      if (!candidateGate.ok) return { ...candidateGate, ref };
      const hygieneBlock = hygieneBlockResult(task, ref);
      if (hygieneBlock) return hygieneBlock;
    }
    return {
      eligible: true,
      ref,
      reason: 'accept_all_but_protected',
      passes: reviewPassCount(task),
      proof,
      policy: 'all_but_protected',
      verification_pending: tierRequiresStrictVerify && Boolean(verify) && !executeVerify,
      ...(candidateGate ? { candidate_gate: candidateGate.gate } : {}),
    };
  }

  if (!isAgentCertified(task)) return { eligible: false, ref, reason: 'not_agent_certified' };

  const passes = reviewPassCount(task);
  if (passes < minPasses) return { eligible: false, ref, reason: 'insufficient_review_passes', passes };

  const proof = latestProof(task);
  if (proofHasUnmergedPullRequestBoundary(proof)) {
    return unmergedPullRequestBoundaryResult(ref, proof);
  }
  const proofCheck = taskProofState(proof);
  if (!proofCheck.ok) {
    return {
      eligible: false,
      ref,
      reason: proofCheck.reason,
      proof_state: proofCheck.code || null,
      proof,
    };
  }
  const evidenceBlock = receiptEvidenceBlock(task, ref);
  if (evidenceBlock) return evidenceBlock;
  if (!requiresStrictVerify) {
    const executionCheck = taskProofExecutionState(proof);
    if (!executionCheck.ok) {
      return {
        eligible: false,
        ref,
        reason: executionCheck.reason,
        detail: executionCheck.detail,
        next_action: 'run an allowed verifier with `atris task ready --verify "<cmd>" --result "<day-one PM sentence>"` or keep strict auto-accept enabled so the verifier executes before landing',
        proof,
      };
    }
  }

  const actors = distinctReviewActors(task);
  if (!reviewIntegrity.hasIndependentReview(task)) {
    return {
      eligible: false,
      ref,
      reason: trustTier === 'probation' ? 'probation_needs_review' : 'needs_independent_reviewer',
      passes,
      builder: reviewIntegrity.taskBuilder(task),
      actors: [...actors],
    };
  }

  if (requiresStrictVerify) {
    const verify = metadata.verify;
    if (!verify) return strictVerifyMissingResult(ref);
    if (executeVerify) {
      const workspaceRoot = task.workspace_root || process.cwd();
      const verifyResult = runVerifyCommandCached(verify, workspaceRoot, verifyCache);
      if (!verifyResult.ok) {
        return { eligible: false, ref, reason: verifyResult.reason, verify, ...verifyResult };
      }
    } else if (!isAutoCertifyVerifyCommandAllowed(verify)) {
      // Same truth rule as above: the read-only path may not promise a
      // landing the allowlist will refuse.
      return { eligible: false, ref, reason: 'verify_command_not_allowed', verify };
    }
  }

  let candidateGate = null;
  if (executeVerify) {
    candidateGate = candidatePolicyGate(task, { verifyCache, executeDetectors: true });
    if (!candidateGate.ok) return { ...candidateGate, ref };
    const hygieneBlock = hygieneBlockResult(task, ref);
    if (hygieneBlock) return hygieneBlock;
  }

  return {
    eligible: true,
    ref,
    reason: requiresStrictVerify ? 'certified_strict_verify' : 'certified_independent_review',
    passes,
    actors: [...actors],
    proof,
    policy: requiresStrictVerify ? 'strict_verify' : 'independent_reviewer',
    verification_pending: requiresStrictVerify && !executeVerify,
    ...(candidateGate ? { candidate_gate: candidateGate.gate } : {}),
  };
}

module.exports = {
  AGENT_CERTIFICATION_REVIEW_PASSES,
  DENIED_TAGS,
  candidatePolicyGate,
  declaredProtectedLane,
  sniffedProtectedLane,
  evaluateAutoAccept,
  isAutoCertifyVerifyCommandAllowed,
  isAgentCertified,
  parseVerifyCommand,
  repoHygieneGate,
  runVerifyCommand,
  runVerifyCommandCached,
};
