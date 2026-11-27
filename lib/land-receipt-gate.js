'use strict';

// The hourly lander takes a change only with an atris check receipt it can
// work out again.
//
// For a project whose default branch has atris/checks.json, each candidate's
// commit needs a receipt: the ref `atris check --push` keeps
// (lib/check-receipt-ref.js), or the receipt file in the branch's own work
// copy. The lander works its plan out again (lib/check-recompute.js) in its
// scratch copy and refuses, with the reason, a receipt that does not hold up.
//
//   no receipt (every branch from before receipts): the lander runs atris check
//     itself in its scratch copy, within this run's time for checks, and uses
//     the receipt it just made. One it cannot check in time waits, never lands
//     on trust.
//   high risk: the lander runs the checks itself, whatever the receipt says.
//   a check that needs the no-screen or paid lane: never run here, never a
//     pass. The change waits for a runner (atris check land).
//
// The lander's own check runs with ATRIS_CHECK_PERSON=1, so no-screen and paid
// checks never run from it, on this Mac or anywhere, and windows stay shut.
//
// Off switch: ATRIS_LAND_RECEIPTS=0, or "green_landing_receipts": false in
// .atris/policy/autoland.json, returns the lander to landing without receipts.

const path = require('path');
const { spawnSync } = require('child_process');
const receipts = require('./check-receipt');
const recompute = require('./check-recompute');
const refs = require('./check-receipt-ref');

const ATRIS_BIN = path.join(__dirname, '..', 'bin', 'atris.js');
// All the lander's own checks in one run share this many seconds.
const DEFAULT_CHECK_SECONDS = 600;
const OFF = /^(?:0|off|false|no)$/i;

function short(sha) {
  return String(sha || '').slice(0, 12);
}

// On unless the env or the policy turns it off. The env wins, so one line
// rolls a bad night back whatever the policy says.
function receiptGateSetting(policy, env = process.env) {
  const fromEnv = String(env.ATRIS_LAND_RECEIPTS ?? '').trim();
  if (fromEnv) return !OFF.test(fromEnv);
  const value = policy && typeof policy === 'object' ? policy.green_landing_receipts : undefined;
  return !(value === false || (typeof value === 'string' && OFF.test(value)));
}

function checkSecondsSetting(policy) {
  const value = Number(policy && typeof policy === 'object' ? policy.green_landing_check_seconds : undefined);
  return value > 0 ? value : DEFAULT_CHECK_SECONDS;
}

// Only projects whose default branch has a map need a receipt.
function mapOnBase(root, base) {
  return receipts.git(root, ['cat-file', '-e', `${base}:${recompute.MAP_FILE}`]).ok;
}

// The receipt file in the branch's own work copy, when that copy is still here.
function worktreeReceipt(root, branch, sha) {
  let listWorktrees;
  try { ({ listWorktrees } = require('../commands/worktree')); } catch { return null; }
  let rows = [];
  try { rows = listWorktrees(root); } catch { return null; }
  for (const wt of rows) {
    if (String(wt.branch || '').replace(/^refs\/heads\//, '') !== branch) continue;
    const file = path.join(wt.path, '.atris', 'receipts', `check-${short(sha)}.json`);
    const receipt = receipts.readReceipt(file);
    if (receipt && receipt.head_sha === sha) return { receipt, source: 'the branch work copy' };
  }
  return null;
}

function findReceipt(root, branch, sha, { fetch = true } = {}) {
  return refs.readReceiptRef(root, sha, { fetch }) || worktreeReceipt(root, branch, sha);
}

function lastLine(text) {
  return String(text || '').trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
}

// Run atris check in the scratch copy, as its own process with a hard time
// limit. ATRIS_CHECK_PERSON=1: no-screen and paid checks are recorded as
// needing their lane, never run.
function runAtrisCheck(dir, { proof = '', seconds, env = process.env }) {
  const childEnv = { ...env, ATRIS_CHECK_PERSON: '1', ATRIS_SKIP_UPDATE_CHECK: '1', BROWSER: 'none' };
  delete childEnv.OBELISK_ALLOW_APP_LAUNCH;
  delete childEnv.NODE_TEST_CONTEXT;
  const args = [ATRIS_BIN, 'check', ...(proof ? ['--proof', proof] : [])];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv,
    timeout: Math.max(1, Math.round(seconds * 1000)),
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    seconds: (Date.now() - started) / 1000,
    line: lastLine(`${result.stdout || ''}`) || lastLine(result.stderr) || (result.error ? result.error.message : ''),
  };
}

// The seconds the checks that would run here are expected to take, from the
// map's own numbers; null when the map says none.
function expectedSeconds(dir) {
  try {
    const change = receipts.changeSet(dir);
    if (!change.ok) return null;
    const rules = recompute.rulesFor(dir, change);
    if (!rules.map) return null;
    const picked = recompute.planFor(dir, rules.map, change);
    const here = picked.selected.filter((entry) => (entry.where || 'here') === 'here');
    const known = here.map((entry) => Number(entry.seconds)).filter((value) => value > 0);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  } catch {
    return null;
  }
}

function failedNames(receipt) {
  const names = (receipt.checks || []).filter((row) => row.status === 'failed' || row.status === 'not-run').map((row) => row.name);
  if (receipt.proof && receipt.proof.status === 'failed') names.push(`the proof (${receipt.proof.why || 'failed'})`);
  if (receipt.secret_scan && receipt.secret_scan.status === 'failed') names.push('the key scan');
  return names;
}

const LANE_LINE = 'must run in the no-screen or paid lane, which the lander never runs; a runner lands it with atris check land';

// What the lander does with one candidate, in its scratch copy at the
// candidate's commit (dir, sha). Returns { ok: true, note } to go on, or
// { ok: false, verdict } to hold with a plain reason.
//   budget: { left } seconds this run still has for the lander's own checks.
//   prepare(): installs the scratch copy's packages before a check runs.
function gateCandidate({ root, dir, branch, sha, budget, env = process.env, fetch = true, prepare = () => ({ ok: true }), proofFor = () => '' }) {
  const hold = (reason, detail, extra = {}) => ({ ok: false, verdict: { action: 'skipped', reason, detail, ...extra } });
  const found = findReceipt(root, branch, sha, { fetch });
  let rerun = false;
  let proof = '';
  if (found) {
    const checked = recompute.recheckReceipt(dir, found.receipt, { sha, trustLane: false });
    if (!checked.ok) {
      return hold('receipt_refused', `the check receipt for ${short(sha)} (from ${found.source}) does not hold up: ${checked.problems.slice(0, 3).join('; ')}${checked.problems.length > 3 ? `; +${checked.problems.length - 3} more` : ''}`);
    }
    if (checked.tier !== 'high') {
      if (checked.verdict === 'proven') return { ok: true, note: { source: found.source, tier: checked.tier, verdict: 'proven' } };
      if (checked.verdict === 'partly') return hold('needs_lane', `${checked.needs_lane.join(', ')} ${LANE_LINE}`);
      return hold('check_failed', `its check receipt records a failure: ${failedNames(found.receipt).slice(0, 3).join(', ') || 'a failed check'}`);
    }
    // High risk: the lander runs the checks itself rather than trust the rows.
    rerun = true;
    proof = found.receipt.proof && found.receipt.proof.command ? String(found.receipt.proof.command) : '';
  } else {
    proof = proofFor(branch) || '';
  }
  const why = rerun ? 'high risk, so the lander runs the checks itself' : 'no check receipt, so the lander checks it itself';
  if (!(budget.left > 0)) {
    return { ok: false, verdict: { action: 'skipped', reason: 'check_budget', detail: `${why}, and this run has no time left for checks; checked next run`, untried: true } };
  }
  const expected = expectedSeconds(dir);
  if (expected !== null && expected > budget.left) {
    return { ok: false, verdict: { action: 'skipped', reason: 'check_budget', detail: `${why}; its checks take about ${Math.round(expected)}s and this run has ${Math.round(budget.left)}s left for checks; checked next run`, untried: true } };
  }
  const ready = prepare();
  if (!ready.ok) return { ok: false, verdict: { action: 'error', reason: 'install_failed', detail: ready.detail } };
  const ran = runAtrisCheck(dir, { proof, seconds: budget.left, env });
  budget.left -= ran.seconds;
  const spent = { check_ran: true, check_seconds: Math.round(ran.seconds * 10) / 10 };
  if (ran.timedOut) {
    return { ok: false, verdict: { action: 'unknown', reason: 'check_timed_out', detail: `${why}, and atris check ran out of this run's time for checks; could not tell, tries again next run`, ...spent } };
  }
  const made = receipts.readReceipt(path.join(dir, '.atris', 'receipts', `check-${short(sha)}.json`));
  if (!made) return hold('check_refused', `${why}, and atris check made no receipt: ${ran.line || `exit ${ran.status}`}`, spent);
  const checked = recompute.recheckReceipt(dir, made, { sha, trustLane: false });
  if (!checked.ok) return hold('receipt_refused', `${why}, and its own receipt does not hold up: ${checked.problems.slice(0, 3).join('; ')}`, spent);
  if (checked.verdict === 'partly') return hold('needs_lane', `${checked.needs_lane.join(', ')} ${LANE_LINE}`, spent);
  if (checked.verdict !== 'proven') return hold('check_failed', `${why}, and it failed: ${failedNames(made).slice(0, 3).join(', ') || 'a failed check'}`, spent);
  // Kept as this repo's receipt ref, so a later run that holds the change for
  // another reason reads it back instead of checking again.
  if (!rerun) { try { refs.storeReceipt(root, made); } catch {} }
  return { ok: true, note: { source: rerun ? 'the lander, rerun for high risk' : 'the lander', tier: checked.tier, verdict: 'proven', seconds: spent.check_seconds }, spent };
}

module.exports = { receiptGateSetting, checkSecondsSetting, mapOnBase, gateCandidate, findReceipt, runAtrisCheck, DEFAULT_CHECK_SECONDS };
