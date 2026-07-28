'use strict';

/**
 * atris teach — turn one bad turn into a permanent guard.
 *
 *   atris teach                          list cases and which ones are guards
 *   atris teach add --id <id> --prompt "…" --require "<fragment>" [--complaint "…"]
 *   atris teach run [<id>]               run one case (or all) and advance state
 *   atris teach guards                   rerun every promoted guard (regression suite)
 *
 * Thin shim over `python -m rl.teach` in the backend venv, which owns the
 * red gate: a case must be observed FAILING before it can become a guard.
 * Nonzero exit means a guard regressed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND_ROOT = '/Users/keshavrao/arena/atrisos-backend';

function requireVenvPython() {
  const venvPython = path.join(BACKEND_ROOT, 'venv/bin/python');
  if (!fs.existsSync(venvPython)) {
    console.error(`✗ Backend venv not found: ${venvPython}`);
    process.exit(1);
  }
  return venvPython;
}

function usage() {
  console.log('atris teach — a bad turn becomes a failing benchmark, then a guard');
  console.log('');
  console.log('  atris teach                  list cases (red = not yet fixed, guard = protected)');
  console.log('  atris teach add …            record a misbehavior as a red case');
  console.log('  atris teach run [<id>]       run a case; a red case is SUPPOSED to fail');
  console.log('  atris teach guards           rerun every guard; nonzero exit = regression');
  console.log('  atris teach drafts           corrections captured from live turns');
  console.log('  atris teach fix <id>         brief a fix for a reproduced case (--dispatch to run it)');
  console.log('  atris teach scaffold …       turn a captured correction into a red case');
  console.log('  atris teach mine             which recorded tick failures could become cases');
  console.log('');
  console.log('  add flags: --id <kebab> --prompt "…" --require "<fragment>" (repeatable)');
  console.log('             --complaint "…" --file path=@localfile --forbid-changed-files');
}

/**
 * Map the operator-facing verbs onto `python -m rl.teach` arguments.
 * Returns null for help.
 */
function buildArgs(subcommand, args) {
  if (!subcommand || subcommand === 'list') return ['list'];
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') return null;
  if (subcommand === 'add') return ['add', ...args];
  if (subcommand === 'guards') return ['run', '--guards', ...args];
  if (subcommand === 'mine') return ['mine', ...args];
  if (subcommand === 'drafts') return ['drafts', ...args];
  if (subcommand === 'fix') {
    // `atris teach fix <id>` -> `fix --case <id>`
    if (args.length && !args[0].startsWith('-')) return ['fix', '--case', args[0], ...args.slice(1)];
    return ['fix', ...args];
  }
  if (subcommand === 'scaffold') return ['scaffold', ...args];
  if (subcommand === 'run') {
    // `atris teach run <id>` -> `run --case <id>`; bare `run` runs every case.
    if (args.length && !args[0].startsWith('-')) return ['run', '--case', args[0], ...args.slice(1)];
    return ['run', ...args];
  }
  // `atris teach <id>` is shorthand for running that one case.
  if (!subcommand.startsWith('-')) return ['run', '--case', subcommand, ...args];
  return null;
}

module.exports = function teach(subcommand, ...args) {
  const moduleArgs = buildArgs(subcommand, args);
  if (moduleArgs === null) {
    usage();
    return;
  }
  const result = spawnSync(requireVenvPython(), ['-m', 'rl.teach', ...moduleArgs], {
    cwd: path.join(BACKEND_ROOT, 'backend'),
    stdio: 'inherit',
  });
  process.exit(result.status === null ? 1 : result.status);
};

module.exports.buildArgs = buildArgs;
