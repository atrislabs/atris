'use strict';

const fs = require('fs');
const path = require('path');

const {
  BenchInfraError,
  packMetadata,
  readResultRecords,
  runBench,
  taskMetadata,
} = require('../lib/bench/runner');
const { buildBenchReport, renderBenchReportText } = require('../lib/bench/report');
const { hasFlag } = require('../lib/arg-parser');

function isAtrisCliRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'atris') return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(root, 'bin', 'atris.js'))
    && fs.existsSync(path.join(root, 'atris', 'benchmarks'));
}

// Preserve the existing rule that any inline value wins over a split value.
function readInlineFirstFlag(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => String(arg).startsWith(prefix));
  if (inline) return String(inline).slice(prefix.length);
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1] && !String(args[index + 1]).startsWith('--')) return args[index + 1];
  return null;
}

function readRepeatedFlag(args, name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) {
      values.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }
  return values;
}

function printHelp() {
  console.log('Usage: atris bench run [--pack <id>] [--engine <name>] [--model <id>] [--task <id> ...] [--label baseline|candidate] [--experiment <id>] [--update-baseline] [--json]');
  console.log('Usage: atris bench results [--last N] [--json]');
  console.log('Usage: atris bench tasks [--pack <id>] [--json]');
  console.log('Usage: atris bench packs [--json]');
  console.log('Usage: atris bench report [--pack agents-v1] [--json]');
  console.log('');
  console.log('Bench runs product gates and only belongs in the atris CLI repo.');
  console.log('Pass --here to allow running outside that repo.');
}

function printRunText(record) {
  console.log(record.summary);
  for (const task of record.tasks) {
    const state = task.skipped ? 'skipped' : task.passed ? 'passed' : 'failed';
    const retry = task.retried ? ' retried' : '';
    console.log(`${state.padEnd(7)} ${task.id}${retry}`);
  }
}

async function runCommand(args) {
  const asJson = hasFlag(args, '--json');
  try {
    const result = await runBench({
      pack: readInlineFirstFlag(args, '--pack') || undefined,
      engine: readInlineFirstFlag(args, '--engine') || undefined,
      model: readInlineFirstFlag(args, '--model') || undefined,
      taskIds: readRepeatedFlag(args, '--task'),
      label: readInlineFirstFlag(args, '--label'),
      experiment: readInlineFirstFlag(args, '--experiment'),
      updateBaseline: hasFlag(args, '--update-baseline'),
      stateRoot: process.cwd(),
    });
    if (asJson) {
      console.log(JSON.stringify(result.record));
    } else {
      printRunText(result.record);
    }
    return result.exitCode;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (asJson) {
      console.log(JSON.stringify({
        schema: 'atris.bench.error.v1',
        error: message,
      }));
    } else {
      console.error(`atris bench: ${message}`);
    }
    return err instanceof BenchInfraError || err.exitCode === 2 ? 2 : 2;
  }
}

function tasksCommand(args) {
  const pack = readInlineFirstFlag(args, '--pack') || undefined;
  const tasks = taskMetadata({ pack });
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({
      schema: 'atris.bench.tasks.v1',
      pack: pack || 'core-v1',
      tasks,
    }));
    return 0;
  }
  for (const task of tasks) {
    const py = task.needsPython ? ' needs-python' : '';
    console.log(`${task.id} - ${task.title}${py}`);
  }
  return 0;
}

function packsCommand(args) {
  const packs = packMetadata();
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({
      schema: 'atris.bench.packs.v1',
      packs,
    }));
    return 0;
  }
  for (const pack of packs) {
    const mark = pack.default ? ' default' : '';
    console.log(`${pack.id} - ${pack.taskCount} tasks${mark}`);
  }
  return 0;
}

function resultsCommand(args) {
  const last = Number(readInlineFirstFlag(args, '--last') || 0);
  const results = readResultRecords({ stateRoot: process.cwd(), last });
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({
      schema: 'atris.bench.results.v1',
      results,
    }));
    return 0;
  }
  if (!results.length) {
    console.log('no bench results');
    return 0;
  }
  for (const result of results) {
    const label = result.label ? ` ${result.label}` : '';
    const experiment = result.experiment ? ` experiment=${result.experiment}` : '';
    console.log(`${result.started}${label}${experiment} ${result.summary}`);
  }
  return 0;
}

function reportCommand(args) {
  const pack = readInlineFirstFlag(args, '--pack') || undefined;
  const asJson = hasFlag(args, '--json');
  try {
    const report = buildBenchReport({ pack, stateRoot: process.cwd() });
    if (asJson) {
      console.log(JSON.stringify(report));
      return 0;
    }
    console.log(renderBenchReportText(report));
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (asJson) {
      console.log(JSON.stringify({
        schema: 'atris.bench.error.v1',
        error: message,
      }));
    } else {
      console.error(`atris bench: ${message}`);
    }
    return 2;
  }
}

async function benchCommand(args = []) {
  const subcommand = args[0] || 'run';
  const rest = args.slice(1).filter((arg) => arg !== '--here');
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return 0;
  }
  if (!hasFlag(args, '--here') && !isAtrisCliRepo(process.cwd())) {
    const message = 'refuse outside the atris cli repo; pass --here to run here';
    if (hasFlag(args, '--json') || hasFlag(rest, '--json')) {
      console.log(JSON.stringify({ schema: 'atris.bench.error.v1', error: message }));
    } else {
      console.error(`atris bench: ${message}`);
    }
    return 2;
  }
  if (subcommand === 'run') return runCommand(rest);
  if (subcommand === 'tasks') return tasksCommand(rest);
  if (subcommand === 'packs') return packsCommand(rest);
  if (subcommand === 'results') return resultsCommand(rest);
  if (subcommand === 'report') return reportCommand(rest);
  printHelp();
  return 2;
}

module.exports = {
  benchCommand,
  isAtrisCliRepo,
};
