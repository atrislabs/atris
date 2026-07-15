// Receipt evidence extraction for the human accept gate.
//
// Agent proofs are free text, but they usually name receipt files under
// atris/runs/. Validating those paths on disk turns "trust the prose" into
// "read the verifier state": the queue and accept surfaces show whether the
// receipts named in a proof exist and whether their verifiers passed. This
// informs the human gate — it never blocks it.
const fs = require('fs');
const path = require('path');

const RECEIPT_PATH_PATTERN = /(?:^|[\s"'`(])((?:atris\/runs|\.atris\/state)\/[^\s"'`),;]+\.json)/g;
const MAX_RECEIPTS = 5;

// Mirrors mission receipt shapes: result.passed (legacy verifier-only),
// result.verifier_result.passed (run/tick envelope), result.tick.verifier_passed.
function receiptVerifierPassed(receipt) {
  const result = receipt?.result;
  if (!result || typeof result !== 'object') return null;
  const oneLapReview = receipt?.schema === 'atris.dispatch_receipt.v1'
    && receipt?.review_only === true
    && receipt?.context?.source === 'one_lap';
  if (oneLapReview) {
    const validator = result.validator_result;
    const validatorEngine = String(validator?.engine || '').trim();
    const executorEngine = String(validator?.executor_engine || '').trim();
    return result.passed === true
      && result.master_boundary_enforced === true
      && result.master_unchanged === true
      && validator?.passed === true
      && validator?.independent === true
      && validator?.worktree_unchanged === true
      && Boolean(validatorEngine)
      && Boolean(executorEngine)
      && validatorEngine !== executorEngine;
  }
  // The receipt's aggregate result is authoritative. A nested verifier can
  // explain one green check inside a failed flight, but it cannot turn that
  // failed flight into passing evidence.
  if (typeof result.passed === 'boolean') return result.passed;
  const nested = [result.verifier_result?.passed, result.tick?.verifier_passed];
  if (nested.includes(false)) return false;
  if (nested.includes(true)) return true;
  return null;
}

function extractReceiptEvidence(proofText, root = process.cwd()) {
  const text = String(proofText || '');
  const found = [];
  const seen = new Set();
  const pattern = new RegExp(RECEIPT_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(text)) && found.length < MAX_RECEIPTS) {
    const candidate = match[1];
    if (candidate.includes('*') || seen.has(candidate)) continue; // glob shorthand or duplicate
    seen.add(candidate);
    found.push(candidate);
  }
  if (!found.length) return null;

  const receipts = [];
  const missing = [];
  for (const rel of found) {
    let raw;
    try {
      raw = fs.readFileSync(path.resolve(root, rel), 'utf8');
    } catch {
      missing.push(rel);
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const entry = { path: rel, exists: true, schema: parsed?.schema || null };
    const passed = receiptVerifierPassed(parsed);
    if (passed !== null) entry.verifier_passed = passed;
    if (parsed?.mission_id) entry.mission_id = parsed.mission_id;
    receipts.push(entry);
  }
  return {
    receipts,
    missing,
    // Unknown verifier state is not proof: every named receipt must explicitly pass.
    all_passing: receipts.length > 0 && !missing.length && receipts.every((entry) => entry.verifier_passed === true),
  };
}

module.exports = { extractReceiptEvidence, receiptVerifierPassed, RECEIPT_PATH_PATTERN };
