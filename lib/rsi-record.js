'use strict';

// Record one bounded improvement attempt into the Dream-RSI ledger.
//
// When the workspace root contains backend/scripts/rsi/record.py (the
// backend checkout with the recorder), a command that runs one bounded
// attempt at improving the workspace (improve tick, pulse tick, drive)
// wraps the work in start-tree -> choose -> open -> finish. Every step is
// best-effort: a missing recorder, a failed choose, or a dead python logs
// one line and the command's behavior and exit code stay untouched.
//
// State lands in $ATRIS_RSI_STATE (default <root>/.atris/state/rsi), the
// same paths backend/scripts/rsi/schema.py uses.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Lane name for bounded self-improvement attempts recorded from this CLI.
const IMPROVE_LANE = 'improve_tick';
// While an attempt node is open, nested atris subprocesses (local mission
// fallback, autopilot, mission ticks spawned by drive) must not open their
// own nodes: one command run is one attempt.
const GUARD_ENV = 'ATRIS_RSI_ATTEMPT_NODE';
const SPAWN_TIMEOUT_MS = 20000;
const NODE_SCHEMA = 'atris.rsi.node.v1';

function scriptsDir(root) {
  return path.join(root, 'backend', 'scripts', 'rsi');
}

function recorderPath(root) {
  const p = path.join(scriptsDir(root), 'record.py');
  return fs.existsSync(p) ? p : null;
}

// The repo's own venv first (same as scripts/rsi_record_wrap.sh), else
// whatever python3 is on PATH.
function pythonBin(root) {
  const venv = path.join(root, 'venv', 'bin', 'python');
  try {
    fs.accessSync(venv, fs.constants.X_OK);
    return venv;
  } catch {
    return 'python3';
  }
}

function stateDir(root) {
  return process.env.ATRIS_RSI_STATE || path.join(root, '.atris', 'state', 'rsi');
}

function attemptsPath(root) {
  return path.join(stateDir(root), 'attempts.jsonl');
}

function dreamsPath(root) {
  return path.join(stateDir(root), 'dreams.jsonl');
}

function currentPolicyId(root, fallback = 'p-0001') {
  try {
    const raw = fs.readFileSync(path.join(root, 'atris', 'rsi', 'policy.current'), 'utf8').trim();
    return raw || fallback;
  } catch {
    return fallback;
  }
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "<prefix>-YYYY-MM-DD[-N]" -> "YYYY-MM-DD" (record.py start-tree shape).
function treeDate(treeId) {
  const parts = String(treeId || '').split('-');
  if (parts.length < 4) return null;
  const date = parts.slice(1, 4).join('-');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

// Read attempts.jsonl tolerantly: blank lines, non-JSON, and foreign rows
// are skipped. Latest row per node id wins (finish appends a new row).
function readAttemptRows(root) {
  let lines;
  try {
    lines = fs.readFileSync(attemptsPath(root), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && row.schema === NODE_SCHEMA) rows.push(row);
    } catch {
      // skip non-JSON rows
    }
  }
  return rows;
}

function latestNodes(root) {
  const latest = new Map();
  for (const row of readAttemptRows(root)) {
    if (row && row.id) latest.set(String(row.id), row);
  }
  return [...latest.values()];
}

// Reuse today's tree for the lane when one exists (the newest one wins when
// a day has several), so every tick on a day shares one tree.
function todayTreeId(root, lane, today = localDate()) {
  const matches = new Set();
  for (const row of readAttemptRows(root)) {
    if (row && row.lane === lane && treeDate(row.tree_id) === today) matches.add(String(row.tree_id));
  }
  const sorted = [...matches].sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function runPy(root, script, args, timeoutMs = SPAWN_TIMEOUT_MS) {
  const scriptPath = path.join(scriptsDir(root), script);
  const r = spawnSync(pythonBin(root), [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    error: r.error || null,
  };
}

function startTree(root, lane) {
  const today = localDate();
  const existing = todayTreeId(root, lane, today);
  if (existing) return existing;
  const r = runPy(root, 'record.py', ['start-tree', '--lane', lane, '--date', today]);
  const id = r.ok ? (r.stdout.split('\n').pop() || '').trim() : '';
  return id || null;
}

// Ask the live policy for one action (--w 1). Returns the first action or
// null; an empty list means the policy chose to stop, a failure returns null.
function chooseAction(root, treeId, { queueItems = 0, w = 1 } = {}) {
  const choose = path.join(scriptsDir(root), 'choose.py');
  if (!fs.existsSync(choose)) return null;
  const r = runPy(root, 'choose.py', [
    '--tree', treeId,
    '--date', localDate(),
    '--queue-items', String(queueItems),
    '--w', String(w),
  ]);
  if (!r.ok) return null;
  try {
    const actions = JSON.parse(r.stdout);
    return Array.isArray(actions) && actions.length ? actions[0] : null;
  } catch {
    return null;
  }
}

function gitHead(root, short = false) {
  try {
    const args = short ? ['rev-parse', '--short', 'HEAD'] : ['rev-parse', 'HEAD'];
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

function gitDirtyFiles(root) {
  try {
    const r = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return [];
    return String(r.stdout || '')
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((f) => {
        const arrow = f.indexOf(' -> ');
        return arrow >= 0 ? f.slice(arrow + 4) : f;
      });
  } catch {
    return [];
  }
}

// A cheap working-tree snapshot: HEAD + the set of dirty paths. Comparing
// two snapshots gives a tick's ACTUAL contribution; pre-existing dirt is
// excluded so a tick is not credited for mess it did not make.
function gitSnapshot(root) {
  return { head: gitHead(root), dirty: new Set(gitDirtyFiles(root)) };
}

// Commits and files between a captured snapshot (or bare HEAD string) and
// now: the committed diff plus paths the tick newly dirtied.
function gitDelta(root, before) {
  const out = { commits: 0, files: [] };
  if (!root) return out;
  const beforeHead = typeof before === 'string' ? before : (before && before.head);
  const beforeDirty = before && before.dirty instanceof Set ? before.dirty : new Set();
  const files = new Set();
  try {
    const after = gitHead(root);
    if (beforeHead && after && beforeHead !== after) {
      const count = spawnSync('git', ['-C', root, 'rev-list', '--count', `${beforeHead}..${after}`], { encoding: 'utf8', timeout: 15000 });
      if (count.status === 0) out.commits = Number(String(count.stdout).trim()) || 0;
      const diff = spawnSync('git', ['-C', root, 'diff', '--name-only', beforeHead, after], { encoding: 'utf8', timeout: 15000 });
      if (diff.status === 0) String(diff.stdout).split('\n').map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f));
    }
    for (const f of gitDirtyFiles(root)) {
      if (!beforeDirty.has(f)) files.add(f);
    }
  } catch {
    // git missing or not a repo: commits 0, no files
  }
  out.files = [...files].slice(0, 200);
  return out;
}

// Map a model name to a recorded engine. The schema's ENGINES are
// codex/devin/cursor/agy/claude; unknown models return null so callers fall
// back to 'claude' (the CLI's own runner default).
function engineFromModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('codex')) return 'codex';
  if (m.includes('devin')) return 'devin';
  if (m.includes('cursor') || m.includes('composer')) return 'cursor';
  if (m.includes('agy') || m.includes('antigravity')) return 'agy';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'claude';
  return null;
}

/**
 * Open one recorded attempt. Returns null when the workspace has no
 * recorder, when a parent attempt is already open (nested call), or when
 * any recorder step fails. Never throws.
 *
 * opts.engine: the engine the tick will actually use (default 'claude').
 * opts.ground: the ground the tick targets; '' is allowed when the tick has
 *   no notion of target.
 * The returned attempt carries .hint = the policy-chosen action (or null),
 * so a tick with a notion of target can steer by hint.ground.
 */
function beginAttempt(root, { lane = IMPROVE_LANE, engine = 'claude', ground = '', queueItems = 0, log = () => {} } = {}) {
  try {
    if (!root || process.env[GUARD_ENV]) return null;
    if (!recorderPath(root)) return null;
    const tree = startTree(root, lane);
    if (!tree) {
      log('rsi: recorder present but start-tree failed; attempt not recorded');
      return null;
    }
    const chosen = chooseAction(root, tree, { queueItems, w: 1 });
    const action = {
      policy_id: (chosen && chosen.policy_id) || currentPolicyId(root),
      kind: 'open',
      // The ground the tick actually targeted. Callers without a notion of
      // target pass '' (allowed); the policy's pick is exposed as .hint
      // instead of being claimed as the ground the tick took.
      ground: String(ground || ''),
      engine: engine || 'claude',
      model: chosen && chosen.model != null ? chosen.model : null,
      cap_s: Number(chosen && chosen.cap_s) || 1800,
      prompt_variant: (chosen && chosen.prompt_variant) || 'v1',
    };
    const context = {
      base_commit: gitHead(root, true) || '',
      ground: action.ground,
      queue_items: queueItems,
    };
    const r = runPy(root, 'record.py', [
      'open', '--tree', tree, '--lane', lane,
      '--action-json', JSON.stringify(action),
      '--context-json', JSON.stringify(context),
    ]);
    const node = r.ok ? (r.stdout.split('\n').pop() || '').trim() : '';
    if (!node) {
      log('rsi: node open failed; attempt not recorded');
      return null;
    }
    process.env[GUARD_ENV] = node;
    return { tree, node, lane, action, hint: chosen || null };
  } catch (e) {
    log(`rsi: attempt record skipped (${e && e.message ? e.message : e})`);
    return null;
  }
}

// Close an attempt opened by beginAttempt. Never throws; returns true when
// the finish row was written.
function finishAttempt(root, attempt, outcome = {}, { log = () => {} } = {}) {
  if (!attempt || !attempt.node) return false;
  if (process.env[GUARD_ENV] === attempt.node) delete process.env[GUARD_ENV];
  try {
    const r = runPy(root, 'record.py', [
      'finish', '--node', attempt.node,
      '--outcome-json', JSON.stringify(outcome),
    ]);
    if (!r.ok) {
      log(`rsi: node finish failed${r.stderr ? ` (${r.stderr.split('\n').pop()})` : ''}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`rsi: node finish skipped (${e && e.message ? e.message : e})`);
    return false;
  }
}

module.exports = {
  IMPROVE_LANE,
  GUARD_ENV,
  attemptsPath,
  dreamsPath,
  currentPolicyId,
  latestNodes,
  gitSnapshot,
  gitDelta,
  engineFromModel,
  beginAttempt,
  finishAttempt,
};
