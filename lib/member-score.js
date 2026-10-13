'use strict';

// Member score gate: keep a member's change only when its own number got
// better. A member declares a score command in MEMBER.md frontmatter:
//
//   score: node scripts/det/ytrail-bench.js --quick --score
//   score_runs: 2        (runs per side, median wins; default 1)
//   score_margin: 0.1    (fraction the value must improve by; default 0.05)
//
// The defaults suit a steady number. A noisy one needs both raised: the
// youtube bench swings about 15% run to run, and 1 run at 5% kept a no-op
// change about 40% of the time; 5 runs at 20% keeps one about 2% of the time.
//
// The command's last JSON line carries { pass, total, value, better }.
// `gate` measures the base commit and the candidate checkout in alternating
// runs (A B A B) so network or machine drift lands on both sides, then says
// better or not. Each result is appended to the main checkout's history so
// the member's scoreboard survives a reaped worktree.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCORE_SCHEMA = 'atris.member_score.v1';
const HISTORY_DIR = path.join('.atris', 'state', 'member-scores');
const DEFAULT_MARGIN = 0.05;
const DEFAULT_RUNS = 1;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function scoreConfig(frontmatter = {}) {
  const command = typeof frontmatter.score === 'string' ? frontmatter.score.trim() : '';
  if (!command) return null;
  const runs = Number(frontmatter.score_runs);
  const margin = Number(frontmatter.score_margin);
  return {
    command,
    runs: Number.isInteger(runs) && runs >= 1 && runs <= 9 ? runs : DEFAULT_RUNS,
    margin: Number.isFinite(margin) && margin >= 0 && margin < 1 ? margin : DEFAULT_MARGIN,
  };
}

// Last stdout line that parses as a score object, else null.
function parseScore(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (row && Number.isFinite(Number(row.pass)) && Number.isFinite(Number(row.total)) && Number.isFinite(Number(row.value))) {
        return {
          pass: Number(row.pass),
          total: Number(row.total),
          value: Number(row.value),
          unit: row.unit || '',
          better: row.better === 'higher' ? 'higher' : 'lower',
        };
      }
    } catch {
      // not a score line
    }
  }
  return null;
}

function runOnce(command, cwd, spawn = spawnSync) {
  const r = spawn(command, { cwd, shell: true, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env: process.env });
  const score = parseScore(r.stdout);
  if (!score) {
    const tail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, error: `score command printed no score line (exit ${r.status})${tail ? `: ${tail}` : ''}` };
  }
  return { ok: true, score };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Fold several runs of one side into one score: worst pass count (a flaky
// case counts against you), median value.
function combine(scores) {
  return {
    pass: Math.min(...scores.map((s) => s.pass)),
    total: Math.max(...scores.map((s) => s.total)),
    value: Number(median(scores.map((s) => s.value)).toFixed(2)),
    unit: scores[0].unit,
    better: scores[0].better,
    runs: scores.length,
  };
}

// Better means: more cases pass, or the same cases pass and the value moved
// the right way by at least the margin. Anything else is not better.
function compare(base, candidate, margin = DEFAULT_MARGIN) {
  if (candidate.pass < base.pass) {
    return { better: false, reason: `fewer cases pass (${candidate.pass}/${candidate.total} vs ${base.pass}/${base.total})` };
  }
  if (candidate.pass > base.pass) {
    return { better: true, reason: `more cases pass (${candidate.pass}/${candidate.total} vs ${base.pass}/${base.total})` };
  }
  const unit = candidate.unit || '';
  const delta = candidate.better === 'higher' ? candidate.value - base.value : base.value - candidate.value;
  const needed = Math.abs(base.value) * margin;
  const pct = base.value ? Math.round((delta / Math.abs(base.value)) * 100) : 0;
  const moved = `${base.value}${unit} -> ${candidate.value}${unit} (${pct >= 0 ? '' : '-'}${Math.abs(pct)}% ${delta >= 0 ? 'better' : 'worse'})`;
  if (delta > 0 && delta >= needed) return { better: true, reason: `${moved}, past the ${Math.round(margin * 100)}% margin` };
  return { better: false, reason: `${moved}, needs ${Math.round(margin * 100)}% better` };
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

// The commit the candidate grew from: merge-base with $ATRIS_SCORE_BASE when
// set (a mission cut from a feature branch compares against that branch),
// else master (or main), local branch first, then origin.
function baseCommit(cwd, env = process.env) {
  const refs = env.ATRIS_SCORE_BASE ? [env.ATRIS_SCORE_BASE] : ['master', 'origin/master', 'main', 'origin/main'];
  for (const ref of refs) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', ref])) continue;
    const base = git(cwd, ['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  return null;
}

function withBaseCheckout(cwd, commit, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-score-base-'));
  const added = spawnSync('git', ['-C', cwd, 'worktree', 'add', '--detach', '--quiet', dir, commit], { encoding: 'utf8', timeout: 120000 });
  if (added.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not check out base ${commit.slice(0, 8)}: ${String(added.stderr || '').trim()}`);
  }
  try {
    return fn(dir);
  } finally {
    spawnSync('git', ['-C', cwd, 'worktree', 'remove', '--force', dir], { encoding: 'utf8', timeout: 60000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A/B the base commit against the candidate checkout at cwd.
function gate(config, cwd, { runOne = runOnce, baseDir = null } = {}) {
  const commit = baseDir ? null : baseCommit(cwd);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const dirty = Boolean(git(cwd, ['status', '--porcelain']));
  if (!baseDir && !commit) return { ok: false, error: `no ${process.env.ATRIS_SCORE_BASE || 'master or main'} branch to compare against` };
  if (!baseDir && commit === head && !dirty) {
    return { ok: false, error: 'nothing to compare: this checkout has no change on top of master' };
  }
  const measure = (dir) => {
    const baseRuns = [];
    const candidateRuns = [];
    for (let i = 0; i < config.runs; i += 1) {
      const b = runOne(config.command, dir);
      if (!b.ok) return { ok: false, error: `base: ${b.error}` };
      baseRuns.push(b.score);
      const c = runOne(config.command, cwd);
      if (!c.ok) return { ok: false, error: `candidate: ${c.error}` };
      candidateRuns.push(c.score);
    }
    const base = combine(baseRuns);
    const candidate = combine(candidateRuns);
    return { ok: true, base, candidate, ...compare(base, candidate, config.margin) };
  };
  const result = baseDir ? measure(baseDir) : withBaseCheckout(cwd, commit, measure);
  return { ...result, base_commit: commit, head, dirty };
}

function historyPath(member, root = process.cwd()) {
  const { mainCheckoutRoot } = require('./engine-registry');
  const main = mainCheckoutRoot(root);
  const home = main && fs.existsSync(main) ? main : root;
  return path.join(home, HISTORY_DIR, `${member}.jsonl`);
}

function appendHistory(member, row, root = process.cwd()) {
  const file = historyPath(member, root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ schema: SCORE_SCHEMA, at: new Date().toISOString(), member, ...row })}\n`);
    return file;
  } catch {
    return null;
  }
}

function readHistory(member, root = process.cwd()) {
  try {
    return fs.readFileSync(historyPath(member, root), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  scoreConfig,
  parseScore,
  runOnce,
  combine,
  compare,
  gate,
  historyPath,
  appendHistory,
  readHistory,
};
