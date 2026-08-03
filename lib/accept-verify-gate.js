'use strict';

// The accept gate used to check that a task's verify field was non-empty, never
// that it held something that could fail. An audit on 2026-07-26 found 131 of 802
// accepted proofs (16.3%) were unfalsifiable at the moment they were signed off:
// 54 an unfilled template sentence, 55 a bare `git diff --check`, 21 a path into a
// deleted worktree, 1 a bare file path.
//
// This module answers one question before a task may be marked done: does the
// stored verify command actually run, and does it pass? Parsing and execution reuse
// lib/auto-accept-certified.js so there is one allow-list, not two.

const { parseVerifyCommand, runVerifyCommandCached } = require('./auto-accept-certified');

// Template text shipped in task scaffolding. Present verbatim in 54 accepted proofs.
const TEMPLATE_PLACEHOLDERS = [
  'concrete command, file, receipt, or verifier evidence',
  'command, file, receipt, or verifier evidence',
  '<command>',
  'tbd',
  'n/a',
  'none',
];

// Commands that execute cleanly but cannot fail for the reason the task exists.
// `git diff --check` reports whitespace and conflict markers; it is green on a
// commit that deletes the feature. 55 accepted proofs stored exactly this.
const NON_FALSIFYING_COMMANDS = [
  /^git\s+diff\s+--check\s*$/i,
  /^git\s+status\s*$/i,
  /^git\s+log\b/i,
  /^ls\b/i,
  /^true\s*$/i,
];

function storedVerifyCommand(task) {
  const metadata = (task && task.metadata) || {};
  const candidates = [metadata.verify, metadata.latest_agent_verify];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return '';
}

function placeholderIssue(command) {
  const lower = command.toLowerCase().trim();
  if (TEMPLATE_PLACEHOLDERS.some((p) => lower === p || lower.startsWith(p))) {
    return 'the verify field holds unfilled template text, not a command';
  }
  // A bare path is a receipt, not a check. `/tmp/x/proof.json` was one of the 131.
  if (/^[./~]/.test(command) && !/\s/.test(command)) {
    return 'the verify field holds a file path, not a command that can fail';
  }
  return '';
}

function nonFalsifyingIssue(command) {
  if (NON_FALSIFYING_COMMANDS.some((re) => re.test(command.trim()))) {
    return `\`${command.trim()}\` cannot fail for the reason this task exists — it passes on a commit that deletes the work`;
  }
  return '';
}

// Returns { ok, reason, detail, command, ran, exit_code }.
// ok:true means the stored command parsed, ran, and exited 0.
function evaluateAcceptVerify(task, workspaceRoot, { cache = null } = {}) {
  const command = storedVerifyCommand(task);
  // A task with no stored verify is out of scope here. Every one of the 131
  // unfalsifiable proofs HAD a command; the defect is a stored check that cannot
  // fail, not a missing one. Requiring a verify on every accept is a separate,
  // larger policy change and blocking it here would only get this gate switched off.
  if (!command) {
    return { ok: true, reason: 'no_verify_command', detail: '', command: '', ran: false, unchecked: true };
  }

  const placeholder = placeholderIssue(command);
  if (placeholder) return { ok: false, reason: 'verify_placeholder', detail: placeholder, command, ran: false };

  const hollow = nonFalsifyingIssue(command);
  if (hollow) return { ok: false, reason: 'verify_not_falsifying', detail: hollow, command, ran: false };

  // Two different questions got fused here at first: "can this fail?" and "is this
  // safe to execute at accept time?". Only the first is this gate's business.
  // Refusing everything outside the execution allow-list flagged 455 accepted tasks,
  // and sampling them found ordinary verifiers — `npm run type-check`, `npx vitest
  // run` — sitting beside real prose. A gate that blocks real work gets switched off.
  // So: refuse what provably cannot fail, run what can be run safely, and mark the
  // rest unchecked rather than pretend a judgment we cannot make.
  const parsed = parseVerifyCommand(command);
  if (!parsed.ok) {
    return {
      ok: true,
      reason: 'verify_not_runnable_here',
      detail: `the stored verify command cannot be safely executed at accept time (${parsed.reason || 'unknown'}); it was not checked`,
      command,
      ran: false,
      unchecked: true,
    };
  }

  const result = runVerifyCommandCached(command, workspaceRoot, cache);
  if (!result.ok) {
    const diffCheck = /^git\s+diff\s+--check\b/i.test(command.trim());
    const fixHint = diffCheck
      ? '; trailing whitespace in markdown is auto-fixable: npm run audit:markdown-whitespace -- --fix'
      : '';
    return {
      ok: false,
      reason: result.reason || 'verify_failed',
      detail: result.reason === 'verify_workdir_missing' || result.reason === 'verify_worktree_missing'
        ? 'the stored verify command points at a directory that no longer exists'
        : `the stored verify command did not pass (${result.reason || 'nonzero exit'})${fixHint}`,
      command,
      ran: true,
      exit_code: typeof result.status === 'number' ? result.status : null,
    };
  }

  return { ok: true, reason: 'verify_passed', detail: '', command, ran: true, exit_code: 0 };
}

module.exports = {
  storedVerifyCommand,
  evaluateAcceptVerify,
};
