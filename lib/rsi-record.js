'use strict';

// Record one bounded improvement attempt into the Dream-RSI ledger.
//
// A command that runs one bounded attempt at improving the workspace
// (improve tick, pulse tick, drive) wraps the work in start-tree -> choose
// -> open -> finish. When the root has backend/scripts/rsi/record.py the
// python recorder writes the rows; otherwise a built-in writer appends the
// same atris.rsi.node.v1 rows (backend/scripts/rsi/schema.py contract).
// Every step is best-effort: a failed write logs one line and the command's
// behavior and exit code stay untouched.
//
// State lands in $ATRIS_RSI_STATE (default <main checkout>/.atris/state/rsi,
// so a worktree writes the project's ledger, not its scratch copy).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Lane name for bounded self-improvement attempts recorded from this CLI.
const IMPROVE_LANE = 'improve_tick';
// While an attempt node is open, nested atris subprocesses (local mission
// fallback, autopilot, mission ticks spawned by drive) must not open their
// own nodes: one command run is one attempt.
const GUARD_ENV = 'ATRIS_RSI_ATTEMPT_NODE';
const SPAWN_TIMEOUT_MS = 20000;
const NODE_SCHEMA = 'atris.rsi.node.v1';
// Reserved backfill policy id: replay, live, and dream drop it, so an
// attempt the policy did not steer never counts as policy evidence.
const UNSTEERED_POLICY = 'p-0000';
// record.py LANE_PREFIXES; any other lane mints "x-<date>".
const LANE_PREFIXES = { night_shift: 'ns', review_lane: 'rl', improve: 'im', mission: 'ms', landing: 'lm' };
const STATUSES = new Set(['shipped', 'failed', 'nothing', 'waiting', 'running']);
const VERIFIES = new Set(['pass', 'fail', 'skipped']);
const CONTEXT_DEFAULTS = { base_commit: '', ground: '', queue_items: 0, round: 0, slot: 0 };
const ACTION_DEFAULTS = {
  policy_id: UNSTEERED_POLICY, kind: 'open', ground: '', engine: 'codex', model: null,
  cap_s: 1800, prompt_variant: 'v1', parent_id: null,
};
const OUTCOME_DEFAULTS = {
  status: 'running', verify: 'skipped', commits: 0, files: [], pr_number: '', pr_url: '', branch: '',
  elapsed_s: 0, engine_calls: 0, engine_used: '', cost_usd: null, reason: '',
  human_revised_within_72h: null, revised_files: [], labeled_at: null, human_verdict: null, human_note: '',
};

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

function ledgerRoot(root) {
  const { mainCheckoutRoot } = require('./engine-registry');
  const main = mainCheckoutRoot(root);
  return main && fs.existsSync(main) ? main : root;
}

function stateDir(root) {
  return process.env.ATRIS_RSI_STATE || path.join(ledgerRoot(root), '.atris', 'state', 'rsi');
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

// schema.py now_iso: local time with a numeric offset ("...T03:00:00-0700"),
// so rows from both writers sort the same way.
function nowIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// Test runs never mint the personal salt in the home folder unless they
// point at a file on purpose.
function holdoutSaltFile(root) {
  if (process.env.ATRIS_RSI_HOLDOUT_SALT_FILE) return process.env.ATRIS_RSI_HOLDOUT_SALT_FILE;
  if (process.env.NODE_TEST_CONTEXT) return path.join(stateDir(root), '.holdout_salt_test');
  return path.join(os.homedir(), '.atris', 'rsi_holdout_salt');
}

function holdoutSecret(root) {
  const p = holdoutSaltFile(root);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      const fd = fs.openSync(p, 'wx', 0o600);
      fs.writeSync(fd, crypto.randomBytes(16).toString('hex'));
      fs.closeSync(fd);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
  }
  return fs.readFileSync(p, 'utf8').trim();
}

// schema.py tree_split: fixed forever for a tree id.
function treeSplit(root, treeId) {
  const hex = crypto.createHash('sha1').update(String(treeId) + holdoutSecret(root)).digest('hex');
  return BigInt(`0x${hex}`) % 5n === 0n ? 'holdout' : 'train';
}

function pick(defaults, src) {
  const out = {};
  for (const k of Object.keys(defaults)) {
    const v = src && Object.prototype.hasOwnProperty.call(src, k) ? src[k] : defaults[k];
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function appendRow(root, row) {
  const p = attemptsPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + '\n');
}

// record.py start-tree: <prefix>-<date>, then -2, -3 for later runs that day.
function nodeStartTree(root, lane, date) {
  const base = `${LANE_PREFIXES[lane] || 'x'}-${date}`;
  const existing = new Set(readAttemptRows(root).map((r) => String(r.tree_id)));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// record.py open: one row, status running, split fixed from the tree hash.
function nodeOpen(root, { tree, lane, action, context }) {
  const at = nowIso();
  const act = pick(ACTION_DEFAULTS, action);
  const row = {
    schema: NODE_SCHEMA,
    id: `n_${crypto.randomBytes(6).toString('hex')}`,
    tree_id: tree,
    parent_id: act.parent_id,
    lane,
    created_at: at,
    opened_at: at,
    recorded_at: at,
    split: treeSplit(root, tree),
    context: pick(CONTEXT_DEFAULTS, context),
    action: act,
    outcome: { ...pick(OUTCOME_DEFAULTS, {}), status: 'running' },
  };
  appendRow(root, row);
  return row;
}

// record.py finish: a second row for the same id; only outcome fields merge.
function nodeFinish(root, nodeId, outcome = {}) {
  const old = latestNodes(root).find((r) => String(r.id) === String(nodeId));
  if (!old) throw new Error(`no node ${nodeId}`);
  const next = { ...outcome };
  if ('status' in next && !STATUSES.has(next.status)) delete next.status;
  if ('verify' in next && !VERIFIES.has(next.verify)) delete next.verify;
  const at = nowIso();
  const row = {
    ...old,
    created_at: at,
    opened_at: old.opened_at || old.created_at,
    recorded_at: at,
    outcome: pick(OUTCOME_DEFAULTS, { ...pick(OUTCOME_DEFAULTS, old.outcome), ...next }),
  };
  appendRow(root, row);
  return row;
}

// Campaign words -> one attempt's outcome. The judge result rides on the same
// attempt as verify + reason; there is no separate judge row.
//   kept -> shipped; reverted -> failed when files changed, else nothing
//   judge true -> pass, false -> fail, null/undefined -> skipped
function campaignOutcome({ result, judge = null, files = [], reason = '' } = {}) {
  if (result !== 'kept' && result !== 'reverted') throw new TypeError(`unknown campaign result: ${result}`);
  const status = result === 'kept' ? 'shipped' : (Array.isArray(files) && files.length ? 'failed' : 'nothing');
  const verify = judge === true ? 'pass' : judge === false ? 'fail' : 'skipped';
  return { status, verify, reason: String(reason || '') };
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
    env: { ...process.env, ATRIS_RSI_STATE: stateDir(root) },
  });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    error: r.error || null,
  };
}

function startTree(root, lane, usePy = Boolean(recorderPath(root))) {
  const today = localDate();
  const existing = todayTreeId(root, lane, today);
  if (existing) return existing;
  if (!usePy) return nodeStartTree(root, lane, today);
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
 * Open one recorded attempt. Returns null when a parent attempt is already
 * open (nested call) or when a write fails. Never throws. Without
 * backend/scripts/rsi/record.py the built-in writer records the row.
 *
 * opts.engine: the engine the tick will actually use (default 'claude').
 * opts.ground: the ground the tick targets; '' is allowed when the tick has
 *   no notion of target.
 * The returned attempt carries .hint = the policy-chosen action (or null),
 * so a tick with a notion of target can steer by hint.ground. The policy id
 * is credited only when the tick takes the hinted ground; anything else is
 * stamped p-0000 so it never reads as policy evidence.
 */
function beginAttempt(root, { lane = IMPROVE_LANE, engine = 'claude', ground = '', queueItems = 0, log = () => {} } = {}) {
  try {
    if (!root || process.env[GUARD_ENV]) return null;
    const usePy = Boolean(recorderPath(root));
    // Recording must never mint a workspace folder: a missing root is a
    // failed write, not a reason to create <root>/.atris.
    if (!usePy && !process.env.ATRIS_RSI_STATE && !fs.existsSync(ledgerRoot(root))) return null;
    const tree = startTree(root, lane, usePy);
    if (!tree) {
      log('rsi: recorder present but start-tree failed; attempt not recorded');
      return null;
    }
    const chosen = chooseAction(root, tree, { queueItems, w: 1 });
    const target = String(ground || '');
    const steered = Boolean(chosen && chosen.ground && chosen.policy_id && String(chosen.ground) === target);
    const action = {
      policy_id: steered ? String(chosen.policy_id) : UNSTEERED_POLICY,
      kind: 'open',
      // The ground the tick actually targeted. Callers without a notion of
      // target pass '' (allowed); the policy's pick is exposed as .hint
      // instead of being claimed as the ground the tick took.
      ground: target,
      engine: engine || 'claude',
      model: steered && chosen.model != null ? chosen.model : null,
      cap_s: (steered && Number(chosen.cap_s)) || 1800,
      prompt_variant: (steered && chosen.prompt_variant) || 'v1',
    };
    const context = {
      base_commit: gitHead(root, true) || '',
      ground: action.ground,
      queue_items: queueItems,
    };
    let node = '';
    if (usePy) {
      const r = runPy(root, 'record.py', [
        'open', '--tree', tree, '--lane', lane,
        '--action-json', JSON.stringify(action),
        '--context-json', JSON.stringify(context),
      ]);
      node = r.ok ? (r.stdout.split('\n').pop() || '').trim() : '';
    } else {
      node = nodeOpen(root, { tree, lane, action, context }).id;
    }
    if (!node) {
      log('rsi: node open failed; attempt not recorded');
      return null;
    }
    process.env[GUARD_ENV] = node;
    return { tree, node, lane, action, hint: chosen || null, writer: usePy ? 'py' : 'node' };
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
    if (attempt.writer === 'node') {
      nodeFinish(root, attempt.node, outcome);
      return true;
    }
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
  UNSTEERED_POLICY,
  attemptsPath,
  dreamsPath,
  currentPolicyId,
  latestNodes,
  gitSnapshot,
  gitDelta,
  engineFromModel,
  beginAttempt,
  finishAttempt,
  campaignOutcome,
};
