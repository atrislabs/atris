const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/**
 * Lesson contract validation + append-only mutation ledger.
 *
 * Every lesson mutation (add / resolve / revert) lands one JSONL record in
 * .atris/state/lesson_ledger.jsonl with evidence and an id, so self-improvement
 * edits are auditable and reversible instead of silent sidecar rewrites. The
 * ledger is append-only: revert writes a new record, it never deletes history.
 */

const LEDGER_REL = path.join('.atris', 'state', 'lesson_ledger.jsonl');

function ledgerPath(root) {
  return path.join(root, LEDGER_REL);
}

/**
 * Validate a detector command at write time. A detector is a shell command
 * whose exit code is the lesson's falsifiable state (0 = bug gone). At add
 * time either exit code is fine (the bug usually still exists) but the
 * command itself must run: empty strings, missing binaries (127), and
 * non-executable targets (126) are rejected so a typo can't masquerade as a
 * forever-failing detector.
 * @returns {{ ok: boolean, exitCode?: number, reason?: string }}
 */
function validateDetector(cmd, cwd, timeoutMs = 10000) {
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, reason: 'detector is empty' };
  }
  const res = spawnSync(cmd, { shell: true, cwd, timeout: timeoutMs, stdio: 'pipe' });
  if (res.error) return { ok: false, reason: res.error.message };
  if (res.signal) return { ok: false, reason: `detector killed by ${res.signal} (timeout?)` };
  if (res.status === 127) return { ok: false, exitCode: 127, reason: 'command not found (exit 127)' };
  if (res.status === 126) return { ok: false, exitCode: 126, reason: 'command not executable (exit 126)' };
  return { ok: true, exitCode: res.status };
}

/**
 * Append one mutation record. Adds id + ts; returns the full record.
 * @param {string} root
 * @param {{ action: 'add'|'resolve'|'revert', slug: string, evidence?: string, outcome?: string }} entry
 */
function appendLedgerEntry(root, entry) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    id: `ll-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    ...entry,
  };
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

/**
 * Read ledger records, oldest first. Malformed lines are skipped, not fatal:
 * a half-written line from a crashed process must not brick the view.
 * @param {string} root
 * @param {{ limit?: number, slug?: string }} [options]
 */
function readLedger(root, options = {}) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip torn line
    }
  }
  const filtered = options.slug ? records.filter((r) => r.slug === options.slug) : records;
  if (options.limit && filtered.length > options.limit) {
    return filtered.slice(filtered.length - options.limit);
  }
  return filtered;
}

module.exports = { ledgerPath, validateDetector, appendLedgerEntry, readLedger };
