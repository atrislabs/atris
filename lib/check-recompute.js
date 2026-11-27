'use strict';

// atris check, part three: a receipt is believed only after the plan is
// worked out again.
//
// A receipt is a plain file anyone can edit. So `atris check --verify`, `atris
// worktree ship` and the hourly lander never take its word for what had to
// run. They work the plan out again from the diff and the map, then compare:
//
//   (a) the receipt names this commit and this code (tree);
//   (b) it has a row for every check the plan picks, none skipped by rule;
//   (c) every row it counts as passed really says passed (exit 0, ran in a
//       place that check may run), and its verdict is what its own rows make;
//   (d) it claims no lower risk tier than the change has.
//
// The map is the one on the default branch at the merge base, never the
// change's own copy: a change cannot vote on the rules it is checked by. Only
// when the default branch has no map yet does the change's own map count, and
// then the map file itself makes the change high risk.
//
// No cryptography. A receipt can still lie that a check it lists passed when it
// failed; the lander re-runs the checks itself for high risk changes, where
// that lie would cost the most.

const fs = require('fs');
const path = require('path');
const plan = require('./check-plan');
const receipts = require('./check-receipt');
const proofs = require('./check-proof');
const { planOptions } = require('./check-context');

const MAP_FILE = 'atris/checks.json';
const RANK = { failed: 0, partly: 1, proven: 2 };

function short(sha) {
  return String(sha || '').slice(0, 12);
}

// The map as of one commit, read from git objects; the checkout is not touched.
function mapAt(root, rev) {
  if (!rev) return { missing: true };
  const blob = receipts.git(root, ['rev-parse', '--verify', '--quiet', `${rev}:${MAP_FILE}`]);
  if (!blob.ok || !blob.out.trim()) return { missing: true };
  const id = blob.out.trim();
  const text = receipts.git(root, ['cat-file', 'blob', id]);
  let raw;
  try {
    raw = JSON.parse(text.out);
  } catch (error) {
    return { error: `the map on ${short(rev)} is not valid JSON: ${error.message}` };
  }
  try {
    return { map: plan.validateMap(raw), blob: id };
  } catch (error) {
    if (error instanceof plan.CheckMapError) return { error: `the map on ${short(rev)} was refused: ${error.message}` };
    throw error;
  }
}

function ownMapBlob(root) {
  const file = path.join(root, MAP_FILE);
  if (!fs.existsSync(file)) return '';
  return receipts.git(root, ['hash-object', '--', MAP_FILE]).out.trim();
}

// The rules a change is checked by: the map at the merge base with the default
// branch, else the map on the default branch now, else (only when the default
// branch has none) the change's own map.
function rulesFor(root, change, { workingMap = null } = {}) {
  const tried = [];
  if (change && change.mergeBase) tried.push([change.mergeBase, 'the merge base']);
  if (change && change.base) tried.push([change.base, `the default branch (${change.base})`]);
  for (const [rev, label] of tried) {
    const found = mapAt(root, rev);
    if (found.error) return { error: found.error };
    if (found.map) {
      const sha = receipts.git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).out.trim();
      return { map: found.map, blob: found.blob, from: `${label} ${short(sha || rev)}` };
    }
  }
  if (!workingMap) return { missing: true };
  return { map: workingMap, blob: ownMapBlob(root), from: 'this change (the default branch has no map yet)', own: true };
}

// The plan for a change under a given map.
function planFor(root, map, change, { gate = null } = {}) {
  const context = planOptions(root, map, change.files, {
    base: change.mergeBase || 'HEAD',
    dirtyFiles: receipts.uncommittedFiles(root),
    gate,
  });
  return plan.planChecks(map, change.files, context);
}

// A selector's command names the python and the pytest workers this machine
// has. Neither changes which tests run, so they are left out of the compare.
function canonRun(run) {
  return String(run || '')
    .replace(/(^|\s)-p xdist(?=\s|$)/g, '$1')
    .replace(/(^|\s)-n \d+(?=\s|$)/g, '$1')
    .replace(/(^|\s)\S*\/python[0-9.]*(?=\s|$)/g, '$1{python}')
    .replace(/(^|\s)python3(?=\s|$)/g, '$1{python}')
    .replace(/\s+/g, ' ')
    .trim();
}

function worst(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}

// What one receipt row says it is, checked against the recomputed plan.
function rowStatus(row, entry, receipt, problems) {
  const name = entry.key;
  const where = entry.where || 'here';
  if (row.status === 'passed') {
    if (entry.partialFallback) { problems.push(`${name} is a fallback that runs only part of the tests, so it can never count as passed`); return 'failed'; }
    if (row.exit_code !== 0) { problems.push(`${name} is marked passed, but its exit code is ${row.exit_code === null || row.exit_code === undefined ? 'missing' : row.exit_code}`); return 'failed'; }
    if (/skipped itself/.test(String(row.note || ''))) { problems.push(`${name} is marked passed, but its own note says it skipped itself`); return 'failed'; }
    if (where === 'no-screen' && receipt.lane !== 'no-screen') { problems.push(`${name} only runs in the no-screen lane, but the receipt says it passed in the ${receipt.lane || 'here'} lane`); return 'failed'; }
    if (where === 'no-screen' && receipt.person_machine) { problems.push(`${name} only runs on a runner with no screen, but the receipt says it passed on a person's machine`); return 'failed'; }
    return 'passed';
  }
  if (row.status === 'needs-lane') return 'needs-lane';
  if (row.status === 'failed' || row.status === 'not-run') return 'failed';
  problems.push(`${name} has status "${row.status}", which atris check never writes`);
  return 'failed';
}

// Does this receipt prove the code here now, under the rules worked out again?
//   sha        the commit it must name (the lander passes the candidate's).
//   trustLane  false: lane rows never count as passed (the lander).
//   workingMap this copy's own map, used only when the default branch has none.
function recheckReceipt(root, receipt, { sha = null, trustLane = true, workingMap = null } = {}) {
  const refused = (why, extra = {}) => ({ ok: false, problems: [why], why, verdict: null, ...extra });
  if (!receipt || receipt.kind !== receipts.RECEIPT_KIND) return refused('it is not an atris check receipt');
  const identity = receipts.codeIdentity(root);
  if (sha) {
    if (receipt.head_sha !== sha) return refused(`the receipt names commit ${short(receipt.head_sha)}, but the change is commit ${short(sha)}`);
    if (identity.headSha !== sha) return refused(`the copy being checked is at commit ${short(identity.headSha)}, not ${short(sha)}`);
  } else if (!receipt.dirty && receipt.head_sha !== identity.headSha) {
    return refused(`the receipt names commit ${short(receipt.head_sha)}, but the code here is commit ${short(identity.headSha)}`);
  }
  if (receipt.tree !== identity.tree) return refused(`the receipt is for different code (receipt tree ${short(receipt.tree)}, here ${short(identity.tree)})`);
  if (sha && identity.dirty) return refused('the copy being checked has files that are not in the commit');
  if (receipt.files_override) return refused('the receipt was made from a hand-picked --files list, so it does not cover the whole change');
  if (receipt.gate) return refused(`the receipt is a whole ${receipt.gate} gate run, not a check of this change`);
  const change = receipts.changeSet(root);
  if (!change.ok) return refused(change.error);
  const covered = new Set(receipt.changed_files || []);
  const missing = change.files.filter((file) => !covered.has(file));
  if (missing.length) return refused(`the receipt does not cover ${missing.length} changed file(s), first ${missing[0]}`);
  const rules = rulesFor(root, change, { workingMap });
  if (rules.error) return refused(rules.error);
  if (rules.missing) return refused('there is no atris/checks.json to check the receipt against');
  if (!receipt.map_blob) return refused('the receipt does not say which map it was made with (an older atris check made it); run atris check again');
  if (receipt.map_blob !== rules.blob) {
    return refused(`the receipt was made with a different map (${short(receipt.map_blob)}) than ${rules.from} has (${short(rules.blob)})`);
  }
  let picked;
  try {
    picked = planFor(root, rules.map, change);
  } catch (error) {
    if (error instanceof plan.CheckMapError) return refused(error.message);
    throw error;
  }
  const problems = [];
  const tierRank = plan.TIERS.indexOf(picked.tier);
  if (plan.TIERS.indexOf(receipt.risk_tier) < tierRank) {
    const high = [...picked.files, ...picked.importers].find((file) => file.tier === picked.tier);
    problems.push(`the receipt claims ${receipt.risk_tier || 'no'} risk, but the change is ${picked.tier} risk${high ? ` (${high.path}${high.imports ? ` imports ${high.imports}` : ''})` : ''}`);
  }
  const rows = new Map((receipt.checks || []).map((row) => [row.name, row]));
  // claimed: what the rows say. counted: what they count as here. With
  // trustLane false (the lander) a check that may not run on a person's
  // machine counts as passed only when the lander ran it, so a row that says
  // it passed in some lane still needs that lane.
  const claimed = [];
  const statuses = [];
  const needsLane = [];
  for (const entry of picked.selected) {
    const row = rows.get(entry.key);
    if (!row) { problems.push(`the receipt leaves out ${entry.key}, which the plan picks`); claimed.push('failed'); statuses.push('failed'); continue; }
    if (row.status === 'skipped-by-rule') { problems.push(`the receipt skipped ${entry.key} by rule, but the plan picks it`); claimed.push('failed'); statuses.push('failed'); continue; }
    if (canonRun(row.run) !== canonRun(entry.run)) problems.push(`${entry.key} ran a different command than the map says (receipt: ${row.run}; map: ${entry.run})`);
    if ((row.where || 'here') !== (entry.where || 'here')) problems.push(`${entry.key} is a ${entry.where} check, but the receipt calls it ${row.where || 'here'}`);
    const said = rowStatus(row, entry, receipt, problems);
    const status = said === 'passed' && (entry.where || 'here') !== 'here' && !trustLane ? 'needs-lane' : said;
    if (status === 'needs-lane') needsLane.push(entry.key);
    claimed.push(said);
    statuses.push(status);
  }
  const proof = receipt.proof || {};
  let proofStatus = proof.status;
  if (picked.tier === 'low' && (proof.status === 'exempt' || !proof.status)) proofStatus = 'exempt';
  else if (proof.status === 'exempt') { problems.push(`the proof is marked not needed, but a ${picked.tier} risk change needs one`); proofStatus = 'failed'; }
  else if (proof.status === 'passed') {
    if (!proof.command || proof.exit_code !== 0) { problems.push('the proof is marked passed without a command that exited 0'); proofStatus = 'failed'; }
    else {
      const relevant = proofs.proofRelevance(root, proof.command, change.files);
      if (!relevant.ok) { problems.push(`the proof is marked passed, but ${relevant.why}`); proofStatus = 'failed'; }
    }
  } else if (proof.status === 'not-run') {
    proofStatus = 'failed';
  } else if (!['failed', 'needs-lane'].includes(proof.status)) {
    problems.push(`the proof has status "${proof.status || 'none'}", which atris check never writes`);
    proofStatus = 'failed';
  }
  if (proofStatus === 'needs-lane') needsLane.push('the proof');
  const secret = receipt.secret_scan || {};
  const secretStatus = secret.status === 'passed' ? 'passed' : 'failed';
  if (!secret.status) problems.push('the receipt has no key scan');
  const verdictFrom = (list) => receipts.verdictOf([...list, proofStatus, secretStatus].filter((status) => status !== 'exempt').map((status) => ({ status })));
  const own = verdictFrom(claimed);
  if (receipt.verdict in RANK && RANK[receipt.verdict] > RANK[own]) {
    problems.push(`the receipt says ${receipt.verdict}, but its own rows make it ${own}`);
  }
  let verdict = verdictFrom(statuses);
  if (receipt.verdict in RANK) verdict = worst(verdict, receipt.verdict);
  else problems.push(`the receipt's verdict "${receipt.verdict}" is not one atris check writes`);
  return {
    ok: problems.length === 0,
    problems,
    why: problems.join('; '),
    verdict: problems.length ? null : verdict,
    tier: picked.tier,
    needs_lane: needsLane,
    plan: picked,
    rules,
    change,
  };
}

module.exports = { MAP_FILE, mapAt, rulesFor, planFor, canonRun, recheckReceipt };
