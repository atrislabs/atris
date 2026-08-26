'use strict';

const GENERIC_COMPLETION_PROOF_RE = /^(?:done|done now|complete|completed|finished|fixed|handled|ship|shipped|ok|okay|yes|yep|looks good|looks good to me|all set|should be good|works now|approved|approve|lgtm|failed)$/i;

const COMMAND_PROOF_RE = /\b(?:npm\s+run|npm\s+test|node\s+--test|node\s+scripts\/|node\s+bin\/atris[.]js\s+clean\s+--dry-run\s+--json|pnpm\b|yarn\b|npx\b|pytest\b|python\s+-m|tsc\b|vite\s+build|git\s+diff\s+--(?:check|exit-code|quiet)|grep\s+-[A-Za-z]*q[A-Za-z]*|rg\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+(?:\.{0,2}\/|~\/|\/|[\w.-]+\/|[\w.-]+\.[A-Za-z0-9]|\b(?:atris|bin|commands|lib|scripts|src|test)\b)|diff\s+(?:-u|--brief)|cmp\s+-s|curl\b|atris\s+task|\.\/ax\b|ax\s+--|test\s+-s)\b/i;
const FILE_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|src\/|scripts\/|atris\/|backend\/|public\/|resources\/|package[.]json|main[.]js|preload[.]js|AGENTXP_PROOF[.]md)[^\s'"`,;)]*/i;
const PATH_ONLY_PROOF_RE = /(?:^|[\s'"`])(?:\.{0,2}\/|~\/|\/Users\/|\/private\/|\/var\/|atris\/runs\/|\.atris\/state\/)[^\s'"`,;)]+(?:[.](?:json|jsonl|md|log|txt|png|jpg|jpeg|pdf))?/i;
const RECEIPT_OR_ARTIFACT_RE = /\b(?:receipt|artifact|screenshot|log|trace|path=|file=|bytes=|model=|opened=|https?:\/\/)\b/i;
const RESULT_PAIR_RE = /\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b.{0,80}\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b|\b(?:pass|passed|failed|green|ok|exit\s*0|reviewed)\b.{0,80}\b(?:typecheck|build|smoke|test|pytest|verifier|validation|validated|verified|render|diff|sync|lineage|projection)\b/i;
const SUITE_GREEN_CLAIM_RE = /\b(?:tests|test\s+suite|suite)\s+(?:is|are|was|were)?\s*(?:all\s+)?(?:green|pass(?:es|ed)?|ok)\b|\b(?:all|full|whole|entire)\s+(?:tests?|test\s+suite|suite)\s+(?:is|are|was|were)?\s*(?:green|pass(?:es|ed)?|ok)\b|\ball\s+green\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b\x60?(?:\s+(?:\d+\s*\/\s*\d+|all|suite))?\s+(?:is\s+)?(?:green|pass(?:es|ed)?|ok)\b/i;
const CI_RUN_URL_RE = /https?:\/\/github[.]com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+\b/i;
const CI_RUN_ID_RE = /\brun_id\s*=\s*\d+\b|\brun(?:\s+id)?\s*(?:=|:)?\s*\d+\b/i;
const CI_RUN_CITATION_RE = new RegExp(`${CI_RUN_URL_RE.source}|${CI_RUN_ID_RE.source}`, 'i');
const COMMIT_PINNED_LOCAL_VERIFY_RE = /\bcommit\s+[0-9a-f]{7,40}\b/i;
const EXIT_ZERO_RE = /\bexit(?:ed)?(?:\s+code)?\s*0\b/i;
const SUITE_GREEN_CITATION_REASON = 'cite a fetched CI run URL (--proof-url with --i-fetched), a run id, or a commit-pinned verify command with exit 0 before claiming the suite is green';
const LOCAL_SUCCESS_PROOF_EXAMPLE = 'local success example: atris task ready <id> --verify "<cmd>" --result "<plain sentence>" (exit 0 plus the written atris/runs/ receipt path is enough; do not paste a CI URL unless atris fetched it or you pass --proof-url with --i-fetched)';
const FETCHED_PROOF_URL_RE = /\[(?:fetched|i-fetched)\]\s*https?:\/\/github[.]com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+\b/i;
const HUMAN_PROOF_RE = /\b(?:team human approved|human approved|human approval|approved by|accepted by|reviewed by|customer replied|customer approved|customer accepted|replied)\b/i;
const FILE_ACTION_RE = /\b(?:changed|updated|edited|created|deleted|saved|wrote|patched|reviewed|verified|validated|opened|read)\b/i;
const VERIFIED_PROOF_RE = /^\[verified\]\s+`[^`]+`\s+passed\s+\(exit 0\)(?:\s|$)/im;
const LOCAL_RECEIPT_PATH_RE = /(?:^|[\s])(?:Receipt:\s*)?(?:atris\/runs\/|\.atris\/state\/)[^\s'"`,;)]+\.json\b/i;
const SECOND_ACTOR_EXECUTED_PROOF_RE = /^Second-actor check:\s+`[^`]+`\s+re-run by [^,]+,\s+exited 0(?:[.\s]|$)/i;
// Ready/receipt prose may name these. If this process did not run the named
// command, that sentence is a lie. Keep the list tight: these are the claims
// that already pass the meaningful-proof floor without executing anything.
const NAMED_READY_COMMAND_RE = /\b(?:npm test|node --test|git diff --check)\b/i;
const PROOF_COMMAND_NOT_RUN = 'proof_command_not_run';

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namedUnrunProofCommand(proof, ranCommand = '') {
  const text = String(proof || '');
  const match = text.match(NAMED_READY_COMMAND_RE);
  if (!match) return '';
  const named = compactWhitespace(match[0]);
  const ran = compactWhitespace(ranCommand);
  if (ran && new RegExp(`\\b${escapeRegExp(named)}\\b`, 'i').test(ran)) return '';
  return named;
}

function unrunNamedProofCommandIssue(proof, ranCommand = '') {
  const named = namedUnrunProofCommand(proof, ranCommand);
  if (!named) return null;
  return {
    reason: PROOF_COMMAND_NOT_RUN,
    detail: `proof names \`${named}\`, but this process did not run it\nuse --verify "${named}" so the named command actually executes`,
  };
}

function hasFetchedCiCitation(text) {
  return FETCHED_PROOF_URL_RE.test(text);
}

function hasSuiteGreenCitation(text) {
  // A pasted actions URL is not proof unless atris fetched it (marked
  // [fetched]/[i-fetched]) or the caller attested with --i-fetched.
  if (hasFetchedCiCitation(text)) return true;
  if (CI_RUN_URL_RE.test(text)) return false;
  if (CI_RUN_ID_RE.test(text)) return true;
  return COMMIT_PINNED_LOCAL_VERIFY_RE.test(text)
    && COMMAND_PROOF_RE.test(text)
    && EXIT_ZERO_RE.test(text);
}

function hasLocalVerifiedReceipt(text) {
  return VERIFIED_PROOF_RE.test(text) && LOCAL_RECEIPT_PATH_RE.test(text);
}

function taskProofState(proof) {
  const text = compactWhitespace(proof);
  if (!text) return { ok: false, reason: 'proof required' };
  if (GENERIC_COMPLETION_PROOF_RE.test(text)) {
    return { ok: false, reason: 'proof must name what was verified, changed, approved, or produced' };
  }
  // An executed --verify that exited 0 and wrote an atris/runs receipt is
  // meaningful proof on its own. Suite-green URL rules apply only to claims.
  if (hasLocalVerifiedReceipt(text)) {
    return { ok: true, reason: 'proof is a local verified command with receipt path' };
  }
  if (CI_RUN_URL_RE.test(text) && !hasFetchedCiCitation(text) && !SUITE_GREEN_CLAIM_RE.test(text)) {
    return {
      ok: false,
      code: 'unfetched_proof_url',
      reason: 'CI run URLs only count after atris fetches them, or with --proof-url and --i-fetched',
    };
  }
  if (SUITE_GREEN_CLAIM_RE.test(text)) {
    if (!hasSuiteGreenCitation(text)) {
      return {
        ok: false,
        code: 'suite_green_citation_required',
        reason: SUITE_GREEN_CITATION_REASON,
      };
    }
    return { ok: true, reason: 'proof cites a fetched CI run or commit-pinned local verify' };
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
  // Keep the head as well as the tail: failures name their cause in the first
  // lines (missing dependency, bad import), which a tail-only cut always loses.
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${trimmed.slice(0, head)}\n...\n${trimmed.slice(-tail)}`;
}

// Run a verifier command and turn its real result into proof. This is the
// difference between a CLAIMED proof ("npm test passed", which taskProofState
// happily pattern-matches even if nothing ran) and a VERIFIED proof: the command
// actually executed and exited 0. On failure it returns ok:false so the caller
// can refuse to mark the task ready. The returned proof string is prefixed
// It names the command and exit; suite-green claims still need a citation.
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
  tailText,
  taskProofLooksMeaningful,
  taskProofLooksExecuted,
  taskProofState,
  taskProofExecutionState,
  namedUnrunProofCommand,
  unrunNamedProofCommandIssue,
  buildVerifiedProof,
  LOCAL_SUCCESS_PROOF_EXAMPLE,
  PROOF_COMMAND_NOT_RUN,
};
