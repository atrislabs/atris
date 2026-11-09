'use strict';

// atris sentinel bench and atris sentinel improve.
//
//   atris sentinel bench [--summary] [--json] [--review] [--sets guard,agents]
//   atris sentinel bench --split <file> --set guard|agents|review
//   atris sentinel improve [--engine claude] [--focus exfil|destroy|disarm|agents] [--offline] [--json]
//   atris sentinel improve --rounds N --parallel K --review codex [--max-minutes 120] [--max-calls N] [--push]
//   atris sentinel improve --schedule [--every 24] [--engine claude] | --unschedule

const path = require('path');

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => String(a).startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

function checkFlags(argv, flags, values) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const name = a.split('=')[0];
    if (values.includes(name)) { if (!a.includes('=')) i += 1; continue; }
    if (flags.includes(a)) continue;
    throw new Error(`unknown option: ${a}`);
  }
}

function benchHelp() {
  console.log(`
  atris sentinel bench, a fixed exam for the sentinel

    atris sentinel bench                 score the guard and the agent check
    atris sentinel bench --summary       totals only, no item lines
    atris sentinel bench --review        also run the review set on engines (costs engine time)
    atris sentinel bench --json          raw numbers for scripts
    atris sentinel bench --split <file> --set guard|agents|review
                                         split new items into the seen half (in the repo)
                                         and the sealed held-out half (on this machine).
                                         the plaintext input is replaced with an encrypted copy

  the seen half lives in atris/sentinel-bench. the held-out half lives in
  ~/.atris/sentinel-holdout, encrypted with a key in your keychain. its
  items are never printed. only lib/sentinel-rules.json of the checkout is
  judged, always with this atris's own code. every number
  is raw: attacks blocked, everyday commands wrongly blocked, problems
  found, false alarms. there is no blended score.
`);
  return 0;
}

async function benchCommand(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return benchHelp();
  try { checkFlags(argv, ['--summary', '--json', '--review'], ['--split', '--set', '--sets', '--target', '--seen', '--hunter', '--verifier', '--budget', '--screen']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const bench = require('../lib/sentinel-bench');
  const env = deps.env || process.env;
  const root = path.resolve(readFlag(argv, '--target') || deps.root || process.cwd());
  const seenDir = path.resolve(readFlag(argv, '--seen') || bench.seenDirOf(root));
  const holdoutDir = bench.defaultHoldoutDir(env);
  const screen = readFlag(argv, '--screen');
  if (screen) {
    // Internal to the night run: refused ids only, as json.
    let candidates;
    try { candidates = JSON.parse(require('fs').readFileSync(path.resolve(screen), 'utf8')); } catch (e) { console.error(`  could not read the items to screen: ${e.message}`); return 1; }
    if (!Array.isArray(candidates)) { console.error('  the items to screen must be a json list'); return 1; }
    console.log(JSON.stringify({ ok: true, ...bench.screenItems(candidates, { holdoutDir, env }) }));
    return 0;
  }
  const split = readFlag(argv, '--split');
  if (split) {
    const set = readFlag(argv, '--set');
    if (!set) { console.error('  --split needs --set guard, agents or review'); return 2; }
    let res;
    try { res = bench.splitCorpus(path.resolve(split), set, { seenDir, holdoutDir, env }); } catch (e) { console.error(`  could not split: ${e.message}`); return 1; }
    if (argv.includes('--json')) { console.log(JSON.stringify({ ok: true, ...res }, null, 2)); return 0; }
    console.log(`\n  ${res.seen} items went to the seen half: ${path.relative(process.cwd(), res.seen_file) || res.seen_file}`);
    console.log(`  ${res.holdout} items went to the held-out half on this machine`);
    if (res.skipped) console.log(`  ${res.skipped} items were already in a half and were skipped`);
    if (res.invalid) console.log(`  ${res.invalid} lines were not valid items and were skipped`);
    console.log(`  the plaintext input was replaced with an encrypted copy at ${res.sealed_source}. no readable held-out item is left behind\n`);
    return 0;
  }
  const review = argv.includes('--review');
  const setsRaw = readFlag(argv, '--sets');
  const sets = setsRaw ? setsRaw.split(',').map((s) => s.trim()).filter(Boolean) : ['guard', 'agents', ...(review ? ['review'] : [])];
  const bad = sets.filter((s) => !bench.SETS.includes(s));
  if (bad.length) { console.error(`  unknown set: ${bad.join(', ')}. use guard, agents or review`); return 2; }
  const budget = readFlag(argv, '--budget');
  const reviewOpts = review ? {
    hunter: readFlag(argv, '--hunter') || 'codex',
    verifier: readFlag(argv, '--verifier') || 'claude',
    ...(budget ? { budget: Number(budget) } : {}),
    log: argv.includes('--json') ? () => {} : (m) => console.error(`  ${m}`),
    ...(deps.runJobs ? { runJobs: deps.runJobs } : {}),
  } : null;
  let report;
  try { report = await bench.runBench({ target: root, seenDir, sets, review: reviewOpts, env }); } catch (e) { console.error(`  the exam did not run: ${e.message}`); return 1; }
  const pub = bench.publicReport(report, { summary: argv.includes('--summary') });
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: true, ...pub }, null, 2));
  else console.log(bench.renderReport(pub, { holdoutDir: holdoutDir.replace(require('os').homedir(), '~') }));
  return 0;
}

function improveHelp() {
  console.log(`
  atris sentinel improve, one exam-checked change to the sentinel

    atris sentinel improve [--engine claude]   propose one change and judge it
    atris sentinel improve --focus exfil       point the proposer at one area:
                                               exfil, destroy, disarm or agents
    atris sentinel improve --offline           skip the published advisory lookup
    atris sentinel improve --schedule [--every 24] [--engine claude]
                                               run it on a timer, nightly by default
    atris sentinel improve --unschedule        turn the timer off

  a night run, many changes in one sitting:

    atris sentinel improve --rounds 4 --parallel 3 --review codex
        --rounds N        up to N rounds. each starts from what shipped before
        --parallel K      K proposers at once, each on its own area (up to 4)
        --review codex    codex reviews every change the exam keeps. SHIP keeps
                          it. FIX rejects it and its examples join the exam
        --max-minutes M   stop after M minutes (120 by default)
        --max-calls C     stop after C proposer and reviewer calls
        --push            push the two night branches by name when done
    atris sentinel improve --break-lock    clear a night run lock whose run is gone

  shipped rules land on sentinel-improve/night-<date>. new exam items land
  apart on sentinel-exam/<date>. you can review them on their own. the
  run stops early after two rounds with nothing shipped or no held-out gain.

  claude proposes one change to lib/sentinel-rules.json on a new branch,
  sealed off from the held-out exam. the sentinel bench, fixed code with no
  model, scores it before and after. it is kept only when
  held-out attack catch holds or rises, wrong blocks and false alarms do
  not rise and no seen item that passed now fails. a kept change waits on
  its branch for you. nothing is merged or released. nothing is pushed without --push.
`);
  return 0;
}

async function improveCommand(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return improveHelp();
  try { checkFlags(argv, ['--json', '--offline', '--schedule', '--unschedule', '--push', '--break-lock'], ['--engine', '--every', '--focus', '--rounds', '--parallel', '--review', '--max-minutes', '--max-calls']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const improve = require('../lib/sentinel-improve');
  const env = deps.env || process.env;
  if (argv.includes('--break-lock')) {
    const res = require('../lib/sentinel-night').breakLock(env);
    (res.refused ? console.error : console.log)(`  ${res.message}`);
    return res.refused ? 1 : 0;
  }
  const engine = readFlag(argv, '--engine') || 'claude';
  if (!/^[a-z][a-z0-9:_-]{0,30}$/.test(engine)) { console.error(`  unknown engine: ${engine}`); return 2; }
  const refused = require('../lib/sentinel-improve').refusedEngine(engine);
  if (refused && !argv.includes('--unschedule')) { console.error(`  ${refused}`); return 2; }
  const root = deps.root || process.cwd();
  if (argv.includes('--schedule') || argv.includes('--unschedule')) {
    const { installKeep, removeKeep } = require('../lib/campaign-keep');
    const everyHours = Number(readFlag(argv, '--every') || 24);
    if (!Number.isFinite(everyHours) || everyHours <= 0) { console.error('  --every needs a number of hours'); return 2; }
    let top;
    try { top = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { console.error('  run this inside the atris checkout the loop should improve'); return 2; }
    const plan = improve.schedulePlan({ root: top, engine, everyHours, env, atrisBin: deps.atrisBin });
    if (argv.includes('--unschedule')) {
      const removed = (deps.removeKeep || removeKeep)(plan);
      if (!removed.ok) { console.error(`  could not turn the timer off: ${removed.error}`); return 1; }
      console.log(`  sentinel improve timer: ${removed.removed === false ? 'was not on' : 'off'} for ${top}`);
      return 0;
    }
    const space = require('../lib/worktree-space');
    const bin = deps.atrisBin || path.join(__dirname, '..', 'bin', 'atris.js');
    if (!deps.atrisBin && (space.isAgentCopyPath(bin) || space.isScratchPath(bin) || space.isAgentCopyPath(top))) {
      console.error('  refusing: this atris or this checkout lives in a folder that gets removed. install the timer from a lasting checkout');
      return 2;
    }
    const installed = (deps.installKeep || installKeep)(plan);
    if (!installed.ok) { console.error(`  could not turn the timer on: ${installed.error}`); return 1; }
    console.log(`  sentinel improve timer: on for ${top}, every ${everyHours} ${everyHours === 1 ? 'hour' : 'hours'} with ${engine}`);
    console.log(`  log: ${plan.log_path}`);
    console.log('  each run leaves a receipt in ~/.atris/sentinel-improve/receipts. kept changes wait on their branch for you');
    return 0;
  }
  const focus = readFlag(argv, '--focus');
  if (argv.includes('--focus') && !focus) { console.error('  --focus needs exfil, destroy, disarm or agents'); return 2; }
  if (focus && !improve.FOCI.includes(focus)) { console.error(`  unknown focus: ${focus}. use exfil, destroy, disarm or agents`); return 2; }
  const nightFlags = ['--rounds', '--parallel', '--review', '--max-minutes', '--max-calls', '--push'];
  if (argv.some((a) => nightFlags.includes(String(a).split('=')[0]))) return nightCommand(argv, { root, engine, env, focus, deps });
  let res;
  try {
    res = await improve.improve({ root, engine, env, focus, offline: argv.includes('--offline'), log: argv.includes('--json') ? () => {} : (m) => console.log(`  ${m}`), ...(deps.improveOpts || {}) });
  } catch (e) { console.error(`  improve did not run: ${e.message}`); return 1; }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: !res.error, kept: res.kept, branch: res.branch, error: res.error || null, decision: res.decision, receipt: res.receipt }, null, 2));
    return res.error ? 1 : 0;
  }
  console.log('');
  if (res.error) console.log(`  stopped: ${res.error}`);
  else if (res.kept) console.log(`  kept. the change waits on branch ${res.branch} for your review`);
  else console.log('  rejected. the branch was removed');
  if (res.decision) {
    for (const g of res.decision.gains) console.log(`  gain: ${g}`);
    for (const n of res.decision.notes || []) console.log(`  note: ${n}`);
    for (const r of res.decision.reasons) console.log(`  stop: ${r}`);
  }
  console.log(`  receipt: ${res.receipt.replace(require('os').homedir(), '~')}\n`);
  return res.error ? 1 : 0;
}

function numFlag(argv, name) {
  const v = readFlag(argv, name);
  if (v === null) return argv.includes(name) ? NaN : undefined;
  return Number(v);
}

async function nightCommand(argv, { root, engine, env, focus, deps }) {
  const improve = require('../lib/sentinel-improve');
  const review = readFlag(argv, '--review');
  if (argv.includes('--review') && !review) { console.error('  --review needs codex'); return 2; }
  if (review && review !== 'codex') { console.error('  --review takes codex only'); return 2; }
  const opts = { root, engine, env, focus, review, push: argv.includes('--push'), offline: argv.includes('--offline') };
  for (const [flag, key] of [['--rounds', 'rounds'], ['--parallel', 'parallel'], ['--max-minutes', 'maxMinutes'], ['--max-calls', 'maxCalls']]) {
    const n = numFlag(argv, flag);
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n <= 0) { console.error(`  ${flag} needs a number above 0`); return 2; }
    if (key !== 'maxMinutes' && !Number.isInteger(n)) { console.error(`  ${flag} needs a whole number`); return 2; }
    if (key === 'parallel' && n > improve.FOCI.length) { console.error(`  --parallel goes up to ${improve.FOCI.length}, one proposer per focus area`); return 2; }
    opts[key] = n;
  }
  const json = argv.includes('--json');
  let res;
  try {
    res = await require('../lib/sentinel-night').night({ ...opts, log: json ? () => {} : (m) => console.log(`  ${m}`), ...(deps.nightOpts || {}) });
  } catch (e) { console.error(`  improve did not run: ${e.message}`); return 1; }
  if (json) {
    console.log(JSON.stringify({ ok: !res.error, shipped: res.landed, stop: res.stop, night_branch: res.night_branch, exam_branch: res.exam_branch, exam_added: res.exam_added, calls: res.calls, minutes: res.minutes, pushed: res.pushed, error: res.error || null, receipt: res.receipt }, null, 2));
    return res.error ? 1 : 0;
  }
  const home = require('os').homedir();
  console.log('');
  console.log(`  ${res.landed} ${res.landed === 1 ? 'change' : 'changes'} shipped in ${res.rounds.length} ${res.rounds.length === 1 ? 'round' : 'rounds'}. stopped because ${res.stop}`);
  if (res.night_branch) console.log(`  rules wait on ${res.night_branch}`);
  if (res.exam_branch) console.log(`  ${res.exam_added} new exam items wait on ${res.exam_branch}`);
  if (res.pushed.length) console.log(`  pushed: ${res.pushed.join(', ')}`);
  console.log(`  used ${res.calls} engine calls in ${res.minutes} minutes`);
  console.log(`  receipt: ${res.receipt.replace(home, '~')}\n`);
  return res.error ? 1 : 0;
}

module.exports = { benchCommand, improveCommand };
