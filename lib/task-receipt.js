'use strict';

// Receipt writer for task proofs. Mirrors the mission receipt shape
// (commands/mission.js writeReceipt) so lib/receipt-evidence.js can validate
// paths named in a proof at the review gate: schema tag, `at` timestamp,
// result.passed. Every call writes a receipt file, pass or fail — a failing
// verifier still leaves a record, it just can't be cited to move a task to
// ready.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function tailText(text, max = 400) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= max) return trimmed;
  return `...${trimmed.slice(-max)}`;
}

function gitCommitHash(root) {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return String(result.stdout || '').trim() || null;
  } catch {
    // ignore — not every workspace is a git repo
  }
  return null;
}

function runsDir(root) {
  return path.join(root, 'atris', 'runs');
}

function slugifyTaskId(taskId) {
  return String(taskId || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

// Runs `command` for `taskId`, writes atris/runs/<date>-task-<id>-<time>.json,
// and returns { ok, passed, receiptPath, exit, signal, output }. `ok` mirrors
// `passed` — kept as a separate field so callers reading either name work.
function writeTaskReceipt({ taskId, command, root = process.cwd(), runner } = {}) {
  const cmd = String(command || '').trim();
  if (!taskId) return { ok: false, passed: false, reason: 'task_id_required' };
  if (!cmd) return { ok: false, passed: false, reason: 'verify_command_required' };
  const run = runner || spawnSync;
  const result = run('bash', ['-lc', cmd], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.error) {
    return { ok: false, passed: false, reason: 'verifier_spawn_failed', error: result.error.message, cmd };
  }
  const output = tailText(`${result.stdout || ''}${result.stderr || ''}`);
  const passed = result.status === 0;
  const dir = runsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const safeTime = now.toISOString().replace(/[:.]/g, '-');
  const receiptFile = path.join(dir, `${date}-task-${slugifyTaskId(taskId)}-${safeTime}.json`);
  const receiptPath = path.relative(root, receiptFile);
  const receipt = {
    schema: 'atris.task_receipt.v1',
    task_id: String(taskId),
    command: cmd,
    at: now.toISOString(),
    commit: gitCommitHash(root),
    result: {
      passed,
      exit: result.status,
      signal: result.signal || null,
      output,
    },
  };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return {
    ok: passed,
    passed,
    receiptPath,
    receiptFile,
    exit: result.status,
    signal: result.signal || null,
    output,
    cmd,
  };
}

module.exports = { writeTaskReceipt };
