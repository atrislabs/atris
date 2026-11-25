'use strict';

// atris timestone: compare the paths of a hard business decision, on this computer.
// v1 runs the engine in the Atris backend (backend/scripts/timestone.py) with that
// repo's Python. Arguments go through as an argv array, never a shell string.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const NO_ENGINE = 'Timestone runs on a computer that has the Atris backend, and the hosted version is not switched on yet.';
const DEFAULT_MODEL_CMD = 'claude -p --model haiku';
const MODEL_VERBS = new Set(['scout', 'run']);
const SCRIPT = path.join('backend', 'scripts', 'timestone.py');

function showTimestoneHelp(log = console.log) {
  [
    'usage: atris timestone [verb] [options]',
    'compare the paths of a hard decision, choose one, and record what really happened.',
    '',
    '  atris timestone                     read your situation and list the decisions most worth running (scout)',
    '  atris timestone scout [--top 5]     the same, with options',
    '  atris timestone run <n>             run number n from your latest scout',
    '  atris timestone run --from-scout <scout id> <n>',
    '  atris timestone run --question "..." --success "..." [--option "..."]...',
    '  atris timestone show <id>           print a saved run',
    '  atris timestone list                list saved runs',
    '  atris timestone choose <id> <path> --by <name> [--as mission|campaign] [--create]',
    '  atris timestone result <id> --value <number> --by <name>   record the number a campaign judge reads',
    '  atris timestone sync-campaigns      list campaigns that finished and still need their outcome recorded',
    '  atris timestone outcome <id> --result worked|partly|failed --what "..." --by <name>',
    '',
    'Runs on this computer with the Atris backend ($ATRIS_BACKEND_DIR, this repo, or the arena folder in your home).',
    `scout and run use "${DEFAULT_MODEL_CMD}" when you name no model and claude is installed.`,
    'Every verb takes --json. Add --help after a verb for all its options.',
  ].forEach((line) => log(line));
}

function hasEngineScript(dir, exists) {
  return Boolean(dir) && exists(path.join(dir, SCRIPT));
}

// The repo root above cwd that holds the engine, if any.
function repoWithEngine(cwd, exists) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (hasEngineScript(dir, exists)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// $ATRIS_BACKEND_DIR, else the repo you are in, else the arena folder in your home.
// A work copy has no venv of its own, so it borrows the main copy's Python.
function findEngine({ env = process.env, cwd = process.cwd(), home = os.homedir(), exists = fs.existsSync } = {}) {
  const mainCopy = path.join(home, 'arena', 'atrisos-backend');
  const pythonFor = (root) => [path.join(root, 'venv', 'bin', 'python'), path.join(mainCopy, 'venv', 'bin', 'python')]
    .find((candidate) => exists(candidate)) || null;

  if (env.ATRIS_BACKEND_DIR) {
    const root = path.resolve(env.ATRIS_BACKEND_DIR);
    if (!hasEngineScript(root, exists)) {
      return { error: `ATRIS_BACKEND_DIR is ${root}, and there is no Timestone engine there.` };
    }
    const python = pythonFor(root);
    return python ? { root, python, from: 'ATRIS_BACKEND_DIR' } : { error: NO_ENGINE };
  }
  for (const [root, from] of [[repoWithEngine(cwd, exists), 'this repo'], [mainCopy, 'your arena folder']]) {
    if (!hasEngineScript(root, exists)) continue;
    const python = pythonFor(root);
    if (python) return { root, python, from };
  }
  if (exists(path.join(mainCopy, 'backend')) && !hasEngineScript(mainCopy, exists)) {
    return { error: `The Atris backend at ${mainCopy} is older than Timestone; update it, or set ATRIS_BACKEND_DIR to a copy that has it.` };
  }
  return { error: NO_ENGINE };
}

function timestoneHome(env, home) {
  return env.TIMESTONE_HOME ? path.resolve(env.TIMESTONE_HOME) : path.join(home, '.atris', 'timestone');
}

// Scout ids are sc-YYYYMMDD-HHMMSS-xxxxxx, so the last name in order is the newest.
function latestScout({ env = process.env, home = os.homedir(), readdir = fs.readdirSync } = {}) {
  let names = [];
  try {
    names = readdir(path.join(timestoneHome(env, home), 'scouts'));
  } catch {
    return null;
  }
  const scouts = names.filter((name) => /^sc-.+\.json$/.test(name)).sort();
  return scouts.length ? scouts[scouts.length - 1].replace(/\.json$/, '') : null;
}

function isExecutableOnPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function flagValue(args, flag) {
  const at = args.indexOf(flag);
  if (at >= 0 && at + 1 < args.length) return args[at + 1];
  const joined = args.find((arg) => arg.startsWith(`${flag}=`));
  return joined ? joined.slice(flag.length + 1) : null;
}

// The words to hand the engine, and the line that says which model is used.
function planArgs(args, { hasClaude, latest }) {
  let words = args.length ? args.slice() : ['scout'];
  if (words[0].startsWith('-')) words = ['scout', ...words];
  const verb = words[0];

  if (verb === 'run' && /^\d+$/.test(words[1] || '') && !words.includes('--from-scout')) {
    const scout = latest();
    if (!scout) return { error: 'There is no scout yet. Run atris timestone first, then pick a number from its list.' };
    words = ['run', '--from-scout', scout, words[1], ...words.slice(2)];
  }

  let modelLine = '';
  const asksHelp = words.includes('--help') || words.includes('-h');
  if (MODEL_VERBS.has(verb) && !asksHelp) {
    const cmd = flagValue(words, '--model-cmd');
    const model = flagValue(words, '--model');
    if (cmd) modelLine = `Model: ${cmd}, as you asked.`;
    else if (model) modelLine = `Model: ${model} on OpenRouter, as you asked.`;
    else if (hasClaude) {
      words.push('--model-cmd', DEFAULT_MODEL_CMD);
      modelLine = `Model: ${DEFAULT_MODEL_CMD}, the default when you name none.`;
    } else {
      modelLine = "Model: the backend's default on OpenRouter, because claude is not installed here.";
    }
  }
  return { words, modelLine };
}

function timestoneCommand(args = [], deps = {}) {
  const env = deps.env || process.env;
  const home = deps.home || os.homedir();
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const words = args.map(String);
  const json = words.includes('--json');

  if (['help', '--help', '-h'].includes(words[0])) {
    showTimestoneHelp(log);
    return 0;
  }

  const fail = (message) => {
    if (json) log(JSON.stringify({ ok: false, error: message }));
    else err(message);
    return 1;
  };

  const engine = findEngine({ env, home, cwd: deps.cwd || process.cwd(), exists: deps.exists || fs.existsSync });
  if (engine.error) return fail(engine.error);

  const plan = planArgs(words, {
    hasClaude: deps.hasClaude !== undefined ? deps.hasClaude : isExecutableOnPath('claude', env),
    latest: () => latestScout({ env, home, readdir: deps.readdir || fs.readdirSync }),
  });
  if (plan.error) return fail(plan.error);

  const child = spawnSync(engine.python, [path.join(engine.root, SCRIPT), ...plan.words], {
    cwd: path.join(engine.root, 'backend'),
    env,
    stdio: 'inherit',
  });
  if (child.error) return fail(`Timestone could not start: ${child.error.message}`);
  // With --json the model line goes to stderr, so stdout stays one clean JSON value.
  if (plan.modelLine) (json ? err : log)(plan.modelLine);
  if (typeof child.status === 'number') return child.status;
  return 1;
}

module.exports = {
  timestoneCommand,
  findEngine,
  latestScout,
  NO_ENGINE,
  DEFAULT_MODEL_CMD,
};
