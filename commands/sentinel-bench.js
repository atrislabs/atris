'use strict';

// atris sentinel bench and atris sentinel improve.
//
//   atris sentinel bench [--summary] [--json] [--review] [--sets guard,agents]
//   atris sentinel bench --split <file> --set guard|agents|review
//   atris sentinel improve [--engine claude] [--offline] [--json]
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
                                         and the held-out half (on this machine)

  the seen half lives in atris/sentinel-bench. the held-out half lives in
  ~/.atris/sentinel-holdout and its items are never printed. every number
  is raw: attacks blocked, everyday commands wrongly blocked, problems
  found, false alarms. there is no blended score.
`);
  return 0;
}

async function benchCommand(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return benchHelp();
  try { checkFlags(argv, ['--summary', '--json', '--review'], ['--split', '--set', '--sets', '--target', '--seen', '--hunter', '--verifier', '--budget']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const bench = require('../lib/sentinel-bench');
  const env = deps.env || process.env;
  const root = path.resolve(readFlag(argv, '--target') || deps.root || process.cwd());
  const seenDir = path.resolve(readFlag(argv, '--seen') || bench.seenDirOf(root));
  const holdoutDir = bench.defaultHoldoutDir(env);
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
    console.log('  the source file was removed so the held-out items are not left behind\n');
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
    atris sentinel improve --offline           skip the published advisory lookup
    atris sentinel improve --schedule [--every 24] [--engine claude]
                                               run it on a timer, nightly by default
    atris sentinel improve --unschedule        turn the timer off

  one engine proposes a change on a new branch. the sentinel bench, fixed
  code with no model, scores it before and after. it is kept only when
  held-out attack catch holds or rises, wrong blocks and false alarms do
  not rise and no seen item that passed now fails. a kept change waits on
  its branch for you. nothing is merged, pushed or released.
`);
  return 0;
}

async function improveCommand(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') return improveHelp();
  try { checkFlags(argv, ['--json', '--offline', '--schedule', '--unschedule'], ['--engine', '--every']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const improve = require('../lib/sentinel-improve');
  const env = deps.env || process.env;
  const engine = readFlag(argv, '--engine') || 'claude';
  if (!/^[a-z][a-z0-9:_-]{0,30}$/.test(engine)) { console.error(`  unknown engine: ${engine}`); return 2; }
  if (/^atris:/.test(engine)) { console.error('  improve runs on a local subscription engine like claude or codex, not a paid hosted one'); return 2; }
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
  let res;
  try {
    res = await improve.improve({ root, engine, env, offline: argv.includes('--offline'), log: argv.includes('--json') ? () => {} : (m) => console.log(`  ${m}`), ...(deps.improveOpts || {}) });
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
    for (const r of res.decision.reasons) console.log(`  stop: ${r}`);
  }
  console.log(`  receipt: ${res.receipt.replace(require('os').homedir(), '~')}\n`);
  return res.error ? 1 : 0;
}

module.exports = { benchCommand, improveCommand };
