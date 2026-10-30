'use strict';

// atris scorecard: which AI can do your team's work, measured on your own
// past changes and graded by the tests that shipped with them. Finding tasks
// runs no AI. Tries run on your Claude plan login, never an API key.

const fs = require('fs');
const path = require('path');
const { hasFlag, readFlag, readIntFlag, readNumberFlag } = require('../lib/arg-parser');
const sc = require('../lib/repo-scorecard');

const USAGE = [
  'usage: atris scorecard [find | run | show] [options]',
  '  which AI can do your team\'s work, measured on your own past changes.',
  '',
  '  atris scorecard          find tasks the first time, then show the scorecard',
  '  atris scorecard find     turn past changes into tasks their own tests grade (no AI runs)',
  '  atris scorecard run      try each task with each model on your Claude plan',
  '  atris scorecard show     print the scorecard from saved results',
  '',
  'find options:',
  '  --max N          keep at most N tasks (default 12)',
  '  --scan N         look through the last N changes (default 300)',
  '  --config FILE    test commands for this repo (default .atris/scorecard.json)',
  '  --with-env       copy .env files into each copy, read-only, billing keys left out',
  '',
  'run options:',
  '  --models a,b     models to try (default haiku). any model past haiku needs',
  '                   ATRIS_CLAUDE_SPEND_OK=<model> because it uses much more of your plan',
  '  --tries N        tries per task and model (default 1). a stopped run picks up where it left off',
  '  --jobs N         tries at a time (default 2)',
  '  --minutes N      time limit per try (default 10, 20 for opus and fable)',
  '  --task ID        only this task (its id or the first characters of its change)',
  '  --allow-extra-usage  run even when extra usage is on for your Claude account',
  '',
  '  --json           print the result as json',
].join('\n');

function storePaths(root) {
  const dir = sc.storeDir(root);
  return { dir, tasks: path.join(dir, 'tasks.json'), results: path.join(dir, 'results.jsonl') };
}

function readTasks(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readResults(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function firstLine(text, width) {
  const line = String(text || '').split('\n')[0];
  return line.length > width ? `${line.slice(0, width - 3)}...` : line;
}

const SKIP_WORDS = {
  no_tests: 'had no tests changed beside the code',
  too_big: 'were too big for one ask',
  short_ask: 'had too few words to work from',
  unknown_runner: 'used a test setup this cannot run yet',
  fails_after: 'had tests that fail even with the change',
  passes_before: 'had tests that already passed before the change',
};

function skipSummary(skipped) {
  return Object.entries(skipped || {}).filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${SKIP_WORDS[key] || key}`).join(', ');
}

async function find(root, args, { quiet = false } = {}) {
  const paths = storePaths(root);
  const json = hasFlag(args, '--json');
  const say = (line) => { if (!json && !quiet) console.log(line); };
  const max = readIntFlag(args, '--max', sc.MAX_TASKS);
  const scan = readIntFlag(args, '--scan', 300);
  say(`atris scorecard  ${sc.repoName(root)}`);
  say(`looking through the last ${scan} changes for ones whose own tests can grade an AI. no AI runs in this step.`);
  say('');
  const scratch = sc.workDir(root);
  let result;
  try {
    result = await sc.findTasks(root, {
      max,
      scan,
      configPath: readFlag(args, '--config', '') || undefined,
      withEnv: hasFlag(args, '--with-env'),
      workDir: scratch,
      onCheck: (task, verdict) => {
        const word = verdict === 'found' ? 'task' : 'skip';
        const why = verdict === 'found' ? sc.runnerLabel(task.runner) : SKIP_WORDS[verdict];
        say(`  ${word}  ${task.fix.slice(0, 7)}  ${firstLine(task.ask, 60).padEnd(60)}  ${why}`);
      },
    });
  } finally {
    sc.stopAll();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const saved = {
    repo: sc.repoName(root),
    root,
    found_at: new Date().toISOString(),
    looked: result.looked,
    candidates: result.candidates,
    skipped: result.skipped,
    tasks: result.tasks,
  };
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.tasks, `${JSON.stringify(saved, null, 2)}\n`);
  if (json) {
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  }
  if (!quiet) {
    say('');
    say(`found ${result.tasks.length} ${result.tasks.length === 1 ? 'task' : 'tasks'} in ${result.looked} past changes.`);
    const skips = skipSummary(result.skipped);
    if (skips) say(`the rest ${skips}.`);
    if (!result.tasks.length) {
      say('');
      say('if your tests need a command or settings to run, put them in .atris/scorecard.json, for example:');
      say('  {"tests": [{"match": "^backend/", "dir": "backend", "cmd": "python -m pytest -q {files}", "env": {"ENV": "test"}}]}');
      return 1;
    }
    say('');
    say('next: atris scorecard run');
    say(`  tries each task with ${sc.shortModel(sc.DEFAULT_MODELS[0])} on your Claude plan, up to 10 minutes each, 2 at a time.`);
  }
  return result.tasks.length ? 0 : 1;
}

function pickTasks(saved, args) {
  const only = readFlag(args, '--task', '');
  if (!only) return saved.tasks;
  return saved.tasks.filter((task) => task.id === only || task.id.startsWith(only) || task.fix.startsWith(only));
}

async function run(root, args) {
  const paths = storePaths(root);
  const json = hasFlag(args, '--json');
  const say = (line) => { if (!json) console.log(line); };
  let saved = readTasks(paths.tasks);
  if (!saved) {
    say('no tasks yet, so finding them first.');
    say('');
    const code = await find(root, args.filter((a) => a !== '--json'), { quiet: json });
    if (code !== 0) return code;
    saved = readTasks(paths.tasks);
    say('');
  }
  const tasks = pickTasks(saved, args);
  if (!tasks.length) {
    console.error(saved.tasks.length ? 'no task matches --task.' : 'there are no tasks to run. try atris scorecard find --scan 1000');
    return 1;
  }
  const models = sc.normalizeModels(readFlag(args, '--models', ''));
  let login;
  try {
    login = sc.preflight(models, { allowExtraUsage: hasFlag(args, '--allow-extra-usage') });
  } catch (err) {
    console.error(err.message || String(err));
    return 1;
  }
  const tries = Math.max(1, readIntFlag(args, '--tries', 1) || 1);
  const jobs = Math.max(1, readIntFlag(args, '--jobs', 2) || 2);
  const minutes = readNumberFlag(args, '--minutes', null);
  const before = readResults(paths.results);
  const names = models.map(sc.shortModel).join(', ');
  say(`atris scorecard run  ${sc.repoName(root)}`);
  say(`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} x ${names}, ${tries} ${tries === 1 ? 'try' : 'tries'} each, ${jobs} at a time.`);
  say(`on your ${login.plan}. pay-per-use keys are removed from every run${login.extraUsage ? '' : ', so this bills $0'}.`);
  say('');

  const scratch = sc.workDir(root);
  const cleanup = () => {
    sc.stopAll();
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    console.error('\nstopped. finished tries are saved; run the same command to pick up where it left off.');
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let outcome;
  try {
    outcome = await sc.runAll(root, tasks, {
      models,
      tries,
      jobs,
      minutes,
      bin: login.bin,
      withEnv: hasFlag(args, '--with-env'),
      done: before,
      workDir: scratch,
      outDir: paths.dir,
      onResult: (row) => {
        fs.appendFileSync(paths.results, `${JSON.stringify(row)}\n`);
        const task = tasks.find((t) => t.id === row.id) || { fix: row.id, ask: '' };
        let word = row.passed ? 'pass' : 'fail';
        let note = row.timed_out ? `${row.limit_minutes} min (time limit)` : `${row.minutes} min`;
        if (row.engine_error) { word = 'skip'; note = firstLine(row.engine_tail, 50) || 'claude did not finish'; }
        if (row.harness_error) { word = 'skip'; note = firstLine(row.harness_error, 50); }
        say(`  ${word}  ${sc.shortModel(row.model).padEnd(10)}  ${task.fix.slice(0, 7)}  ${firstLine(task.ask, 50).padEnd(50)}  ${note}`);
      },
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
  const rows = readResults(paths.results);
  const summary = sc.summarize(saved.tasks, rows, models);
  if (json) {
    console.log(JSON.stringify({ ...summary, stopped: outcome.stopped, ran: outcome.rows.length }, null, 2));
    return outcome.stopped ? 1 : 0;
  }
  if (!outcome.planned) say('every try asked for is already done.');
  say('');
  console.log(sc.renderScorecard(summary, { repo: sc.repoName(root), plan: login.plan, extraUsage: login.extraUsage }));
  if (outcome.stopped) {
    const billed = outcome.rows.find((row) => row.not_plan);
    say('');
    say(billed
      ? `stopped: ${billed.engine_tail} log in to your Claude plan with \`claude\` then /login, and run it again.`
      : 'stopped early: your Claude plan hit its usage limit. run the same command after it resets to finish.');
    return 1;
  }
  return 0;
}

function show(root, args) {
  const paths = storePaths(root);
  const saved = readTasks(paths.tasks);
  if (!saved) {
    console.error('no scorecard yet. run: atris scorecard find');
    return 1;
  }
  const rows = readResults(paths.results);
  const summary = sc.summarize(saved.tasks, rows);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (!rows.some((row) => saved.tasks.some((task) => task.id === row.id))) {
    console.log(`atris scorecard  ${saved.repo}`);
    console.log(`${saved.tasks.length} tasks found, none tried yet:`);
    for (const task of saved.tasks) console.log(`  ${task.fix.slice(0, 7)}  ${firstLine(task.ask, 80)}`);
    console.log('');
    console.log('next: atris scorecard run');
    return 0;
  }
  const login = sc.planLogin();
  console.log(sc.renderScorecard(summary, { repo: saved.repo, plan: login.ok ? login.plan : '', extraUsage: login.extraUsage }));
  return 0;
}

async function scorecardCommand(args = []) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    console.log(USAGE);
    return 0;
  }
  let root;
  try {
    root = sc.repoRoot();
  } catch {
    console.error('atris scorecard works inside a git repo. cd into one and try again.');
    return 1;
  }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : '';
  const rest = sub ? args.slice(1) : args;
  if (sub === 'find') return find(root, rest);
  if (sub === 'run') return run(root, rest);
  if (sub === 'show') return show(root, rest);
  if (sub) {
    console.error(`unknown step "${sub}".\n\n${USAGE}`);
    return 1;
  }
  if (!readTasks(storePaths(root).tasks)) {
    const code = await find(root, rest);
    return code;
  }
  return show(root, rest);
}

module.exports = { scorecardCommand, USAGE };
