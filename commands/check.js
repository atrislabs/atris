'use strict';

// atris check: a quick check that proves a change, then pushes it.
//
//   atris check                    pick checks by rule, run what may run here,
//                                  check the change's own proof, scan for keys,
//                                  write .atris/receipts/check-<sha>.json
//   atris check --explain          print the plan, run nothing
//   atris check --verify [--receipt <file>]
//                                  does a receipt prove the code here now?
//   atris check --push | push      update on the default branch, check that exact
//                                  code, then push it straight to the default
//                                  branch (small, safe, proven) or stage it on
//                                  atris/ready/<sha> for the no-screen lane
//   atris check land <sha>         (a runner with no screen) run the rest, then
//                                  fast-forward the default branch from the staged ref
//   atris check sweep              remove staged refs that landed over 7 days ago
//   atris check fix [--dry-run]    hand a failed receipt to CodeOps, one job per receipt
//   atris check init               write a starter atris/checks.json
//   atris check --lint-map         check atris/checks.json itself (also done at
//                                  the start of every check)
//   atris check replay --last <n>  the plan each of the last n commits on the
//                                  default branch would get; runs nothing
//
// Exit codes: 0 proven, 3 partly or staged (needs a lane), 1 failed,
// 2 usage or map error. A check that did not run is never a pass.
// Rules and tiers: lib/check-plan.js. Test selection: lib/check-select.js.
// Time budget: lib/check-budget.js. Receipt: lib/check-receipt.js. Proof and
// key scan: lib/check-proof.js. Import graph: lib/check-imports.js. What the
// planner sees of a repo: lib/check-context.js. Replay: lib/check-replay.js.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const plan = require('../lib/check-plan');
const receipts = require('../lib/check-receipt');
const proofs = require('../lib/check-proof');
const budget = require('../lib/check-budget');
const recompute = require('../lib/check-recompute');
const receiptRefs = require('../lib/check-receipt-ref');
const { planOptions, mainCheckout } = require('../lib/check-context');

const { EXIT } = receipts;
const VALUE_FLAGS = new Set(['--base', '--files', '--lane', '--receipt', '--gate', '--parallel', '--timeout', '--proof', '--last', '--map']);
const LOCAL_FLAGS = new Set([...VALUE_FLAGS, '--explain', '--verify', '--allow-paid', '--push', '--deep', '--dry-run', '--lint-map']);
const SUBCOMMANDS = new Set(['init', 'push', 'land', 'sweep', 'fix', 'replay']);
const LANES = ['here', 'no-screen'];
// A receipt keeps no logs: only the last 40 lines of a failed check.
const TAIL_LINES = 40;
const OUTPUT_TAIL = 4000;
const STALE_READY_DAYS = 7;
const CODEOPS_BUSINESS = 'atris-codeops';
const PROOF_TIMEOUT_SECONDS = 300;
const PUSH_TRIES = 3;
const STAGED_LINE = 'staged: waits for the no-screen lane';

class UsageError extends Error {}

function usage(log) {
  log('Usage: atris check [--explain] [--base <ref> | --files <a,b>] [--proof "<cmd>"] [--deep] [--lane here|no-screen] [--allow-paid] [--gate <name>] [--json]');
  log('       atris check --push            (or: atris check push)');
  log('       atris check --verify [--receipt <file>] [--json]');
  log('       atris check land <sha>        on a runner with no screen');
  log('       atris check sweep             remove landed staged refs older than 7 days, list the rest');
  log('       atris check fix [--receipt <file>] [--dry-run]   hand a failed receipt to CodeOps');
  log('       atris check init [--print]');
  log('       atris check --lint-map        check the map itself');
  log('       atris check replay --last <n> [--json] [--map <file>]   plans for recent commits, runs nothing');
  log('       atris check <mission-id> [--json]   checks of a cloud mission');
  log('');
  log('Picks checks from atris/checks.json by rule, runs the ones that may run on this machine,');
  log("checks the change's own proof, scans the change for keys, and writes one receipt in");
  log(".atris/receipts/. Checks marked no-screen or paid never run on a person's machine; they");
  log('are recorded as needing that lane, and that is never a pass. Each change gets a risk tier:');
  log('low (docs, comments, styles, tests) runs only quick checks, normal runs the few tests that');
  log('cover it, high runs those first and then the whole release gate. Every plan shows its seconds.');
  log('Exit: 0 proven, 3 needs a lane (or staged), 1 failed, 2 usage or map error.');
}

// `atris check <mission-id>` keeps meaning the cloud mission checks. Everything
// else (no id, a subcommand, or any local flag) is the local check.
function isLocalCheck(args) {
  if (SUBCOMMANDS.has(args[0])) return true;
  if (args.some((arg) => LOCAL_FLAGS.has(arg))) return true;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) { i += 1; continue; }
    if (!String(args[i]).startsWith('-')) positionals.push(args[i]);
  }
  return positionals.length === 0;
}

function parseArgs(args) {
  const options = { explain: false, verify: false, json: false, allowPaid: false, push: false, deep: false, lane: 'here' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return String(next);
    };
    if (arg === '--explain') options.explain = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-paid') options.allowPaid = true;
    else if (arg === '--push') options.push = true;
    else if (arg === '--deep') options.deep = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--lint-map') options.lintMap = true;
    else if (arg === '--last') options.last = Number(value());
    else if (arg === '--map') options.mapFile = value();
    else if (arg === '--base') options.base = value();
    else if (arg === '--files') options.files = value().split(',').map((file) => file.trim().replace(/^\.\//, '')).filter(Boolean);
    else if (arg === '--lane') options.lane = value();
    else if (arg === '--receipt') options.receipt = value();
    else if (arg === '--gate') options.gate = value();
    else if (arg === '--proof') options.proof = value();
    else if (arg === '--parallel') options.parallel = Number(value());
    else if (arg === '--timeout') options.timeout = Number(value());
    else throw new UsageError(`unknown option ${arg}`);
  }
  if (!LANES.includes(options.lane)) throw new UsageError(`--lane is here or no-screen, not ${options.lane}`);
  if (options.base && options.files) throw new UsageError('use --base or --files, not both');
  if (options.push && (options.files || options.base || options.gate)) throw new UsageError('--push checks the whole change against the default branch; drop --files, --base and --gate');
  if (options.parallel !== undefined && !(Number.isInteger(options.parallel) && options.parallel > 0)) throw new UsageError('--parallel needs a whole number above 0');
  if (options.timeout !== undefined && !(options.timeout > 0)) throw new UsageError('--timeout needs seconds above 0');
  if (options.last !== undefined && !(Number.isInteger(options.last) && options.last > 0)) throw new UsageError('--last needs a whole number above 0');
  return options;
}

// What happens to a picked check in this lane: run it, or record which lane it needs.
function placement(entry, options) {
  if (entry.where === 'paid' && !options.allowPaid) return { run: false, lane: 'paid' };
  if (entry.where === 'no-screen' && options.lane !== 'no-screen') return { run: false, lane: 'no-screen' };
  return { run: true, lane: null };
}

function seconds(ms) {
  return Math.round(ms / 100) / 10;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(null));
  });
}

// The cage. Every check gets its own process group and a hard timeout that
// kills the whole group. A here check also gets an environment that keeps
// windows shut even when the map got its label wrong: CI=1, BROWSER=none, the
// desktop app's launch opt-in removed, and ELECTRON_RUN_AS_NODE=1 (Electron
// then starts as plain node, with no window). A check that truly needs the app
// says needsElectron in the map, which sends it to the no-screen lane instead.
function cageEnv(entry, context) {
  const env = { ...process.env, ATRIS_CHECK: '1', CI: '1', BROWSER: 'none' };
  if (context.person) env.ATRIS_CHECK_PERSON = '1';
  // A check is its own run, never a child of whatever test runner started atris.
  delete env.NODE_TEST_CONTEXT;
  if (entry.where === 'here' || context.person) {
    delete env.OBELISK_ALLOW_APP_LAUNCH;
    if (!entry.needsElectron) env.ELECTRON_RUN_AS_NODE = '1';
  }
  if (entry.port && context.port) env.PORT = String(context.port);
  // The map's own env for the check (a selector's test settings) comes first;
  // the cage's window guards above cannot be undone by it.
  const own = { ...(entry.env || {}) };
  for (const key of ['ATRIS_CHECK', 'CI', 'BROWSER', 'ELECTRON_RUN_AS_NODE', 'OBELISK_ALLOW_APP_LAUNCH']) delete own[key];
  return { ...env, ...own, ...(context.extraEnv || {}) };
}

// Every running check's process group, so a stop from outside (the lander's
// time limit sends SIGTERM) takes the checks down with atris check.
const RUNNING = new Set();
let stopHandler = false;

function stopRunningOnSignal() {
  if (stopHandler) return;
  stopHandler = true;
  process.once('SIGTERM', () => {
    for (const pid of RUNNING) {
      try { if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch {}
    }
    process.exit(143);
  });
}

function runCaged(command, root, env, timeoutSeconds) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd: root,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    let timedOut = false;
    if (child.pid) RUNNING.add(child.pid);
    const keep = (chunk) => { out = (out + chunk).slice(-64 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutSeconds * 1000);
    child.on('error', (error) => { out += String(error && error.message || error); });
    // `exit`, not `close`: a grandchild holding the pipes open must not keep a
    // finished check alive, and the group kill below reaps it either way.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      killGroup();
      RUNNING.delete(child.pid);
      setImmediate(() => resolve({ code: Number.isInteger(code) ? code : null, signal: signal || null, timedOut, out, ms: Date.now() - startedAt }));
    });
  });
}

async function inPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function tail(text) {
  const lines = String(text || '').trim().split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > OUTPUT_TAIL ? `...${lines.slice(-OUTPUT_TAIL)}` : lines;
}

// Turn one run into a receipt row. A check whose output says it skipped
// itself (the map's skip lines) did not run here: needs-lane, whatever it exited.
function resultRow(entry, run, skipLines) {
  const row = { name: entry.key, run: entry.run, where: entry.where, why: entry.reasons, seconds: seconds(run.ms), exit_code: run.code };
  if (run.timedOut) return { ...row, status: 'failed', note: 'timed out, its whole process group was stopped', output_tail: tail(run.out) };
  if (skipLines.some((line) => run.out.includes(line))) {
    return { ...row, status: 'needs-lane', lane: 'no-screen', note: 'the check skipped itself here' };
  }
  if (run.code === 0) return { ...row, status: 'passed' };
  return { ...row, status: 'failed', output_tail: tail(run.out) };
}

function timeoutFor(entry, options) {
  if (options.timeout) return options.timeout;
  if (entry.timeoutSeconds) return entry.timeoutSeconds;
  return Math.max(120, (entry.seconds || 0) * 4);
}

function readMapFile(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { raw: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `${path.basename(file)} is not valid JSON: ${error.message}` };
  }
}

// Every check starts here, so a bad map (a slow always, a chained command)
// stops it before anything runs.
function loadMap(root, log, options = {}) {
  try {
    if (options.mapFile) {
      const read = readMapFile(path.resolve(options.mapFile));
      if (read.missing) { log(`atris check: no map at ${options.mapFile}`); return null; }
      if (read.error) { log(`atris check: ${read.error}`); return null; }
      return plan.validateMap(read.raw);
    }
    const map = plan.loadMap(root);
    if (!map) log('atris check: this project has no atris/checks.json yet. Run atris check init to write a starter.');
    return map;
  } catch (error) {
    if (error instanceof plan.CheckMapError) { log(`atris check: ${error.message}`); log('atris check: the map was refused, so nothing ran (atris check --lint-map lists every problem)'); return null; }
    throw error;
  }
}

function lintMapCommand(root, options, log) {
  const file = options.mapFile ? path.resolve(options.mapFile) : path.join(root, plan.MAP_PATH);
  const read = readMapFile(file);
  if (read.missing) { log('atris check --lint-map: no atris/checks.json here. Run atris check init to write a starter.'); return EXIT.usage; }
  if (read.error) { log(`atris check --lint-map: ${read.error}`); return EXIT.usage; }
  const history = budget.loadDurations(root);
  const result = plan.lintMap(read.raw, { durations: (name) => (history[name] ? budget.median(history[name].s) : null) });
  if (options.json) log(JSON.stringify(result, null, 2));
  else {
    for (const error of result.errors) log(`  refused  ${error}`);
    for (const warning of result.warnings) log(`  note     ${warning}`);
    log(result.errors.length ? `atris check --lint-map: ${result.errors.length} problem(s); every check refuses this map until they are fixed` : `atris check --lint-map: the map is fine (${Object.keys(read.raw.checks).length} checks)`);
  }
  return result.errors.length ? EXIT.usage : EXIT.proven;
}

function replayCommand(root, map, options, log) {
  const { replay, summaryLines: replayLines, rowLine } = require('../lib/check-replay');
  const base = options.base || receipts.defaultBase(root);
  if (!base) { log('atris check replay: could not find the default branch; pass --base <ref>'); return EXIT.usage; }
  const result = replay(root, map, { last: options.last || 20, base, onRow: options.json ? null : (row) => log(rowLine(row)) });
  if (options.json) log(JSON.stringify(result, null, 2));
  else for (const line of replayLines(result)) log(line);
  return EXIT.proven;
}

// The plan for this change: changed files, the import graph, the picks, and
// each pick's expected seconds.
// The map that decides is the default branch's (lib/check-recompute.js
// rulesFor): a change that edits atris/checks.json is checked by the map it
// would replace, and its settings (skip lines, the key scan, push limits) too.
function makePlan(root, ownMap, options) {
  const change = receipts.changeSet(root, { base: options.base, files: options.files });
  if (!change.ok) return { error: change.error };
  if (options.extraFiles && options.extraFiles.length) change.files = [...new Set([...change.files, ...options.extraFiles])].sort();
  const rules = recompute.rulesFor(root, change, { workingMap: ownMap });
  if (rules.error) return { error: rules.error };
  const map = rules.map;
  const context = planOptions(root, map, change.files, {
    base: change.mergeBase || 'HEAD',
    dirtyFiles: receipts.uncommittedFiles(root),
    gate: options.gate,
  });
  const picked = plan.planChecks(map, change.files, context);
  const history = budget.loadDurations(root);
  for (const entry of picked.selected) {
    const guess = budget.estimate(entry, history);
    entry.expected = guess.seconds;
    entry.expectedFrom = guess.source;
  }
  const here = picked.selected.filter((entry) => placement(entry, options).run);
  picked.expected = budget.planSeconds(here, options.parallel || map.parallel);
  picked.unknownTimes = here.filter((entry) => entry.expected === null).map((entry) => entry.key);
  return { change, picked, map, rules };
}

function tierLine(picked) {
  const high = [...picked.files, ...picked.importers].filter((file) => file.tier === 'high');
  if (high.length) return `risk: high (${picked.highKinds.join(', ')}: ${high[0].path}${high[0].imports ? ` imports ${high[0].imports}` : ''}${high.length > 1 ? ` +${high.length - 1} more` : ''})`;
  if (picked.tier === 'low') {
    const kinds = [...new Set(picked.lowWhy.map((file) => file.why))];
    return `risk: low (${kinds.join(', ')})`;
  }
  const normal = picked.files.filter((file) => file.tier === 'normal');
  return `risk: normal (${normal[0] ? normal[0].path : 'code'}${normal.length > 1 ? ` +${normal.length - 1} more` : ''})`;
}

function budgetLine(picked) {
  const target = picked.target;
  const unknown = picked.unknownTimes && picked.unknownTimes.length ? `, ${picked.unknownTimes.length} with no time yet` : '';
  return `expected: about ${Math.round(picked.expected)}s for the checks that run here${unknown} (target ${target}s for a ${picked.gate ? `whole ${picked.gate} gate` : `${picked.tier} risk change`})`;
}

function slowestExpected(picked, options) {
  return picked.selected.filter((entry) => placement(entry, options).run && entry.expected)
    .sort((a, b) => b.expected - a.expected)[0] || null;
}

function proofLabel(proof) {
  if (!proof) return 'no proof for this change';
  return `${proof.command} (from ${proof.source})`;
}

function explainLines(picked, change, options, person, proof, lines = []) {
  const what = picked.gate ? `the ${picked.gate} gate` : `${change.files.length} changed file${change.files.length === 1 ? '' : 's'}`;
  const against = change.filesOverride ? 'files given by hand' : `base ${change.base} at ${String(change.mergeBase).slice(0, 9)}`;
  lines.push(`atris check plan for ${what} (${against})`);
  lines.push(tierLine(picked));
  if (picked.importers.length) lines.push(`importers counted: ${picked.importers.length} file(s) import a changed file`);
  lines.push(`machine: ${person ? "a person's machine" : 'no person at the screen'}, lane ${options.lane}`);
  const stages = new Set(picked.selected.map((entry) => entry.stage ?? 1));
  for (const stage of [...stages].sort()) {
    if (stages.size > 1) lines.push(stage === 0 ? 'first, the quick checks:' : stage === 1 ? 'then the tests this change needs, only if everything before passed:' : 'last, the full gate, only if everything before passed:');
    for (const entry of picked.selected.filter((item) => (item.stage ?? 1) === stage)) {
      const place = placement(entry, options);
      const label = place.run ? 'run here' : `needs ${place.lane}`;
      const time = entry.expected ? `  ~${entry.expected}s${entry.expectedFrom === 'measured' ? '' : ` (${entry.expectedFrom})`}` : '  ~?s';
      const why = entry.reasons.length > 4 ? `${entry.reasons.slice(0, 4).join('; ')}; +${entry.reasons.length - 4} more` : entry.reasons.join('; ');
      lines.push(`  ${label.padEnd(15)} ${entry.key}  <- ${why}${time}`);
      if (entry.tests && entry.tests.length && !entry.file) {
        for (const test of entry.tests.slice(0, 40)) lines.push(`      ${test.file}  <- ${test.reasons.join('; ')}`);
        if (entry.tests.length > 40) lines.push(`      ... and ${entry.tests.length - 40} more`);
      }
    }
  }
  if (!picked.selected.length) lines.push(picked.tier === 'low' ? '  (no check picked; a low risk change runs the key scan)' : '  (no check picked)');
  for (const [name, sel] of Object.entries(picked.selections || {})) {
    if (sel.mode === 'fallback') lines.push(`${name}: ${sel.why}, so it runs its fallback`);
    if (sel.mode === 'none') lines.push(`${name}: no test to run for this change`);
    if (sel.broad_names && sel.broad_names.length) lines.push(`${name}: names too common to pick by: ${sel.broad_names.slice(0, 5).join(', ')}`);
    if (sel.hubs && sel.hubs.length) {
      const hubs = [...new Map(sel.hubs.map((hub) => [hub.file, hub])).values()];
      lines.push(`${name}: not through ${hubs.length} hub file${hubs.length === 1 ? '' : 's'} many tests import: ${hubs.slice(0, 3).map((hub) => `${hub.file} (${hub.tests} tests)`).join(', ')}${hubs.length > 3 ? ', ...' : ''}`);
    }
  }
  for (const file of picked.uncovered || []) lines.push(`no test covers ${file}`);
  if (picked.notPicked.length) lines.push(`not picked by rule: ${picked.notPicked.join(', ')}`);
  lines.push(`unmapped: ${picked.unmapped.length ? picked.unmapped.join(', ') : 'none'}`);
  lines.push(`proof: ${picked.tier === 'low' && !proof ? 'not needed for a low risk change' : proofLabel(proof)}`);
  if (picked.toConfirm.length) lines.push(`still to confirm in the map: ${picked.toConfirm.join(', ')}`);
  lines.push(budgetLine(picked));
  if (picked.target && picked.expected > picked.target) {
    const slow = slowestExpected(picked, options);
    if (slow) lines.push(`expected over budget: ${slow.key} (~${slow.expected}s) is most of it`);
  }
  return lines;
}

// The change's own proof, checked on this code only.
async function checkProof(root, map, change, picked, options, context) {
  const found = proofs.findProof(root, change, options);
  if (!found) {
    if (picked.tier === 'low') return { status: 'exempt', why: 'a low risk change (wording, docs, styles, tests) needs no proof' };
    return { status: 'failed', why: 'no proof for this change', hint: 'give one with --proof "<cmd>", a "Proof: <cmd>" line in the commit message, or the task\'s --verify' };
  }
  const row = { command: found.command, source: found.source };
  const relevant = proofs.proofRelevance(root, found.command, change.files);
  row.about_this_change = relevant.why;
  if (!relevant.ok) return { ...row, status: 'failed', why: relevant.why };
  const flags = proofs.staticGuard(root, found.command, change.files);
  if (flags.length) return { ...row, status: 'failed', why: flags.join('; ') };
  const coverageDir = proofs.runsNode(found.command) ? fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-cov-')) : null;
  try {
    const env = cageEnv({ where: 'here' }, { ...context, extraEnv: { ...(context.extraEnv || {}), ...(coverageDir ? { NODE_V8_COVERAGE: coverageDir } : {}) } });
    const run = await runCaged(found.command, root, env, options.timeout || PROOF_TIMEOUT_SECONDS);
    row.seconds = seconds(run.ms);
    row.exit_code = run.code;
    if (run.timedOut) return { ...row, status: 'failed', why: 'the proof timed out', output_tail: tail(run.out) };
    if (map.skipLines.some((line) => run.out.includes(line))) return { ...row, status: 'needs-lane', lane: 'no-screen', why: 'the proof skipped itself here' };
    if (run.code !== 0) return { ...row, status: 'failed', why: `the proof failed (exit ${run.code})`, output_tail: tail(run.out) };
    if (coverageDir) {
      const cov = proofs.changedLineCoverage(root, change.mergeBase, change.files, coverageDir);
      row.changed_line_coverage = cov.measured ? `${cov.ran}/${cov.total}` : `not measured (${cov.why})`;
      if (cov.measured && cov.ran === 0) return { ...row, status: 'failed', why: 'the proof passed without running a single changed line, so it does not show this change' };
      if (cov.measured && map.proof.coverageFloor !== null && cov.ran / cov.total < map.proof.coverageFloor) {
        return { ...row, status: 'failed', why: `the proof ran ${cov.ran} of ${cov.total} changed lines, under the map's floor of ${map.proof.coverageFloor}` };
      }
    } else {
      row.changed_line_coverage = 'not measured (coverage is read for node proofs only)';
    }
  } finally {
    if (coverageDir) fs.rmSync(coverageDir, { recursive: true, force: true });
  }
  if (options.deep) {
    if (!change.mergeBase) return { ...row, status: 'failed', why: '--deep needs a base to compare with' };
    const deep = proofs.deepProof(root, change.mergeBase, found.command, change.files, cageEnv({ where: 'here' }, context));
    row.deep = deep.why;
    if (!deep.ok) return { ...row, status: 'failed', why: deep.why };
  }
  return { ...row, status: 'passed' };
}

async function secretCheck(root, map, change, context) {
  if (map.secretScan) {
    const run = await runCaged(map.secretScan, root, cageEnv({ where: 'here' }, context), 120);
    // The project's own scan may print what it found; none of that is kept or shown.
    return run.code === 0 ? { status: 'passed', via: map.secretScan } : { status: 'failed', via: map.secretScan, why: `the project's secret scan failed (exit ${run.code}); run it yourself to see where` };
  }
  const hits = proofs.secretScan(root, change.mergeBase, change.files);
  if (!hits.length) return { status: 'passed', via: 'atris check key patterns' };
  return { status: 'failed', via: 'atris check key patterns', hits, why: `${hits.length} key-shaped string(s) added: ${hits.slice(0, 5).map((hit) => `${hit.file}:${hit.line} (${hit.kind})`).join(', ')}` };
}

// Pick, run, prove, scan, and write the receipt. Never pushes.
async function evaluate(root, map, options, log) {
  const person = receipts.onPersonsMachine();
  if (options.lane === 'no-screen' && person) {
    log("atris check: this is a person's machine, so the no-screen lane does not run here. A runner with no screen runs it (ATRIS_CHECK_PERSON=0 says this machine has no person at it).");
    return { code: EXIT.usage };
  }
  let made;
  try {
    made = makePlan(root, map, options);
  } catch (error) {
    if (error instanceof plan.CheckMapError) { log(`atris check: ${error.message}`); return { code: EXIT.usage }; }
    throw error;
  }
  if (made.error) { log(`atris check: ${made.error}`); return { code: EXIT.usage }; }
  const { change, picked, rules } = made;
  map = made.map;
  if (options.explain) {
    const proof = proofs.findProof(root, change, options);
    if (options.json) log(JSON.stringify({ plan: picked, change, lane: options.lane, person, proof, map_from: rules.from }, null, 2));
    else for (const line of [...explainLines(picked, change, options, person, proof), `map: ${rules.from}`]) log(line);
    return { code: EXIT.proven, explained: true };
  }
  if (!picked.selected.length && picked.tier !== 'low') {
    log('atris check: the map picked no check for this change, and nothing checked is not proof. Add a check whose "when" covers it, or a selector.');
    return { code: EXIT.usage };
  }

  proofs.sweepStaleDeepCopies(root);
  const identity = receipts.codeIdentity(root);
  const startedAt = new Date().toISOString();
  // Every check is told which change it checks: ATRIS_CHECK_BASE (the merge
  // base the plan was made against; empty for --files) and ATRIS_CHECK_FILES
  // (a temp file listing the changed files, one per line, removed after).
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-files-'));
  const dropFiles = () => { try { fs.rmSync(filesDir, { recursive: true, force: true }); } catch {} };
  process.once('exit', dropFiles);
  const filesList = path.join(filesDir, 'changed-files.txt');
  fs.writeFileSync(filesList, change.files.length ? `${change.files.join('\n')}\n` : '');
  const context = { person, extraEnv: { ATRIS_CHECK_BASE: change.mergeBase || '', ATRIS_CHECK_FILES: filesList } };
  const done = options.alreadyPassed || new Set();
  const toRun = picked.selected.filter((entry) => placement(entry, options).run && !done.has(entry.key));
  const clockStart = Date.now();
  // Cheapest first (lib/check-plan.js): the key scan, then the quick checks,
  // then the tests the change needs, then the full gate. The first failure
  // stops the rest; each later check reads "not run because <check> failed",
  // which is never a pass.
  const runByKey = new Map();
  const secrets = await secretCheck(root, map, change, context);
  let stopped = secrets.status === 'failed' ? 'the key scan' : '';
  for (const stage of [...new Set(toRun.map((entry) => entry.stage ?? 1))].sort()) {
    const list = toRun.filter((entry) => (entry.stage ?? 1) === stage);
    if (stopped) { for (const entry of list) runByKey.set(entry.key, null); continue; }
    const runs = await inPool(list, options.parallel || map.parallel, async (entry) => {
      const port = entry.port ? await freePort() : null;
      const cwd = entry.cwd ? path.join(root, entry.cwd) : root;
      return runCaged(entry.run, cwd, cageEnv(entry, { ...context, port }), timeoutFor(entry, options));
    });
    list.forEach((entry, index) => runByKey.set(entry.key, runs[index]));
    const red = list.find((entry, index) => resultRow(entry, runs[index], map.skipLines).status === 'failed');
    if (red) stopped = red.key;
  }
  const rows = picked.selected.map((entry) => {
    const place = placement(entry, options);
    const base = { name: entry.key, run: entry.run, where: entry.where, why: entry.reasons, expected_seconds: entry.expected, stage: entry.stage ?? 1, ...(entry.tests && !entry.file ? { tests: entry.tests } : {}) };
    if (place.run && done.has(entry.key)) {
      return { ...base, status: 'passed', note: 'passed in the receipt for this same code', seconds: 0, exit_code: 0 };
    }
    if (!place.run) {
      return { ...base, status: 'needs-lane', lane: place.lane, seconds: 0, exit_code: null };
    }
    const result = runByKey.get(entry.key);
    if (!result) return { ...base, status: 'not-run', note: `not run because ${stopped} failed`, seconds: 0, exit_code: null };
    const row = { ...base, ...resultRow(entry, result, map.skipLines), expected_seconds: entry.expected, stage: entry.stage ?? 1 };
    // A fallback that runs only part of the tests is never proof: it passed
    // here, but the whole suite still has to.
    if (entry.partialFallback && row.status === 'passed') {
      return { ...row, status: 'needs-lane', lane: 'full gate', partial_fallback: true, note: 'it passed, but this fallback runs only part of the tests; the map should name the release gate or a check marked "full": true' };
    }
    return row;
  });
  budget.recordDurations(root, picked.selected.map((entry, index) => ({ entry, row: rows[index] }))
    .filter(({ row }) => (row.status === 'passed' || row.status === 'failed') && !row.note && row.seconds > 0)
    .map(({ entry, row }) => ({ key: entry.key, seconds: row.seconds, count: entry.selectedCount || 0 })));
  for (const name of picked.notPicked) {
    const check = map.checks[name];
    rows.push({ name, run: check.run, where: check.where, why: [check.each ? 'no changed file it runs for' : 'no changed file matches'], status: 'skipped-by-rule', seconds: 0, exit_code: null });
  }
  let proof;
  if (options.gate) proof = { status: 'exempt', why: 'a whole gate run proves the gate, not one change' };
  else if (stopped) proof = { status: 'not-run', why: `not run because ${stopped} failed` };
  else proof = await checkProof(root, map, change, picked, options, context);
  dropFiles();
  process.removeListener('exit', dropFiles);
  const actualSeconds = seconds(Date.now() - clockStart);
  const over = budget.overBudget(picked.target, actualSeconds, rows);
  // Code changed while the checks ran: this receipt cannot vouch for either state.
  const after = receipts.codeIdentity(root);
  const counted = [...rows.filter((row) => row.status !== 'skipped-by-rule'), proof, secrets].filter((row) => row.status !== 'exempt');
  const verdict = after.tree === identity.tree ? receipts.verdictOf(counted) : 'failed';
  const receipt = {
    kind: receipts.RECEIPT_KIND,
    repo: path.basename(root),
    repo_root: root,
    branch: receipts.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() || null,
    base: change.base,
    merge_base: change.mergeBase,
    head_sha: identity.headSha,
    tree: identity.tree,
    dirty: identity.dirty,
    uncommitted_hash: identity.uncommittedHash,
    pushable: !identity.dirty && !change.filesOverride,
    files_override: change.filesOverride,
    lane: options.lane,
    person_machine: person,
    gate: picked.gate,
    map_blob: rules.blob,
    map_from: rules.from,
    risk_tier: picked.tier,
    high_risk: picked.highKinds,
    changed_file_count: change.files.length,
    changed_files: change.files,
    importers_counted: picked.importers.length,
    unmapped: picked.unmapped,
    uncovered: picked.uncovered,
    selections: Object.fromEntries(Object.entries(picked.selections).map(([name, sel]) => [name, { mode: sel.mode, why: sel.why, selected: sel.tests.length, max: sel.max }])),
    tier_target_seconds: picked.target,
    expected_seconds: picked.expected,
    actual_seconds: actualSeconds,
    over_budget: over,
    checks: rows,
    proof,
    secret_scan: secrets,
    verdict,
    ...(after.tree !== identity.tree ? { note: 'the code changed while the checks ran' } : {}),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const file = receipts.writeReceipt(root, receipt);
  if (options.json && !options.quiet) log(JSON.stringify({ ...receipt, receipt_file: file }, null, 2));
  else for (const line of [...summaryLines(receipt, file, root), receipts.storageLine(root)]) log(line);
  return { code: receipts.exitForVerdict(verdict), receipt, file, change, picked, map };
}

function summaryLines(receipt, file, root) {
  const counts = { passed: 0, failed: 0, 'needs-lane': 0 };
  for (const row of receipt.checks) if (counts[row.status] !== undefined) counts[row.status] += 1;
  const lines = [];
  for (const row of receipt.checks) {
    if (row.status === 'skipped-by-rule') continue;
    const mark = row.status === 'passed' ? 'pass' : row.status === 'failed' ? 'FAIL' : row.status === 'not-run' ? 'not run' : `needs ${row.lane}`;
    const time = row.seconds ? ` (${row.seconds}s${row.expected_seconds ? `, expected ~${row.expected_seconds}s` : ''})` : '';
    lines.push(`  ${mark.padEnd(15)} ${row.name}${time}${row.note ? `, ${row.note}` : ''}`);
    if (row.status === 'failed' && row.output_tail) lines.push(`      ${row.output_tail.split('\n').slice(-4).join('\n      ')}`);
  }
  const proof = receipt.proof;
  if (proof.status === 'exempt') lines.push(`  proof           ${proof.why}`);
  else if (proof.status === 'not-run') lines.push(`  not run         the proof, ${proof.why}`);
  else if (!proof.command) lines.push(`  FAIL            ${proof.why}. ${proof.hint || ''}`.trimEnd());
  else lines.push(`  ${(proof.status === 'passed' ? 'proof' : proof.status === 'failed' ? 'FAIL proof' : `needs ${proof.lane}`).padEnd(15)} ${proof.command}${proof.changed_line_coverage ? `, changed lines run: ${proof.changed_line_coverage}` : ''}${proof.status !== 'passed' ? `, ${proof.why}` : ''}`);
  lines.push(`  ${(receipt.secret_scan.status === 'passed' ? 'keys' : 'FAIL keys').padEnd(15)} ${receipt.secret_scan.status === 'passed' ? 'no key-shaped strings added' : receipt.secret_scan.why}`);
  if (receipt.high_risk.length) {
    lines.push(`  high risk (${receipt.high_risk.join(', ')}): the release gate ran. Full audit: atris security-review audit ${receipt.changed_files.slice(0, 3).join(' ')} --quick`);
  }
  if (receipt.uncovered && receipt.uncovered.length) for (const gap of receipt.uncovered) lines.push(`  no test covers ${gap}`);
  if (receipt.tier_target_seconds) {
    lines.push(`  time            ${receipt.actual_seconds}s, expected ~${Math.round(receipt.expected_seconds)}s, target ${receipt.tier_target_seconds}s for a ${receipt.gate ? `whole ${receipt.gate} gate` : `${receipt.risk_tier} risk change`}`);
  }
  if (receipt.over_budget) {
    const over = receipt.over_budget;
    lines.push(`over budget: ${over.actual_seconds}s against the ${over.target_seconds}s target${over.check ? `; ${over.check} took ${over.check_seconds}s. Make it faster or move it to the lane` : ''}`);
  }
  const where = path.relative(root, file);
  const picked = counts.passed + counts.failed + counts['needs-lane'];
  if (receipt.verdict === 'proven') {
    lines.push(`atris check: proven. ${counts.passed} of ${picked} picked checks passed${proof.status === 'passed' ? ' and the proof passed' : ''}. Receipt: ${where}`);
  } else if (receipt.verdict === 'partly') {
    const lanes = [...new Set([...receipt.checks, proof].filter((row) => row.status === 'needs-lane').map((row) => row.lane))].join(' and ');
    lines.push(`${receipts.CHECK_NEEDS_LANE_LINE}. ${counts.passed} passed here, the rest need the ${lanes} lane. Receipt: ${where}`);
  } else {
    lines.push(`atris check: failed. ${counts.failed} of ${picked} picked checks failed${proof.status === 'failed' ? ', and the proof did not pass' : ''}${receipt.secret_scan.status === 'failed' ? ', and keys were found' : ''}. Receipt: ${where}`);
  }
  if (receipt.dirty) lines.push('not pushable: there are uncommitted files; commit them and check again before a push');
  if (receipt.unmapped.length) lines.push(`unmapped files (add them to atris/checks.json): ${receipt.unmapped.join(', ')}`);
  return lines;
}

// The receipt is not taken at its word: the plan is worked out again from the
// diff and the default branch's map, and every row is held to it
// (lib/check-recompute.js). Each refusal names the check or field.
function verifyReceipt(root, map, options, log) {
  let file = options.receipt ? path.resolve(options.receipt) : null;
  let receipt = file ? receipts.readReceipt(file) : null;
  if (!file) {
    const found = receipts.findReceiptForTree(root, receipts.codeIdentity(root).tree);
    if (found) { file = found.file; receipt = found.receipt; }
  }
  if (!receipt) {
    if (options.json) log(JSON.stringify({ receipt_file: file, matches: false, why: file ? 'not an atris check receipt' : 'no receipt for the code here now', problems: [], verdict: null }, null, 2));
    else log(file ? `atris check: ${file} is not an atris check receipt` : 'atris check: no receipt for the code here now; run atris check');
    return EXIT.failed;
  }
  const result = recompute.recheckReceipt(root, receipt, { workingMap: map });
  if (options.json) {
    log(JSON.stringify({ receipt_file: file, matches: result.ok, why: result.why || null, problems: result.problems, verdict: result.verdict, risk_tier: result.tier || null, map_from: result.rules ? result.rules.from : null }, null, 2));
  }
  if (!result.ok) {
    if (!options.json) {
      log(`atris check: the receipt does not prove this code (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}):`);
      for (const problem of result.problems) log(`  - ${problem}`);
    }
    return EXIT.failed;
  }
  if (!options.json) {
    const where = path.relative(root, file);
    if (result.verdict === 'proven') log(`atris check: proven. The plan was worked out again and the receipt matches it (${where}).`);
    else if (result.verdict === 'partly') log(`${receipts.CHECK_NEEDS_LANE_LINE}. The receipt matches the plan, and ${result.needs_lane.join(', ')} still need${result.needs_lane.length === 1 ? 's' : ''} a lane.`);
    else log('atris check: failed. The receipt matches the plan, and it records a failed check.');
    log(receipts.storageLine(root));
  }
  return receipts.exitForVerdict(result.verdict);
}

// ---------------------------------------------------------------- push and land

const run = (root, args) => receipts.git(root, args);

function defaultBranchRef(root) {
  const base = receipts.defaultBase(root);
  if (!base || !base.startsWith('origin/')) return null;
  return { ref: base, branch: base.slice('origin/'.length) };
}

function revParse(root, ref) {
  const result = run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok ? result.out.trim() : '';
}

function isAncestor(root, older, newer) {
  return spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root }).status === 0;
}

function changedLineCount(root, from) {
  const stat = run(root, ['diff', '--numstat', from, 'HEAD']).out.trim();
  let total = 0;
  for (const row of stat.split('\n').filter(Boolean)) {
    const [added, removed] = row.split('\t');
    // A binary file has no line count: count it as too big to push straight.
    if (added === '-' || removed === '-') return Infinity;
    total += Number(added) + Number(removed);
  }
  return total;
}

// The default branch's last no-screen lane result, read by the map's command.
function laneStatus(root, map) {
  const lanes = Object.values(map.checks).some((check) => check.where === 'no-screen');
  if (!map.push.laneStatus) return lanes ? { state: 'unknown', why: 'the map has no lane_status command to read' } : { state: 'none', why: 'this project has no no-screen lane' };
  const result = spawnSync(map.push.laneStatus, { cwd: root, shell: true, encoding: 'utf8', timeout: 20000 });
  const word = String(result.stdout || '').trim().split(/\s+/).pop().toLowerCase();
  if (result.status === 0 && /^(?:success|green|passed|pass)$/.test(word)) return { state: 'green', why: word };
  if (/^(?:failure|failed|red|fail|timed_out|cancelled)$/.test(word)) return { state: 'red', why: word };
  return { state: 'unknown', why: word ? `read "${word}"` : 'could not read it' };
}

// Rule (a): every condition must hold for a straight push to the default branch.
function pushNowConditions(root, map, result, baseSha) {
  const receipt = result.receipt;
  const rowsHere = receipt.checks.filter((row) => row.status !== 'skipped-by-rule' && row.status !== 'needs-lane');
  const selfSkipped = receipt.checks.filter((row) => row.status === 'needs-lane' && row.note === 'the check skipped itself here');
  const proofOk = receipt.proof.status === 'passed' || receipt.proof.status === 'exempt';
  const files = receipt.changed_files.length;
  const lines = changedLineCount(root, baseSha);
  const lane = laneStatus(root, map);
  const needsLane = receipt.checks.filter((row) => row.status === 'needs-lane' && !selfSkipped.includes(row));
  const onlyNoScreen = needsLane.every((row) => row.lane === 'no-screen');
  const ahead = map.push.aheadOfLane && receipt.risk_tier === 'low' && onlyNoScreen;
  return [
    { ok: receipt.risk_tier !== 'high', label: 'no high risk path in the change or the files that import it', detail: receipt.high_risk.join(', ') },
    { ok: rowsHere.every((row) => row.status === 'passed') && !selfSkipped.length && proofOk && receipt.secret_scan.status === 'passed', label: 'every check that may run here passed, none skipped itself, the proof passed, no keys' },
    { ok: files <= map.push.maxFiles && lines <= map.push.maxLines && !receipt.unmapped.length, label: `small: ${files} file(s), ${lines === Infinity ? 'binary' : lines} line(s), ${receipt.unmapped.length} unmapped (limit ${map.push.maxFiles} files, ${map.push.maxLines} lines, 0 unmapped)` },
    { ok: lane.state === 'green' || lane.state === 'none', label: `the default branch's lane is not red (${lane.state}: ${lane.why})` },
    { ok: needsLane.length === 0 || ahead, label: needsLane.length ? `no check waits for another lane (${needsLane.length} do${ahead ? ', and the map lets low risk land ahead of the lane' : ''})` : 'no check waits for another lane' },
  ];
}

function updateOnBase(root, map, baseRef, log) {
  if (isAncestor(root, baseRef, 'HEAD')) return true;
  const result = map.push.update === 'merge'
    ? run(root, ['merge', '--no-edit', baseRef])
    : run(root, ['rebase', baseRef]);
  if (result.ok) return true;
  run(root, [map.push.update === 'merge' ? 'merge' : 'rebase', '--abort']);
  log(`atris check: could not ${map.push.update} onto ${baseRef} cleanly: ${result.err.split('\n')[0]}. Nothing was pushed.`);
  return false;
}

async function pushCommand(root, map, options, log) {
  const target = defaultBranchRef(root);
  if (!target) { log('atris check: --push needs an origin remote with a default branch'); return EXIT.usage; }
  if (receipts.uncommittedFiles(root).length) {
    log('atris check: --push only pushes committed code, and there are uncommitted files. Commit them, then run it again.');
    return EXIT.usage;
  }
  let previousBase = '';
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
    const fetched = run(root, ['fetch', '--quiet', 'origin', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`]);
    if (!fetched.ok) { log(`atris check: could not fetch ${target.ref}: ${fetched.err.split('\n')[0]}`); return EXIT.failed; }
    // First update, then check: the receipt describes the exact code that is pushed.
    if (!updateOnBase(root, map, target.ref, log)) return EXIT.failed;
    const baseSha = revParse(root, target.ref);
    const extraFiles = previousBase && previousBase !== baseSha
      ? run(root, ['diff', '--name-only', '--no-renames', previousBase, baseSha]).out.split('\n').filter(Boolean)
      : [];
    if (extraFiles.length) log(`atris check: ${target.branch} moved; also checking the ${extraFiles.length} file(s) its new commits changed`);
    const result = await evaluate(root, map, { ...options, base: target.ref, extraFiles }, log);
    if (result.code === EXIT.usage) return EXIT.usage;
    if (result.code === EXIT.failed) { log('atris check: not pushed, a check failed.'); return EXIT.failed; }
    // The default branch's map decides the push too: a change cannot raise its
    // own limits or name its own push command.
    const rules = result.map || map;
    const conditions = pushNowConditions(root, rules, result, baseSha);
    log('push straight to the default branch?');
    for (const condition of conditions) log(`  ${condition.ok ? 'yes' : 'no '}  ${condition.label}`);
    const head = revParse(root, 'HEAD');
    // Anything the lander may pick up later carries its receipt with it, as a
    // small ref on origin (lib/check-receipt-ref.js). The lander works it out
    // again; when the ref cannot be pushed it checks the change itself.
    if (!conditions.every((condition) => condition.ok) || rules.push.via) {
      const kept = receiptRefs.publishReceipt(root, result.receipt);
      log(kept.ok ? `receipt: kept on origin as ${kept.ref}` : `receipt: not kept on origin (${kept.detail || 'unknown'}); the lander will check the change itself`);
    }
    if (!conditions.every((condition) => condition.ok)) {
      const ref = `refs/heads/atris/ready/${head.slice(0, 12)}`;
      const staged = run(root, ['push', '--quiet', 'origin', `HEAD:${ref}`]);
      if (!staged.ok) { log(`atris check: could not stage the change: ${staged.err.split('\n')[0]}`); return EXIT.failed; }
      log(`${receipts.CHECK_NEEDS_LANE_LINE}: it was not pushed to ${target.branch}`);
      log(`${STAGED_LINE}. Ready on ${ref.replace('refs/heads/', '')}; a runner lands it with: atris check land ${head.slice(0, 12)} --lane no-screen`);
      const needsLane = result.receipt.checks.filter((row) => row.status === 'needs-lane');
      if (result.code === EXIT.proven && needsLane.length === 0 && conditions[3].ok) {
        const landCmd = rules.push.via || `ATRIS_CHECK_PERSON=0 atris check land ${head.slice(0, 12)} --lane no-screen`;
        log(`no runner on this project? land it with: ${landCmd}`);
      }
      return EXIT.partly;
    }
    if (rules.push.via) {
      log(`push: through the project's own command, ${rules.push.via}`);
      const via = spawnSync(rules.push.via, { cwd: root, shell: true, stdio: 'inherit' });
      return via.status === 0 ? EXIT.proven : EXIT.failed;
    }
    // Compare and swap: refused if the default branch moved since it was checked.
    const pushed = run(root, ['push', '--quiet', `--force-with-lease=refs/heads/${target.branch}:${baseSha}`, 'origin', `HEAD:refs/heads/${target.branch}`]);
    if (pushed.ok) {
      log(`pushed: ${head.slice(0, 12)} is on ${target.branch}`);
      return EXIT.proven;
    }
    log(`atris check: ${target.branch} moved while checking (try ${attempt} of ${PUSH_TRIES}); updating and checking again`);
    previousBase = baseSha;
  }
  log(`atris check: not pushed, ${target.branch} kept moving after ${PUSH_TRIES} tries`);
  return EXIT.failed;
}

// On a runner with no screen: check out the staged ref, run what is left, and
// fast-forward the default branch from it when everything is green.
async function landCommand(root, map, sha, options, log) {
  if (!/^[0-9a-f]{7,40}$/.test(String(sha || ''))) { log('atris check land needs the staged short sha, like: atris check land 1a2b3c4d5e6f'); return EXIT.usage; }
  if (receipts.onPersonsMachine()) {
    log("atris check land runs on a runner with no screen, not on a person's machine (ATRIS_CHECK_PERSON=0 says this machine has no person at it).");
    return EXIT.usage;
  }
  const target = defaultBranchRef(root);
  if (!target) { log('atris check land needs an origin remote with a default branch'); return EXIT.usage; }
  if (receipts.uncommittedFiles(root).length) { log('atris check land needs a clean checkout'); return EXIT.usage; }
  const ref = `refs/heads/atris/ready/${sha}`;
  const fetched = run(root, ['fetch', '--quiet', 'origin', ref, `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`]);
  if (!fetched.ok) { log(`atris check land: no staged change at ${ref.replace('refs/heads/', '')}`); return EXIT.failed; }
  const staged = revParse(root, 'FETCH_HEAD');
  const baseSha = revParse(root, target.ref);
  if (!isAncestor(root, baseSha, staged)) {
    log(`atris check land: ${target.branch} moved past the staged change, so it is no longer a fast-forward. Stage it again with atris check --push.`);
    return EXIT.failed;
  }
  const checkout = run(root, ['checkout', '--quiet', '--detach', staged]);
  if (!checkout.ok) { log(`atris check land: could not check out the staged change: ${checkout.err.split('\n')[0]}`); return EXIT.failed; }
  // A receipt for this same code (if this runner has one) spares re-running what passed.
  const prior = receipts.findReceiptForTree(root, receipts.codeIdentity(root).tree);
  const alreadyPassed = new Set(prior && prior.receipt.verdict !== 'failed'
    ? prior.receipt.checks.filter((row) => row.status === 'passed').map((row) => row.name) : []);
  const result = await evaluate(root, map, { ...options, lane: 'no-screen', base: target.ref, alreadyPassed }, log);
  if (result.code !== EXIT.proven) {
    const red = result.receipt ? result.receipt.checks.filter((row) => row.status === 'failed').map((row) => row.name) : [];
    log(`atris check land: not landed${red.length ? `, failed: ${red.join(', ')}` : ''}. The staged change stays on ${ref.replace('refs/heads/', '')}.`);
    return result.code === EXIT.usage ? EXIT.usage : result.code;
  }
  const pushed = run(root, ['push', '--quiet', `--force-with-lease=refs/heads/${target.branch}:${baseSha}`, 'origin', `${staged}:refs/heads/${target.branch}`]);
  if (!pushed.ok) {
    log(`atris check land: ${target.branch} moved while checking; the staged change stays. Run land again.`);
    return EXIT.failed;
  }
  run(root, ['push', '--quiet', 'origin', `:${ref}`]);
  log(`landed: ${staged.slice(0, 12)} is on ${target.branch}, and the staged ref is gone`);
  return EXIT.proven;
}

// ---------------------------------------------------------------- sweep

// Staged refs that already landed go after 7 days; ones that never landed are
// listed for a person, never deleted.
function sweepCommand(root, log, { now = Date.now() } = {}) {
  const target = defaultBranchRef(root);
  if (!target) { log('atris check sweep needs an origin remote with a default branch'); return EXIT.usage; }
  const fetched = run(root, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/atris/ready/*:refs/remotes/origin/atris/ready/*', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`]);
  if (!fetched.ok) { log(`atris check sweep: could not fetch: ${fetched.err.split('\n')[0]}`); return EXIT.failed; }
  const rows = run(root, ['for-each-ref', '--format=%(objectname) %(committerdate:unix) %(refname)', 'refs/remotes/origin/atris/ready/']).out
    .split('\n').filter(Boolean).map((line) => {
      const [sha, when, ref] = line.split(' ');
      return { sha, days: (now / 1000 - Number(when)) / 86400, ref, name: ref.replace('refs/remotes/origin/', '') };
    });
  let removed = 0;
  const waiting = [];
  for (const row of rows) {
    const landed = isAncestor(root, row.sha, target.ref);
    if (landed && row.days > STALE_READY_DAYS) {
      const gone = run(root, ['push', '--quiet', 'origin', `:refs/heads/${row.name}`]);
      if (gone.ok) { run(root, ['update-ref', '-d', row.ref]); removed += 1; continue; }
    }
    if (!landed) waiting.push(row);
  }
  log(`atris check sweep: removed ${removed} staged ref(s) already on ${target.branch} and older than ${STALE_READY_DAYS} days`);
  for (const row of waiting) log(`  waiting, not on ${target.branch}: ${row.name} (${Math.floor(row.days)} days old)`);
  const kept = receiptRefs.sweepReceiptRefs(root, { target: target.ref, now });
  log(`atris check sweep: removed ${kept.removed} receipt ref(s) whose commit has been on ${target.branch} over ${receiptRefs.LANDED_DAYS} days or that are over ${receiptRefs.MAX_DAYS} days old; ${kept.kept} kept`);
  log(receipts.storageLine(root));
  return EXIT.proven;
}

// ---------------------------------------------------------------- fix

// CodeOps is the crew that fixes red: a failed receipt becomes one tight task
// for the cloud engineering computer, sent with `atris computer pr`. One job per
// receipt. --dry-run prints the exact command and task and sends nothing.
const FIX_RULE = 'Make each failing check pass by fixing the cause. Never weaken, skip or delete a check, and never edit atris/checks.json. Reply with COMMIT=<sha> and PUSHED=<branch>.';

function githubSlug(root) {
  const url = run(root, ['config', '--get', 'remote.origin.url']).out.trim();
  const match = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : '';
}

function failedReceipt(root, file) {
  if (file) {
    const receipt = receipts.readReceipt(path.resolve(file));
    return receipt ? { file: path.resolve(file), receipt } : null;
  }
  const dir = path.join(root, '.atris', 'receipts');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^check-.*\.json$/.test(name)); } catch {}
  return names.map((name) => ({ file: path.join(dir, name), receipt: receipts.readReceipt(path.join(dir, name)) }))
    .filter((row) => row.receipt && row.receipt.verdict === 'failed')
    .sort((a, b) => String(b.receipt.finished_at || '').localeCompare(String(a.receipt.finished_at || '')))[0] || null;
}

// Failure lines name folders on this machine; the cloud task gets repo-relative paths.
// No folder of this machine goes into a cloud task: the work copy, the main
// checkout it came from (a work copy can borrow its python) and the home
// folder all come out.
function localPathsOut(text, receipt) {
  let out = String(text || '');
  const roots = new Set();
  for (const root of [receipt.repo_root, receipt.repo_root && mainCheckout(receipt.repo_root)]) {
    if (!root) continue;
    roots.add(root);
    try { roots.add(fs.realpathSync(root)); } catch {}
  }
  for (const root of [...roots].sort((a, b) => b.length - a.length)) out = out.split(`${root}/`).join('').split(root).join('.');
  const home = os.homedir();
  if (home && home !== '/') out = out.split(`${home}/`).join('~/').split(home).join('~');
  return out;
}

function fixTask(receipt, slug) {
  const tailLines = (text) => localPathsOut(text, receipt).split('\n').slice(-TAIL_LINES).map((line) => `   ${line}`);
  const failedRuns = new Set();
  const lines = [`Repo ${slug}, branch ${receipt.branch} at commit ${String(receipt.head_sha).slice(0, 12)}.`, `Receipt: check-${String(receipt.head_sha).slice(0, 12)}.json, tree ${receipt.tree}.`, 'These checks failed in atris check:'];
  let n = 0;
  for (const row of receipt.checks.filter((entry) => entry.status === 'failed')) {
    n += 1;
    failedRuns.add(row.run);
    lines.push(`${n}. ${row.name}: \`${localPathsOut(row.run, receipt)}\` (exit ${row.exit_code === null ? 'none' : row.exit_code}${row.note ? `, ${row.note}` : ''})`);
    if (row.output_tail) lines.push('   last lines:', ...tailLines(row.output_tail));
  }
  if (receipt.proof && receipt.proof.status === 'failed' && !failedRuns.has(receipt.proof.command)) {
    n += 1;
    lines.push(`${n}. the change's proof${receipt.proof.command ? `: \`${localPathsOut(receipt.proof.command, receipt)}\`` : ''} (${receipt.proof.why})`);
    if (receipt.proof.output_tail) lines.push('   last lines:', ...tailLines(receipt.proof.output_tail));
  }
  if (receipt.secret_scan && receipt.secret_scan.status === 'failed') {
    n += 1;
    lines.push(`${n}. key scan: ${receipt.secret_scan.why}. Remove the key from the change; never print it.`);
  }
  lines.push(`Rule: ${FIX_RULE}`);
  return { text: lines.join('\n'), count: n };
}

function shellWord(value) {
  return /^[A-Za-z0-9_./@:=+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Is this failed receipt a big bug? One plain rule: its risk tier is high, or
// a check failed and a changed file matches the map's "big" globs.
function bigVerdict(receipt, map) {
  if (receipt.risk_tier === 'high') return { big: true, why: `high risk (${(receipt.high_risk || []).join(', ') || 'high'})` };
  const failed = (receipt.checks || []).some((row) => row.status === 'failed');
  const globs = (map && map.big) || [];
  const hit = failed && globs.length ? (receipt.changed_files || []).find((file) => plan.globsMatch(globs, file)) : null;
  if (hit) return { big: true, why: `${hit} matches the map's big list` };
  return { big: false, why: receipt.risk_tier ? `${receipt.risk_tier} risk, nothing in the map's big list` : 'nothing in the map\'s big list' };
}

// The one line the owner gets about a big bug. No names of people.
function bigNoticeLine(receipt) {
  const row = (receipt.checks || []).find((entry) => entry.status === 'failed');
  const name = row ? row.name : (receipt.proof && receipt.proof.status === 'failed' ? 'the proof' : 'a check');
  const why = row ? (row.note || `exit ${row.exit_code === null || row.exit_code === undefined ? 'none' : row.exit_code}`) : String((receipt.proof && receipt.proof.why) || 'a failure');
  return `Big bug in ${receipt.repo}: ${name} failed on ${String(why).split('\n')[0].slice(0, 80)}. A fix job is running with the strongest model.`;
}

// Prefer our own bin/atris.js so check fix never fails with ENOENT when atris
// is not globally installed on PATH, while honoring ATRIS_BIN and temp-dir fake shims in tests.
function resolveAtrisInvocation(argv, env = process.env) {
  const explicitBin = String((env && env.ATRIS_BIN) || '').trim();
  if (explicitBin) {
    if (explicitBin.endsWith('.js') && fs.existsSync(explicitBin)) {
      return { bin: process.execPath, args: [explicitBin, ...argv] };
    }
    return { bin: explicitBin, args: argv };
  }
  const ownBin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const inTest = Boolean((env && env.NODE_TEST_CONTEXT) || process.env.NODE_TEST_CONTEXT);
  if (inTest) {
    let tmpRoot = '';
    try { tmpRoot = fs.realpathSync(os.tmpdir()); } catch { tmpRoot = path.resolve(os.tmpdir()); }
    const pathEntries = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathEntries) {
      const candidate = path.join(dir, 'atris');
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile() || !(st.mode & 0o111)) continue;
        const real = fs.realpathSync(candidate);
        if (real.startsWith(`${tmpRoot}${path.sep}`)) {
          return { bin: candidate, args: argv };
        }
        break;
      } catch {}
    }
  }
  return { bin: process.execPath, args: [ownBin, ...argv] };
}

// Post the line to the owner notice channel. A failure to post never fails
// the hand-off.
function postOwnerNotice(root, line, channel, post) {
  if (channel !== 'feed') return { posted: false, why: 'owner_notice is none' };
  try {
    const inv = resolveAtrisInvocation(['feed', 'post', line], process.env);
    const result = post ? post(line) : spawnSync(inv.bin, inv.args, { cwd: root, encoding: 'utf8', timeout: 60000 });
    return result && result.status === 0 ? { posted: true } : { posted: false, why: `atris feed post exited ${result ? result.status : 'none'}` };
  } catch (error) {
    return { posted: false, why: String(error && error.message || error).split('\n')[0] };
  }
}

// The job's own lines: the pull request link, and the run id and job record
// computer pr prints when it has them.
function fixJobFrom(output, exitCode, sentAt) {
  const text = String(output || '');
  const field = (name) => { const hit = text.match(new RegExp(`^${name}=(\\S+)`, 'm')); return hit ? hit[1] : null; };
  const link = field('PR_URL') || (text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/) || [null])[0];
  return { sent_at: sentAt, exit_code: exitCode, pr_url: link, execution_id: field('EXECUTION_ID'), job_record: field('JOB_RECORD') };
}

// Run computer pr, showing its output as it comes and keeping a copy.
function sendFixJob(root, argv, env) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    const inv = resolveAtrisInvocation(argv, env);
    let child;
    try {
      child = spawn(inv.bin, inv.args, { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });
    } catch (error) {
      finish({ status: null, signal: null, spawnError: true, output: String(error && error.message || error) });
      return;
    }
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on('error', (error) => finish({ status: null, signal: null, spawnError: true, output: `${output}${error.message}` }));
    child.on('close', (status, signal) => finish({ status, signal: signal || null, spawnError: false, output }));
  });
}

async function fixCommand(root, options, log, context = {}) {
  const found = failedReceipt(root, options.receipt);
  if (!found) { log('atris check fix: no failed receipt here (run atris check, or pass --receipt <file>)'); return EXIT.usage; }
  const { file, receipt } = found;
  if (receipt.verdict !== 'failed') { log(`atris check fix: that receipt is ${receipt.verdict}, not failed; there is nothing to fix`); return EXIT.usage; }
  const ledgerFile = path.join(root, '.atris', 'receipts', 'fix-dispatched.json');
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) || {}; } catch {}
  const sentAt = receipt.fix_dispatched_at || ledger[receipt.tree];
  if (sentAt) {
    log(`atris check fix: this receipt went to CodeOps at ${sentAt}; one fix job per receipt. Check again after the fix lands.`);
    return EXIT.usage;
  }
  const slug = githubSlug(root);
  if (!slug) { log('atris check fix: origin is not a GitHub repo, so CodeOps cannot check it out'); return EXIT.usage; }
  if (!receipt.branch || receipt.branch === 'HEAD') { log('atris check fix: the receipt names no branch; check from a branch, then fix'); return EXIT.usage; }
  const task = fixTask(receipt, slug);
  if (!task.count) { log('atris check fix: the receipt lists no failed check to hand over'); return EXIT.usage; }
  let ownMap = null;
  try { ownMap = plan.loadMap(root); } catch { ownMap = null; }
  const big = bigVerdict(receipt, ownMap);
  // A big bug gets the strongest model: computer pr --think asks the thinker first.
  if (big.big) task.text = `big bug: ${task.text}`;
  const argv = ['computer', 'pr', slug, task.text, '--business', CODEOPS_BUSINESS, '--base', receipt.branch, ...(big.big ? ['--think'] : [])];
  const channel = ownMap ? ownMap.ownerNotice : 'feed';
  const notice = big.big ? bigNoticeLine(receipt) : '';
  log(`big: ${big.big ? 'yes' : 'no'} (${big.why})`);
  if (big.big) log(channel === 'feed' ? `notice: to the feed, once the job is sent: atris feed post ${shellWord(notice)}` : 'notice: none (owner_notice is none)');
  log('atris check fix: a dispatch wakes a cloud computer (costs a little).');
  log(`command: TASK="$(cat <<'ATRIS_TASK'`);
  log(task.text);
  log('ATRIS_TASK');
  log(`)"; atris ${argv.map((word) => (word === task.text ? '"$TASK"' : shellWord(word))).join(' ')}`);
  if (options.dryRun) { log('dry run: nothing was sent'); return EXIT.proven; }
  // CodeOps checks out a branch, not a bare commit: make sure the branch holds this commit.
  const onRemote = run(root, ['ls-remote', '--heads', 'origin', receipt.branch]).out.trim().split(/\s+/)[0] || '';
  if (onRemote !== receipt.head_sha) {
    const pushed = run(root, ['push', '--quiet', 'origin', `${receipt.head_sha}:refs/heads/${receipt.branch}`]);
    if (!pushed.ok) { log(`atris check fix: could not push ${receipt.branch} for CodeOps: ${pushed.err.split('\n')[0]}`); return EXIT.failed; }
  }
  // Mark first, so a crash mid-dispatch can never send a second job for this receipt.
  const at = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify({ ...receipt, fix_dispatched_at: at, fix_big: { big: big.big, why: big.why } }, null, 2)}\n`);
  // The same code checked again gets a fresh receipt file; the ledger still says it was sent.
  const recent = Object.entries({ ...ledger, [receipt.tree]: at }).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 200);
  fs.writeFileSync(ledgerFile, `${JSON.stringify(Object.fromEntries(recent), null, 2)}\n`);
  // computer pr learns who sent the job and which receipt it fixes.
  const sent = await (context.sendFixJob || sendFixJob)(root, argv, { ...process.env, ATRIS_RUNNER: 'atris check fix', ATRIS_FIX_RECEIPT: file });
  if (sent && sent.spawnError === true) {
    // Spawn failed before launching: roll back the dispatch lock so retries are not permanently blocked.
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.fix_dispatched_at === at) {
        delete current.fix_dispatched_at;
        delete current.fix_big;
        fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      }
    } catch {}
    try {
      const currentLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) || {};
      if (currentLedger[receipt.tree] === at) {
        delete currentLedger[receipt.tree];
        fs.writeFileSync(ledgerFile, `${JSON.stringify(currentLedger, null, 2)}\n`);
      }
    } catch {}
    log(`fix job: could not launch (${String(sent.output || 'spawn failed').trim().split('\n')[0]})`);
    return EXIT.failed;
  }
  const job = fixJobFrom(sent.output, sent.status, at);
  try {
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...now, fix_job: job }, null, 2)}\n`);
  } catch {}
  const exitLabel = sent.status === null ? (sent.signal ? `none (${sent.signal})` : 'none') : sent.status;
  log(`fix job: exit ${exitLabel}${job.pr_url ? `, ${job.pr_url}` : ''}`);
  if (sent.status === 0 && big.big) {
    const told = postOwnerNotice(root, notice, channel, context.postNotice);
    log(told.posted ? 'notice: posted to the feed' : `notice: not posted (${told.why}); the fix job was still sent`);
  }
  return sent.status === 0 ? EXIT.proven : EXIT.failed;
}

// ---------------------------------------------------------------- init

// Receipts and the import cache never go into git. Add them to .gitignore
// unless the project already ignores them (for example the whole .atris/).
function ignoreCheckState(root) {
  const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', '--no-index', '--', rel], { cwd: root }).status === 0;
  const missing = ['.atris/receipts/', '.atris/cache/'].filter((dir) => !ignored(`${dir}probe.json`));
  if (!missing.length) return false;
  const file = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${text}${lead}# atris check: local receipts and cache\n${missing.join('\n')}\n`);
  return true;
}

function initMap(root, args, log) {
  const { starterMap } = require('../lib/check-init');
  const { map, notes, empty } = starterMap(root);
  if (empty) {
    log('atris check init: found no test, check or lint scripts to start from, so nothing was written. Write atris/checks.json by hand.');
    return EXIT.usage;
  }
  const text = `${JSON.stringify(map, null, 2)}\n`;
  if (args.includes('--print')) {
    log(text.trimEnd());
  } else {
    const file = path.join(root, plan.MAP_PATH);
    if (fs.existsSync(file)) {
      log('atris check init: atris/checks.json already exists; it was left as it is (--print shows a starter).');
      return EXIT.usage;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    log(`atris check init: wrote atris/checks.json with ${Object.keys(map.checks).length} check(s), each marked for you to confirm.`);
    if (ignoreCheckState(root)) log('atris check init: added .atris/receipts/ and .atris/cache/ to .gitignore');
  }
  for (const note of notes) log(`note: ${note}`);
  return EXIT.proven;
}

async function checkCommand(args, context = {}) {
  const log = context.log || console.log;
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    usage(log);
    return EXIT.proven;
  }
  if (!isLocalCheck(args)) return require('./human-missions').checkCommand(args, context);
  // Run from the command line (not called in-process with a log): a SIGTERM
  // stops the running checks' process groups too.
  if (!context.log) stopRunningOnSignal();
  const root = receipts.repoRootOf(context.cwd || process.cwd());
  if (!root) { log('atris check: run it inside a git repo or work copy'); return EXIT.usage; }
  if (args[0] === 'init') return initMap(root, args.slice(1), log);
  let rest = args;
  let sub = '';
  let landSha = '';
  if (args[0] === 'push') { sub = 'push'; rest = args.slice(1); }
  if (args[0] === 'land') { sub = 'land'; landSha = args[1]; rest = args.slice(2); }
  if (args[0] === 'sweep' || args[0] === 'fix' || args[0] === 'replay') { sub = args[0]; rest = args.slice(1); }
  let options;
  try {
    options = parseArgs(rest);
  } catch (error) {
    if (error instanceof UsageError) { log(`atris check: ${error.message}`); usage(log); return EXIT.usage; }
    throw error;
  }
  if (sub === 'push') options.push = true;
  if (sub === 'sweep') return sweepCommand(root, log);
  if (sub === 'fix') return fixCommand(root, options, log, context);
  if (options.lintMap) return lintMapCommand(root, options, log);
  if (options.mapFile && sub !== 'replay' && !options.explain) { log('atris check: --map is for replay and --explain only; a real check reads atris/checks.json'); return EXIT.usage; }
  const map = loadMap(root, log, options);
  if (!map) return EXIT.usage;
  if (sub === 'replay') return replayCommand(root, map, options, log);
  if (sub === 'land') return landCommand(root, map, landSha, options, log);
  if (options.verify) return verifyReceipt(root, map, options, log);
  if (options.push) {
    const code = await pushCommand(root, map, options, log);
    const pile = code === EXIT.usage ? '' : require('../lib/waiting-pile').reportLine(root);
    if (pile) log(pile);
    return code;
  }
  return (await evaluate(root, map, options, log)).code;
}

module.exports = { checkCommand, isLocalCheck, STAGED_LINE, bigVerdict, bigNoticeLine };
