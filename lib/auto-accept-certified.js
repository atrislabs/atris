'use strict';

const { spawnSync } = require('child_process');
const { taskProofState } = require('./task-proof');

const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const AUTO_ACCEPT_HIGH_CONFIDENCE_PASSES = 3;
const DENIED_TAGS = new Set(['billing', 'deploy', 'feedback', 'voice', 'security', 'customer', 'external']);

const SIMPLE_VERIFY_TOKEN_RE = /^[a-zA-Z0-9_./:@=+-]+$/;

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

function safeNodePathArgs(args) {
  return args.every(token => safeRelativePathToken(token));
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
  if (!argv.length || argv.some(token => !safeVerifyToken(token))) {
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
    || (bin === 'git' && first === 'diff' && second === '--check' && argv.length === 3);
  if (!allowed) return { ok: false, reason: 'verify_command_not_allowed' };
  return { ok: true, argv };
}

function runVerifyCommand(verify, workspaceRoot) {
  const parsed = parseVerifyCommand(verify);
  if (!parsed.ok) return parsed;
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
