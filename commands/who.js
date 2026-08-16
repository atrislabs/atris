'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { repoRoot } = require('./stream');
const {
  buildWorkforcePresence,
  isFinishedReceipt,
  parsePsOutput,
  receiptEngine,
  renderWorkforcePresence,
} = require('../lib/workforce-presence');

function readJson(file, fsModule = fs, fallback = null) {
  try {
    return JSON.parse(fsModule.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonLines(file, fsModule = fs) {
  let text;
  try {
    text = fsModule.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function collectTasks(root, fsModule = fs) {
  const payload = readJson(path.join(root, '.atris', 'state', 'tasks.projection.json'), fsModule, {});
  return Array.isArray(payload?.tasks) ? payload.tasks : [];
}

function collectMissions(root, fsModule = fs) {
  const rows = readJsonLines(path.join(root, '.atris', 'state', 'missions.jsonl'), fsModule);
  const latestById = new Map();
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (id) latestById.set(id, row);
  }
  return [...latestById.values()];
}

function collectReceipts(root, fsModule = fs) {
  const runsDir = path.join(root, 'atris', 'runs');
  let names;
  try {
    names = fsModule.readdirSync(runsDir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const receipts = [];
  for (const name of names) {
    const receiptPath = path.join(runsDir, name);
    const receipt = readJson(receiptPath, fsModule);
    if (!receipt || !receiptEngine(receipt)) continue;
    let mtimeMs = 0;
    try { mtimeMs = fsModule.statSync(receiptPath).mtimeMs; } catch {}
    receipts.push({ name, path: receiptPath, mtimeMs, receipt });
  }
  return receipts;
}

function collectProcesses(deps = {}) {
  if (Array.isArray(deps.processes)) return deps.processes;
  const execFile = deps.execFile || execFileSync;
  try {
    const output = execFile('ps', ['-eo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePsOutput(output);
  } catch {
    return [];
  }
}

function collectWorkforcePresence(deps = {}) {
  const fsModule = deps.fs || fs;
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const receipts = Array.isArray(deps.receipts) ? deps.receipts : collectReceipts(root, fsModule);
  return buildWorkforcePresence({
    nowMs: typeof deps.now === 'function' ? deps.now() : Date.now(),
    staleAfterMs: deps.staleAfterMs,
    processes: collectProcesses(deps),
    tasks: Array.isArray(deps.tasks) ? deps.tasks : collectTasks(root, fsModule),
    missions: Array.isArray(deps.missions) ? deps.missions : collectMissions(root, fsModule),
    receipts,
  });
}

function archiveFinishedRuns(root, receipts, fsModule = fs) {
  const archiveDir = path.join(root, 'atris', 'runs', 'archive');
  const finished = receipts.filter((entry) => isFinishedReceipt(entry.receipt));
  const summary = {
    schema: 'atris.workforce_clear.v1',
    archive_dir: path.relative(root, archiveDir),
    archived: 0,
    failed: [],
  };
  if (!finished.length) return summary;
  fsModule.mkdirSync(archiveDir, { recursive: true });
  for (const entry of finished) {
    const destination = path.join(archiveDir, entry.name);
    if (fsModule.existsSync(destination)) {
      summary.failed.push({ receipt: entry.name, reason: 'archive destination already exists' });
      continue;
    }
    try {
      fsModule.renameSync(entry.path, destination);
      summary.archived += 1;
    } catch (error) {
      summary.failed.push({ receipt: entry.name, reason: error.message || String(error) });
    }
  }
  return summary;
}

function helpText() {
  return [
    'atris who - show local engines and team members from live process and final run state',
    '',
    'usage: atris who [--json]',
    'usage: atris who --clear [--json]',
    '',
    '--clear archives finished run receipts under atris/runs/archive/.',
  ].join('\n');
}

function whoCommand(args = [], deps = {}) {
  const write = deps.write || process.stdout.write.bind(process.stdout);
  const error = deps.error || process.stderr.write.bind(process.stderr);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    write(`${helpText()}\n`);
    return 0;
  }
  if (args.some((arg) => !['--json', '--clear'].includes(arg))) {
    error('usage: atris who [--json] [--clear]\n');
    return 2;
  }

  const fsModule = deps.fs || fs;
  const root = deps.root || repoRoot(deps.cwd || process.cwd());
  const receipts = Array.isArray(deps.receipts) ? deps.receipts : collectReceipts(root, fsModule);
  if (args.includes('--clear')) {
    const summary = archiveFinishedRuns(root, receipts, fsModule);
    if (args.includes('--json')) write(`${JSON.stringify(summary, null, 2)}\n`);
    else if (summary.failed.length) write(`archived ${summary.archived} finished runs; ${summary.failed.length} could not be archived.\n`);
    else if (summary.archived) write(`archived ${summary.archived} finished run${summary.archived === 1 ? '' : 's'} in ${summary.archive_dir}.\n`);
    else write('no finished runs to clear.\n');
    return summary.failed.length ? 1 : 0;
  }

  const presence = collectWorkforcePresence({ ...deps, root, receipts });
  const output = args.includes('--json')
    ? JSON.stringify(presence, null, 2)
    : renderWorkforcePresence(presence);
  write(`${output}\n`);
  return 0;
}

module.exports = {
  whoCommand,
};
