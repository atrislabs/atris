'use strict';

const {
  BenchInfraError,
  packMetadata,
  readResultRecords,
  runBench,
  taskMetadata,
} = require('../lib/bench/runner');

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name) {
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
  console.log('Usage: atris bench run [--pack <id>] [--engine <name>] [--task <id> ...] [--label baseline|candidate] [--experiment <id>] [--update-baseline] [--json]');
  console.log('Usage: atris bench results [--last N] [--json]');
  console.log('Usage: atris bench tasks [--pack <id>] [--json]');
  console.log('Usage: atris bench packs [--json]');
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
      pack: readFlag(args, '--pack') || undefined,
      engine: readFlag(args, '--engine') || undefined,
      taskIds: readRepeatedFlag(args, '--task'),
      label: readFlag(args, '--label'),
      experiment: readFlag(args, '--experiment'),
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
  const pack = readFlag(args, '--pack') || undefined;
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
  const last = Number(readFlag(args, '--last') || 0);
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

async function benchCommand(args = []) {
  const subcommand = args[0] || 'run';
  const rest = args.slice(1);
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return 0;
  }
  if (subcommand === 'run') return runCommand(rest);
  if (subcommand === 'tasks') return tasksCommand(rest);
  if (subcommand === 'packs') return packsCommand(rest);
  if (subcommand === 'results') return resultsCommand(rest);
  printHelp();
  return 2;
}

module.exports = {
  benchCommand,
};
