'use strict';

// Ready/recap need a stronger bar than "command can fail in an empty dir".
// A bare `test -f` clears the empty-dir probe and still never exercises the
// change. Allowlist checks that actually run tests, read a symbol, or do a
// real diff/syntax check.

function classifyVerifier(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { kind: 'empty', ok: false, reason: 'no verifier command' };

  if (/\b(node\s+--test|npm\s+(?:test|run\s+test(?:\S*)?)|pnpm\s+test|yarn\s+test|pytest\b|go\s+test|cargo\s+test|vitest\b|jest\b)\b/i.test(cmd)) {
    return { kind: 'test_runner', ok: true, reason: 'test runner' };
  }
  if (/\b(git\s+diff\s+--(?:check|exit-code|quiet)|node\s+--check)\b/i.test(cmd)) {
    return { kind: 'diff_check', ok: true, reason: 'diff or syntax check' };
  }
  if (/\b(?:rg|grep)\b/i.test(cmd) && /\S{2,}/.test(cmd.replace(/^(?:rg|grep)\b/i, ''))) {
    return { kind: 'symbol_read', ok: true, reason: 'symbol or content read' };
  }
  if (/\batris\s+(?:verify|drill|slop)\b/i.test(cmd)) {
    return { kind: 'atris_check', ok: true, reason: 'atris check command' };
  }

  // Bare file/directory existence: passes when the file is there, says nothing
  // about whether the change works.
  if (/^(?:test\s+-[efsdL]\s+\S+|\[\s+-[efsdL]\s+\S+\s*\])(?:\s*(?:&&|\|\|)\s*(?:test\s+-[efsdL]\s+\S+|\[\s+-[efsdL]\s+\S+\s*\]))*$/i.test(cmd)
    || /^test\s+-[efsdL]\s+\S+$/i.test(cmd)
    || /^\[\s+-[efsdL]\s+\S+\s*\]$/i.test(cmd)) {
    return {
      kind: 'file_exists',
      ok: false,
      reason: 'file-exists check does not exercise the change; use a test runner, git diff --check, node --check, or rg/grep for a new symbol',
    };
  }

  // Unknown commands still need the empty-dir falsifier; allow them through
  // that probe. Only bare file-exists is rejected here as not exercising work.
  return {
    kind: 'unknown',
    ok: true,
    reason: 'custom verifier; empty-dir falsifier still applies',
  };
}

function isRealTestRunnerProof(proof) {
  const flat = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!flat) return false;
  return /\b(node\s+--test|npm\s+(?:test|run\s+test(?:\S*)?)|pnpm\s+test|yarn\s+test|pytest\b|go\s+test|cargo\s+test|vitest\b|jest\b)\b/i.test(flat)
    && /\b(pass|passed|green|ok|0 failures?|\d+\/\d+)\b/i.test(flat);
}

function quoteVerifierCommand(proof) {
  const flat = String(proof || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const verified = flat.match(/\[verified\]\s*`([^`]+)`\s*passed/i);
  if (verified) return verified[1].trim();
  const backticked = flat.match(/`([^`]+)`/);
  if (backticked && /\b(test|npm|node|git|rg|grep|pytest|vitest|jest)\b/i.test(backticked[1])) {
    return backticked[1].trim();
  }
  return null;
}

module.exports = {
  classifyVerifier,
  isRealTestRunnerProof,
  quoteVerifierCommand,
};
