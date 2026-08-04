'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadOverrides, pickLane } = require('../lib/ax-auto-lane');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_GOLD_PATH = path.join(REPO_ROOT, 'scripts', 'det', 'data', 'ax-lane-gold.jsonl');
const LANE_ORDER = ['fast', 'pro', 'max', 'code-fast'];
const DEPTH = { fast: 0, 'code-fast': 1, pro: 1, max: 2 };
const QUALITY_MISS_WEIGHT = 3;

// Preserve alias priority and inline-value priority within each alias.
function readFirstNamedFlag(args, names) {
  for (const name of names) {
    const prefix = `${name}=`;
    const inline = args.find((arg) => String(arg).startsWith(prefix));
    if (inline) return String(inline).slice(prefix.length);
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] && !String(args[index + 1]).startsWith('--')) {
      return String(args[index + 1]);
    }
  }
  return null;
}

function resolveRouterPaths(args = [], env = process.env) {
  const home = env.HOME || os.homedir();
  return {
    picks: path.resolve(readFirstNamedFlag(args, ['--picks', '--picks-path'])
      || env.ATRIS_ROUTER_PICKS_PATH
      || env.ATRIS_AX_AUTO_PICKS_PATH
      || path.join(home, '.atris', 'ax-auto-picks.jsonl')),
    overrides: path.resolve(readFirstNamedFlag(args, ['--overrides', '--overrides-path'])
      || env.ATRIS_ROUTER_OVERRIDES_PATH
      || path.join(home, '.atris', 'router-overrides.json')),
    gold: path.resolve(readFirstNamedFlag(args, ['--gold', '--gold-path'])
      || env.ATRIS_ROUTER_GOLD_PATH
      || DEFAULT_GOLD_PATH),
  };
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch (_) {
          return [];
        }
      });
  } catch (_) {
    return [];
  }
}

function outcomeKind(row) {
  if (!row || row.event !== 'outcome') return null;
  if (row.outcome === 'rephrased') return 'rephrased';
  if (row.ok === true || row.outcome === 'ok') return 'ok';
  if (row.ok === false || row.outcome === 'error' || row.error) return 'error';
  return null;
}

function routerStatus(records, overrides) {
  const picks = Object.fromEntries(LANE_ORDER.map((lane) => [lane, 0]));
  const outcomes = { ok: 0, error: 0, rephrased: 0 };
  for (const row of records) {
    if (row && row.event !== 'outcome' && Object.hasOwn(picks, row.lane)) picks[row.lane] += 1;
    const kind = outcomeKind(row);
    if (kind) outcomes[kind] += 1;
  }
  return {
    picks,
    outcomes,
    active_overrides: Array.isArray(overrides) ? overrides.length : 0,
  };
}

function printStatus(status, output = console.log) {
  for (const lane of LANE_ORDER) output(`${lane} picks: ${status.picks[lane]}`);
  output(`ok outcomes: ${status.outcomes.ok}`);
  output(`error outcomes: ${status.outcomes.error}`);
  output(`rephrased outcomes: ${status.outcomes.rephrased}`);
  output(`active overrides: ${status.active_overrides}`);
}

function messageWords(message) {
  return String(message || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function signatureForPick(pick) {
  const firstWords = messageWords(pick && pick.message).slice(0, 2);
  if (!pick || !pick.lane || !firstWords.length) return null;
  return `${firstWords.join(' ')}|${pick.lane}`;
}

function nextLane(lane) {
  if (lane === 'fast') return 'pro';
  if (lane === 'pro' || lane === 'code-fast') return 'max';
  return null;
}

function groupPicksBySignature(records) {
  const outcomesByPick = new Map();
  for (const row of records) {
    const kind = outcomeKind(row);
    if (!kind || !row.pick_id) continue;
    if (!outcomesByPick.has(row.pick_id)) outcomesByPick.set(row.pick_id, new Set());
    outcomesByPick.get(row.pick_id).add(kind);
  }

  const groups = new Map();
  for (const pick of records) {
    if (!pick || pick.event === 'outcome' || !pick.pick_id) continue;
    const signature = signatureForPick(pick);
    if (!signature) continue;
    if (!groups.has(signature)) {
      groups.set(signature, {
        signature,
        lane: pick.lane,
        words: messageWords(pick.message).slice(0, 2),
        picks: [],
        bad_picks: [],
      });
    }
    const group = groups.get(signature);
    group.picks.push(pick);
    const kinds = outcomesByPick.get(pick.pick_id) || new Set();
    if (kinds.has('error') || kinds.has('rephrased')) group.bad_picks.push(pick);
  }
  return groups;
}

function promotionCandidates(records, minimumMisses = 3) {
  const candidates = [];
  for (const group of groupPicksBySignature(records).values()) {
    const promotedLane = nextLane(group.lane);
    const misses = group.bad_picks.length;
    if (!promotedLane || misses < minimumMisses) continue;
    const idHash = crypto.createHash('sha256').update(group.signature).digest('hex').slice(0, 12);
    candidates.push({
      signature: group.signature,
      misses,
      from_lane: group.lane,
      override: {
        id: `learned-${idHash}`,
        test: { startsWith: group.words.join(' ') },
        lane: promotedLane,
        reason: `learned from ${misses} misses`,
      },
    });
  }
  return candidates.sort((left, right) => left.signature.localeCompare(right.signature));
}

function evaluateRows(rows, overrides = []) {
  let correct = 0;
  let weightedError = 0;
  for (const row of rows) {
    const picked = pickLane(row.message, { overrides }).lane;
    if (picked === row.lane) {
      correct += 1;
      continue;
    }
    weightedError += DEPTH[picked] < DEPTH[row.lane] ? QUALITY_MISS_WEIGHT : 1;
  }
  const total = rows.length;
  return {
    total,
    correct,
    accuracy: total ? correct / total : 0,
    weighted_error_rate: total ? weightedError / (total * QUALITY_MISS_WEIGHT) : 0,
    weighted_accuracy: total ? 1 - (weightedError / (total * QUALITY_MISS_WEIGHT)) : 0,
  };
}

function runCandidateHarness(args = [], env = process.env) {
  const paths = resolveRouterPaths(args, env);
  const candidate = JSON.parse(env.ATRIS_ROUTER_CANDIDATE_JSON || '{}');
  const rows = readJsonl(paths.gold);
  process.stdout.write(`${JSON.stringify(evaluateRows(rows, [candidate]))}\n`);
  return rows.length ? 0 : 2;
}

function runSealedEval(goldPath, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const evalScript = path.join(REPO_ROOT, 'scripts', 'det', 'ax-lane-eval.js');
  const args = [evalScript, '--json'];
  if (path.resolve(goldPath) !== path.resolve(DEFAULT_GOLD_PATH)) args.push('--data', goldPath);
  const result = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(String((result.error && result.error.message) || result.stderr || 'sealed eval failed').trim());
  }
  const report = JSON.parse(result.stdout);
  return {
    ...report,
    weighted_accuracy: 1 - Number(report.weighted_error_rate || 0),
  };
}

function runOverrideEval(goldPath, override, options = {}) {
  const spawn = options.spawnSync || spawnSync;
  const result = spawn(process.execPath, [__filename, '_eval-candidate', '--gold', goldPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...(options.env || process.env),
      ATRIS_ROUTER_CANDIDATE_JSON: JSON.stringify(override),
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(String((result.error && result.error.message) || result.stderr || 'override eval failed').trim());
  }
  return JSON.parse(result.stdout);
}

function evaluateCandidateGate(goldPath, override, options = {}) {
  const baseline = runSealedEval(goldPath, options);
  const candidate = runOverrideEval(goldPath, override, options);
  return {
    keep: candidate.weighted_accuracy >= baseline.weighted_accuracy,
    baseline,
    candidate,
  };
}

function writeOverrides(filePath, overrides) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function promote(args, paths, options = {}) {
  const output = options.output || console.log;
  const records = readJsonl(paths.picks);
  const candidates = promotionCandidates(records);
  const existing = loadOverrides(paths.overrides);
  const accepted = [];
  if (!candidates.length) {
    output('no promotion candidates');
    return { code: 0, candidates, accepted };
  }

  for (const candidate of candidates) {
    output(`candidate ${candidate.signature}: ${candidate.from_lane} -> ${candidate.override.lane}, ${candidate.override.reason}`);
    if (existing.some((override) => override.id === candidate.override.id)) {
      output(`keep ${candidate.override.id}: already active`);
      continue;
    }
    const gate = evaluateCandidateGate(paths.gold, candidate.override, options);
    const before = gate.baseline.weighted_accuracy.toFixed(4);
    const after = gate.candidate.weighted_accuracy.toFixed(4);
    if (!gate.keep) {
      output(`revert ${candidate.override.id}: weighted accuracy ${before} -> ${after}, candidate rejected`);
      continue;
    }
    output(`keep ${candidate.override.id}: weighted accuracy ${before} -> ${after}`);
    accepted.push(candidate.override);
  }

  if (args.includes('--dry-run')) {
    output('dry run: no overrides written');
  } else if (accepted.length) {
    writeOverrides(paths.overrides, [...existing, ...accepted]);
    output(`promoted overrides: ${accepted.length}`);
  } else {
    output('promoted overrides: 0');
  }
  return { code: 0, candidates, accepted };
}

function printHelp(output = console.log) {
  output('usage: atris router status [--picks <path>] [--overrides <path>]');
  output('usage: atris router promote [--dry-run] [--picks <path>] [--overrides <path>] [--gold <path>]');
}

function routerCommand(args = [], options = {}) {
  const env = options.env || process.env;
  const output = options.output || console.log;
  const paths = resolveRouterPaths(args, env);
  const subcommand = args[0] || 'status';
  if (subcommand === 'status') {
    printStatus(routerStatus(readJsonl(paths.picks), loadOverrides(paths.overrides)), output);
    return 0;
  }
  if (subcommand === 'promote') return promote(args.slice(1), paths, { ...options, env, output }).code;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printHelp(output);
    return 0;
  }
  printHelp(output);
  return 2;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  process.exitCode = args[0] === '_eval-candidate'
    ? runCandidateHarness(args.slice(1))
    : routerCommand(args);
}

module.exports = {
  groupPicksBySignature,
  nextLane,
  promotionCandidates,
  readJsonl,
  routerCommand,
};
