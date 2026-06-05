'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { taskProofState } = require('./task-proof');

const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const AUTO_ACCEPT_HIGH_CONFIDENCE_PASSES = 3;
const DENIED_TAGS = new Set(['billing', 'deploy', 'feedback', 'voice', 'security', 'customer', 'external']);

const SIMPLE_VERIFY_TOKEN_RE = /^[a-zA-Z0-9_./:@=+-]+$/;
const GIT_WORKTREE_PATH_RE = /^[a-zA-Z0-9_./@=+-]+$/;
const GIT_REV_TOKEN_RE = /^[a-zA-Z0-9_./@=+~^-]+$/;

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

function isInsidePath(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateGitWorktreePath(argv, workspaceRoot) {
  if (!(argv[0] === 'git' && argv[1] === '-C')) return { ok: true };
  const workspace = path.resolve(workspaceRoot || process.cwd());
  const target = path.resolve(workspace, argv[2]);
  const allowedRoot = path.dirname(workspace);
  if (!isInsidePath(target, workspace) && !isInsidePath(target, allowedRoot)) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  if (!fs.existsSync(target)) return { ok: false, reason: 'verify_worktree_missing' };
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
    || /\bgithub\.com\/\S+\/pull\/\d+\b/i.test(sentence);
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
  const actors = new Set();
  for (const event of task.events || []) {
    if (!['proof_ready', 'reviewed'].includes(event.event_type)) continue;
    const actor = event.actor || event.payload?.actor;
    if (actor) actors.add(String(actor));
  }
  return actors;
}

function parseVerifyCommand(verify) {
  const cmd = String(verify || '').trim();
  if (!cmd) return { ok: false, reason: 'no_verify_command' };
  if (/[;&|`$<>\n\r]/.test(cmd)) return { ok: false, reason: 'verify_command_not_allowed' };
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (!argv.length || argv.some((token, index) => {
    if (argv[0] === 'git' && argv[1] === '-C' && index === 2) {
      return !safeGitWorktreePathToken(token);
    }
    if (argv[0] === 'git' && ['diff', '-C'].includes(argv[1]) && index >= (argv[1] === '-C' ? 5 : 3)) {
      return !safeGitRevToken(token);
    }
    return !safeVerifyToken(token);
  })) {
    return { ok: false, reason: 'verify_command_not_allowed' };
  }
  const [bin, first, second] = argv;
  const allowed = (bin === 'npm' && (
    (first === 'test' && argv.length === 2)
    || (first === 'run' && Boolean(second) && !second.startsWith('-') && argv.length === 3)
  ))
    || (bin === 'node' && (
      (first === '--test' && safeNodePathArgs(argv.slice(2)))
      || (first === '--check' && argv.length === 3 && safeRelativePathToken(second))
      || (/^scripts\/[a-zA-Z0-9_./-]+$/.test(first || '') && safeNodePathArgs(argv.slice(1)))
    ))
    || (bin === 'tsc' && argv.length === 1)
    || isAllowedGitDiffCheck(argv);
  if (!allowed) return { ok: false, reason: 'verify_command_not_allowed' };
  return { ok: true, argv };
}

function runVerifyCommand(verify, workspaceRoot) {
  const parsed = parseVerifyCommand(verify);
  if (!parsed.ok) return parsed;
  const gitPathCheck = validateGitWorktreePath(parsed.argv, workspaceRoot);
  if (!gitPathCheck.ok) return gitPathCheck;
  const result = spawnSync(parsed.argv[0], parsed.argv.slice(1), {
    cwd: workspaceRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    ok: result.status === 0,
    reason: result.status === 0 ? 'verify_passed' : 'verify_failed',
    status: result.status,
    stderr: String(result.stderr || '').slice(0, 400),
  };
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

function evaluateAutoAccept(task, options = {}) {
  const { strictVerify = false, minPasses = AGENT_CERTIFICATION_REVIEW_PASSES } = options;
  const ref = task.display_id || task.legacy_ref || task.id;
  if (task.status !== 'review') return { eligible: false, ref, reason: 'not_in_review' };
  const metadata = task.metadata || {};
  const review = task.review || {};
  const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
  if (approval && approval !== 'pending' && approval !== 'agent_certified') {
    return { eligible: false, ref, reason: `approval_${approval}` };
  }
  if (metadata.auto_accepted_at) return { eligible: false, ref, reason: 'already_auto_accepted' };

  const tag = String(task.tag || '').toLowerCase();
  if (DENIED_TAGS.has(tag)) return { eligible: false, ref, reason: `denied_tag_${tag}` };

  if (!isAgentCertified(task)) return { eligible: false, ref, reason: 'not_agent_certified' };

  const passes = reviewPassCount(task);
  if (passes < minPasses) return { eligible: false, ref, reason: 'insufficient_review_passes', passes };

  const proof = latestProof(task);
  const proofCheck = taskProofState(proof);
  if (!proofCheck.ok) return { eligible: false, ref, reason: proofCheck.reason, proof };
  if (proofHasUnmergedPullRequestBoundary(proof)) {
    return unmergedPullRequestBoundaryResult(ref, proof);
  }

  const actors = distinctReviewActors(task);
  const multiActor = actors.size >= 2;
  const highConfidence = passes >= AUTO_ACCEPT_HIGH_CONFIDENCE_PASSES;
  if (!multiActor && !highConfidence) {
    return {
      eligible: false,
      ref,
      reason: 'needs_second_reviewer_or_third_pass',
      passes,
      actors: [...actors],
    };
  }

  if (strictVerify) {
    const verify = metadata.verify;
    if (!verify) return strictVerifyMissingResult(ref);
    const workspaceRoot = task.workspace_root || process.cwd();
    const verifyResult = runVerifyCommand(verify, workspaceRoot);
    if (!verifyResult.ok) {
      return { eligible: false, ref, reason: verifyResult.reason, verify, ...verifyResult };
    }
  }

  return {
    eligible: true,
    ref,
    reason: strictVerify
      ? 'certified_strict_verify'
      : (highConfidence ? 'certified_high_confidence' : 'certified_multi_actor'),
    passes,
    actors: [...actors],
    proof,
    policy: strictVerify ? 'strict_verify' : (highConfidence ? '3_passes' : '2_actors_2_passes'),
  };
}

module.exports = {
  AGENT_CERTIFICATION_REVIEW_PASSES,
  AUTO_ACCEPT_HIGH_CONFIDENCE_PASSES,
  DENIED_TAGS,
  evaluateAutoAccept,
  parseVerifyCommand,
  runVerifyCommand,
};
