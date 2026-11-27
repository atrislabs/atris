'use strict';

// atris check replay: the plan each recent commit on the default branch would
// get, as if that commit were the change. Nothing runs and nothing in the
// checkout changes: every file is read from git objects. It shows the feel in
// numbers (how many seconds a change of each tier costs) and finds the gaps
// (changes no test covers).
//
// Commits are walked first-parent, so a merged pull request counts once with
// its whole diff. Commits that only touch docs (the map's risk.low globs) are
// skipped and counted.

const { spawnSync } = require('child_process');
const plan = require('./check-plan');
const budget = require('./check-budget');
const { planOptions } = require('./check-context');
const { globsMatch } = require('./check-glob');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function lineCount(root, parent, sha) {
  let total = 0;
  for (const row of git(root, ['diff', '--numstat', '--no-renames', parent, sha]).split('\n').filter(Boolean)) {
    const [added, removed] = row.split('\t');
    if (added === '-' || removed === '-') return Infinity;
    total += Number(added) + Number(removed);
  }
  return total;
}

function share(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
}

// One commit's plan, reduced to what replay reports.
function replayCommit(root, map, sha, parent, files, memo, history) {
  const options = planOptions(root, map, files, { rev: sha, base: parent, memo, writeCache: false });
  const picked = plan.planChecks(map, files, options);
  for (const entry of picked.selected) {
    const guess = budget.estimate(entry, history);
    entry.expected = guess.seconds;
    entry.expectedFrom = guess.source;
  }
  const here = picked.selected.filter((entry) => entry.where === 'here');
  // Where each time came from: measured on this machine, the map's own
  // seconds, a default guess, or none at all.
  const timesFrom = { measured: 0, map: 0, default: 0, unknown: 0 };
  for (const entry of here) timesFrom[entry.expectedFrom in timesFrom ? entry.expectedFrom : 'unknown'] += 1;
  const expected = budget.planSeconds(here, map.parallel);
  const selections = Object.values(picked.selections);
  const selectedTests = selections.filter((sel) => sel.mode === 'tests').reduce((n, sel) => n + sel.tests.length, 0);
  const fellBack = selections.some((sel) => sel.mode === 'fallback');
  const lines = lineCount(root, parent, sha);
  const lanes = picked.selected.filter((entry) => entry.where !== 'here');
  const stageWhy = [];
  if (picked.tier === 'high') stageWhy.push(`high risk (${picked.highKinds.join(', ')})`);
  if (files.length > map.push.maxFiles || lines > map.push.maxLines) stageWhy.push(`big (${files.length} files, ${lines === Infinity ? 'binary' : lines} lines)`);
  if (picked.unmapped.length) stageWhy.push(`${picked.unmapped.length} unmapped`);
  if (lanes.length && !(map.push.aheadOfLane && picked.tier === 'low')) stageWhy.push(`${lanes.length} need a lane`);
  const slow = here.filter((entry) => entry.expected).sort((a, b) => b.expected - a.expected)[0];
  return {
    sha: sha.slice(0, 12),
    subject: git(root, ['log', '-1', '--format=%s', sha]).trim().slice(0, 90),
    tier: picked.tier,
    files: files.length,
    lines: lines === Infinity ? null : lines,
    selected_tests: selectedTests,
    fallback: fellBack,
    fallback_why: selections.filter((sel) => sel.mode === 'fallback').map((sel) => sel.why),
    uncovered: picked.uncovered,
    checks: here.map((entry) => entry.key),
    expected_seconds: expected,
    // A check with no measured or declared time counts as 0s in expected_seconds,
    // so this row is left out of the medians.
    unknown_seconds: here.some((entry) => entry.expected === null),
    times_from: timesFrom,
    slowest: slow ? { check: slow.key, seconds: slow.expected } : null,
    target_seconds: picked.target,
    over_target: Boolean(picked.target && expected > picked.target),
    would: stageWhy.length ? 'stage' : 'push',
    stage_why: stageWhy,
  };
}

function summarize(rows, skippedDocs) {
  const tiers = {};
  const timed = (list) => list.filter((row) => !row.unknown_seconds).map((row) => row.expected_seconds);
  for (const tier of plan.TIERS) {
    const list = rows.filter((row) => row.tier === tier);
    tiers[tier] = {
      commits: list.length,
      share_percent: share(list.length, rows.length),
      median_seconds: budget.median(timed(list)),
      p90_seconds: budget.percentile(timed(list), 90),
      over_target: list.filter((row) => row.over_target).length,
    };
  }
  const gaps = new Map();
  for (const row of rows) for (const file of row.uncovered) gaps.set(file, (gaps.get(file) || 0) + 1);
  const timesFrom = { measured: 0, map: 0, default: 0, unknown: 0 };
  for (const row of rows) for (const [from, n] of Object.entries(row.times_from || {})) timesFrom[from] = (timesFrom[from] || 0) + n;
  return {
    commits: rows.length,
    skipped_docs_only: skippedDocs,
    tiers,
    zero_cover_percent: share(rows.filter((row) => row.uncovered.length).length, rows.length),
    fallback_percent: share(rows.filter((row) => row.fallback).length, rows.length),
    push_now_percent: share(rows.filter((row) => row.would === 'push').length, rows.length),
    median_seconds: budget.median(timed(rows)),
    p90_seconds: budget.percentile(timed(rows), 90),
    unknown_seconds_commits: rows.filter((row) => row.unknown_seconds).length,
    times_from: timesFrom,
    top_uncovered: [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, count]) => ({ file, commits: count })),
  };
}

function replay(root, map, { last = 20, base, onRow } = {}) {
  const ref = base;
  const list = git(root, ['rev-list', '--first-parent', '--parents', `--max-count=${last * 5}`, ref]).split('\n').filter(Boolean);
  const memo = {};
  const history = budget.loadDurations(root);
  const rows = [];
  let skippedDocs = 0;
  for (const line of list) {
    if (rows.length >= last) break;
    const [sha, parent] = line.split(' ');
    if (!parent) continue;
    const files = git(root, ['diff', '--name-only', '-z', '--no-renames', parent, sha]).split('\0').filter(Boolean);
    if (!files.length) continue;
    if (files.every((file) => globsMatch(map.risk.low, file))) { skippedDocs += 1; continue; }
    const row = replayCommit(root, map, sha, parent, files, memo, history);
    rows.push(row);
    if (onRow) onRow(row);
  }
  return { base: ref, rows, summary: summarize(rows, skippedDocs) };
}

function summaryLines(result) {
  const s = result.summary;
  const lines = [];
  lines.push(`atris check replay: ${s.commits} commits on ${result.base}, ${s.skipped_docs_only} docs-only skipped; nothing was run`);
  for (const tier of plan.TIERS) {
    const t = s.tiers[tier];
    if (!t.commits) { lines.push(`  ${tier.padEnd(7)} 0 commits`); continue; }
    lines.push(`  ${tier.padEnd(7)} ${String(t.commits).padStart(3)} commits (${t.share_percent}%)  median ${t.median_seconds}s  p90 ${t.p90_seconds}s  over target ${t.over_target}`);
  }
  lines.push(`  all     median ${s.median_seconds}s  p90 ${s.p90_seconds}s`);
  if (s.unknown_seconds_commits) lines.push(`  ${s.unknown_seconds_commits} commit${s.unknown_seconds_commits === 1 ? '' : 's'} picked a check with no time (no "seconds" in the map, never measured here), left out of the medians; give those checks "seconds"`);
  lines.push(`  a changed file no test covers: ${s.zero_cover_percent}% of commits; ran the fallback: ${s.fallback_percent}%; would push now: ${s.push_now_percent}%`);
  const from = s.times_from || {};
  const timed = (from.measured || 0) + (from.map || 0) + (from.default || 0) + (from.unknown || 0);
  if (timed) lines.push(`  times: ${from.measured || 0} of ${timed} check runs measured on this machine, ${from.map || 0} from the map's seconds, ${(from.default || 0) + (from.unknown || 0)} guessed or unknown${from.measured ? '' : '; none are measured, so read these as the map\'s numbers'}`);
  if (s.top_uncovered.length) {
    lines.push('  files most often with no covering test:');
    for (const gap of s.top_uncovered) lines.push(`    ${gap.file} (${gap.commits} commit${gap.commits === 1 ? '' : 's'})`);
  }
  return lines;
}

function rowLine(row) {
  const tests = row.fallback ? 'fallback' : `${row.selected_tests} test${row.selected_tests === 1 ? '' : 's'}`;
  return `${row.sha} ${row.tier.padEnd(6)} ${String(Math.round(row.expected_seconds)).padStart(4)}s  ${tests.padEnd(9)} ${row.would.padEnd(5)} ${row.subject}`;
}

module.exports = { replay, replayCommit, summarize, summaryLines, rowLine };
