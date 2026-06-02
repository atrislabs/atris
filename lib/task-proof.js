'use strict';

const GENERIC_COMPLETION_PROOF_RE = /^(?:done|done now|complete|completed|finished|fixed|handled|ship|shipped|ok|okay|yes|yep|looks good|looks good to me|all set|should be good|works now|approved|approve|lgtm|failed)$/i;

const COMMAND_PROOF_RE = /\b(?:npm\s+run|npm\s+test|node\s+--test|node\s+scripts\/|pnpm\b|yarn\b|npx\b|pytest\b|python\s+-m|tsc\b|vite\s+build|git\s+diff\s+--check|curl\b|atris\s+task|\.\/ax\b|ax\s+--|test\s+-s)\b/i;
const FILE_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|src\/|scripts\/|atris\/|backend\/|public\/|resources\/|package[.]json|main[.]js|preload[.]js|AGENTXP_PROOF[.]md)[^\s'"`,;)]*/i;
const PATH_ONLY_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|\/private\/|\/var\/|atris\/runs\/|\.atris\/state\/)[^\s'"`,;)]+(?:[.](?:json|jsonl|md|log|txt|png|jpg|jpeg|pdf))?/i;
const RECEIPT_OR_ARTIFACT_RE = /\b(?:receipt|artifact|screenshot|log|trace|path=|file=|bytes=|model=|opened=|https?:\/\/)\b/i;
const RESULT_PAIR_RE = /\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b.{0,80}\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b|\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b.{0,80}\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b/i;
const HUMAN_PROOF_RE = /\b(?:team human approved|human approved|human approval|approved by|accepted by|reviewed by|customer replied|customer approved|customer accepted|replied)\b/i;
const FILE_ACTION_RE = /\b(?:changed|updated|edited|created|deleted|saved|wrote|patched|reviewed|verified|validated|opened|read)\b/i;

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

module.exports = {
  taskProofLooksMeaningful,
  taskProofState,
};
