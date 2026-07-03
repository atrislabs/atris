'use strict';

const GENERIC_COMPLETION_PROOF_RE = /^(?:done|done now|complete|completed|finished|fixed|handled|ship|shipped|ok|okay|yes|yep|looks good|looks good to me|all set|should be good|works now|approved|approve|lgtm|failed)$/i;

const COMMAND_PROOF_RE = /\b(?:npm\s+run|npm\s+test|node\s+--test|node\s+scripts\/|node\s+bin\/atris[.]js\s+clean\s+--dry-run\s+--json|pnpm\b|yarn\b|npx\b|pytest\b|python\s+-m|tsc\b|vite\s+build|git\s+diff\s+--(?:check|exit-code|quiet)|grep\s+-[A-Za-z]*q[A-Za-z]*|rg\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+(?:\.{0,2}\/|~\/|\/|[\w.-]+\/|[\w.-]+\.[A-Za-z0-9]|\b(?:atris|bin|commands|lib|scripts|src|test)\b)|diff\s+(?:-u|--brief)|cmp\s+-s|curl\b|atris\s+task|\.\/ax\b|ax\s+--|test\s+-s)\b/i;
const FILE_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|src\/|scripts\/|atris\/|backend\/|public\/|resources\/|package[.]json|main[.]js|preload[.]js|AGENTXP_PROOF[.]md)[^\s'"`,;)]*/i;
const PATH_ONLY_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|\/private\/|\/var\/|atris\/runs\/|\.atris\/state\/)[^\s'"`,;)]+(?:[.](?:json|jsonl|md|log|txt|png|jpg|jpeg|pdf))?/i;
const RECEIPT_OR_ARTIFACT_RE = /\b(?:receipt|artifact|screenshot|log|trace|path=|file=|bytes=|model=|opened=|https?:\/\/)\b/i;
const RESULT_PAIR_RE = /\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b.{0,80}\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b|\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b.{0,80}\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b/i;
const HUMAN_PROOF_RE = /\b(?:team human approved|human approved|human approval|approved by|accepted by|reviewed by|customer replied|customer approved|customer accepted|replied)\b/i;
const FILE_ACTION_RE = /\b(?:changed|updated|edited|created|deleted|saved|wrote|patched|reviewed|verified|validated|opened|read)\b/i;
const VERIFIED_PROOF_RE = /^\[verified\]\s+`[^`]+`\s+passed\s+\(exit 0\)(?:\s|$)/i;
const SECOND_ACTOR_EXECUTED_PROOF_RE = /^Second-actor check:\s+`[^`]+`\s+re-run by [^,]+,\s+exited 0(?:[.\s]|$)/i;

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function taskProofState(proof) {
  const text = compactWhitespace(proof);
  if (!text) return { ok: false, reason: 'proof required' };
  if (GENERIC_COMPLETION_PROOF_RE.test(text)) {
    return { ok: false, reason: 'proof must name what was verified, changed, approved, or produced' };
  }
  if (COMMAND_PROOF_RE.test(text)) return { ok: true, reason: 'proof names a command' };
  if (HUMAN_PROOF_RE.test(text)) return { ok: true, reason: 'proof names human/customer approval' };
  if (RESULT_PAIR_RE.test(text)) return { ok: true, reason: 'proof names a verifier result' };
  if (PATH_ONLY_PROOF_RE.test(text)) return { ok: true, reason: 'proof names a receipt or artifact path' };
  if (RECEIPT_OR_ARTIFACT_RE.test(text) && (FILE_PROOF_RE.test(text) || RESULT_PAIR_RE.test(text))) {
    return { ok: true, reason: 'proof names a receipt or artifact' };
  }
  if (FILE_PROOF_RE.test(text) && FILE_ACTION_RE.test(text) && RESULT_PAIR_RE.test(text)) {
    return { ok: true, reason: 'proof names changed files and validation' };
  }
  return { ok: false, reason: 'proof needs concrete evidence: command, verifier result, receipt/artifact path, changed file plus validation, or explicit human/customer approval' };
}

function taskProofLooksMeaningful(proof) {
  return taskProofState(proof).ok;
}

function taskProofExecutionState(proof) {
  const text = compactWhitespace(proof);
  if (!text) return { ok: false, reason: 'proof_not_executed', detail: 'executed proof required' };
  if (VERIFIED_PROOF_RE.test(text)) return { ok: true, reason: 'verified_proof' };
  if (SECOND_ACTOR_EXECUTED_PROOF_RE.test(text)) return { ok: true, reason: 'second_actor_executed_proof' };
  return {
    ok: false,
    reason: 'proof_not_executed',
    detail: 'proof must come from an executed verifier, not a free-text claim that tests passed',
  };
}

function taskProofLooksExecuted(proof) {
  return taskProofExecutionState(proof).ok;
}

function tailText(text, max = 400) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= max) return trimmed;
  return `...${trimmed.slice(-max)}`;
}

// Run a verifier command and turn its real result into proof. This is the
// difference between a CLAIMED proof ("npm test passed", which taskProofState
// happily pattern-matches even if nothing ran) and a VERIFIED proof: the command
// actually executed and exited 0. On failure it returns ok:false so the caller
// can refuse to mark the task ready. The returned proof string is prefixed
// `[verified]` and names the command + exit, so it also passes taskProofState.
function buildVerifiedProof(verifyCmd, baseProof = '', runner, options = {}) {
  const cmd = String(verifyCmd || '').trim();
  if (!cmd) return { ok: false, reason: 'verify_command_required' };
  const run = runner || require('child_process').spawnSync;
  const result = run('bash', ['-lc', cmd], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 120000,
  });
  if (result.error) {
    return { ok: false, reason: 'verifier_spawn_failed', error: result.error.message, cmd };
  }
  const output = tailText(`${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) {
    return { ok: false, reason: 'verifier_failed', exit: result.status, signal: result.signal || null, output, cmd };
  }
  const base = compactWhitespace(baseProof);
  // Phrase so the result also satisfies taskProofState ("verified ... passed").
  const proof = `[verified] \`${cmd}\` passed (exit 0)${base ? ` — ${base}` : ''}${output ? `\n${output}` : ''}`;
  return { ok: true, exit: 0, output, cmd, proof };
}

module.exports = {
  taskProofLooksMeaningful,
  taskProofLooksExecuted,
  taskProofState,
  taskProofExecutionState,
  buildVerifiedProof,
};
