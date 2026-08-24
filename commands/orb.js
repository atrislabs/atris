'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { workspaceRoot } = require('../lib/task-db');
const { collectOrbContext, appendOrbChoice } = require('../lib/orb-context');
const {
  readOrbScorecard,
  renderOrbScorecard,
  parseOrbScorecardDays,
} = require('../lib/orb-scorecard');

const MAX_VISIBLE_SUGGESTIONS = 9;
const MAX_CONCURRENT_JOBS = 3;
const VALID_ENGINES = new Set(['claude', 'codex', 'fast']);

function cleanLabel(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'run';
}

function parseEngine(args) {
  const equalsArg = args.find((arg) => arg.startsWith('--engine='));
  const flagIndex = args.indexOf('--engine');
  const engine = equalsArg
    ? equalsArg.slice('--engine='.length)
    : flagIndex !== -1
      ? args[flagIndex + 1]
      : 'claude';
  return String(engine || '').toLowerCase();
}

function engineInvocation(engine, prompt) {
  if (engine === 'codex') return { command: 'codex', args: ['exec', prompt] };
  if (engine === 'fast') return { command: 'ax', args: ['--fast', '--print', prompt] };
  return { command: 'claude', args: ['-p', prompt] };
}

function findExecutableOnPath(command, pathValue = process.env.PATH) {
  const candidates = String(command || '').includes(path.sep)
    ? [command]
    : String(pathValue || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function formatJobNotification(job) {
  const failed = Boolean(job && job.error) || Number(job && job.exitCode) !== 0;
  return failed
    ? `✗ failed: ${job.label} (o to open)`
    : `✔ ready: ${job.label} (o to open)`;
}

function renderContext(context) {
  console.log('');
  for (const beat of context.beats || []) console.log(beat);
  console.log('');
  const suggestions = (context.suggestions || []).slice(0, MAX_VISIBLE_SUGGESTIONS);
  for (const [index, suggestion] of suggestions.entries()) {
    const side = suggestion.side ? ` · ${suggestion.side}` : '';
    console.log(`${index + 1}. ${suggestion.label}${side}`);
    if (suggestion.reason) console.log(`   ${suggestion.reason}`);
  }
  console.log('');
  return suggestions;
}

function renderHint() {
  console.log('Pick 1-9, or type anything. Enter on empty = next; o = open a ready result; q = quit.');
}

function showHelp() {
  console.log('Usage: atris orb [--once] [--json] [--engine claude|codex|fast]');
  console.log('       atris orb <n> | atris orb --pick <n>');
  console.log('       atris orb scorecard [--days N]');
  console.log('');
  console.log('Choose a next move while background engine jobs keep working.');
  console.log('--json emits {moves:[{n,label,command}]} and exits.');
  console.log('Supported flags: --once, --json, --pick, --engine, --help, -h');
}

function suggestionCommand(suggestion, n) {
  const kind = String(suggestion && suggestion.kind || '');
  const label = String(suggestion && suggestion.label || '');
  if (kind === 'digest') return 'atris stream --once';
  if (kind === 'log') return 'atris log';
  if (kind === 'review' && /^accept\b/i.test(label)) return 'atris task reviews';
  return `atris orb --pick ${n}`;
}

function movesPayload(suggestions) {
  return {
    moves: suggestions.map((suggestion, index) => {
      const n = index + 1;
      return {
        n,
        label: suggestion.label || '',
        command: suggestionCommand(suggestion, n),
      };
    }),
  };
}

function parsePick(args = []) {
  const equals = args.find((arg) => arg.startsWith('--pick='));
  if (equals) {
    const value = Number(equals.slice('--pick='.length));
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  const idx = args.indexOf('--pick');
  if (idx !== -1) {
    const value = Number(args[idx + 1]);
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  const positional = args.find((arg) => /^[1-9]$/.test(String(arg)));
  if (positional) return Number(positional);
  return null;
}

function unknownOrbFlags(args = []) {
  const known = new Set(['--once', '--json', '--help', '-h', '--engine', '--pick']);
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('-')) continue;
    if (arg.startsWith('--engine=')) continue;
    if (arg.startsWith('--pick=')) continue;
    if (arg === '--engine' || arg === '--pick') {
      i += 1;
      continue;
    }
    if (!known.has(arg)) unknown.push(arg);
  }
  return unknown;
}

function tailLines(text, count = 60) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count).join('\n');
}

async function runOrb(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }

  if (args[0] === 'scorecard') {
    const parsed = parseOrbScorecardDays(args.slice(1));
    if (!parsed.ok) {
      console.error(`orb scorecard: ${parsed.error}`);
      return 2;
    }
    const scorecard = readOrbScorecard(workspaceRoot(), { days: parsed.days });
    console.log(renderOrbScorecard(scorecard));
    return 0;
  }

  const unknown = unknownOrbFlags(args);
  if (unknown.length) {
    console.error(`unknown orb option: ${unknown.join(', ')}`);
    console.error('supported flags: --once, --json, --pick, --engine, --help, -h');
    return 2;
  }

  const engine = parseEngine(args);
  if (!VALID_ENGINES.has(engine)) {
    console.error(`Unknown orb engine: ${engine || '(empty)'}. Use claude, codex, or fast.`);
    return 2;
  }

  const asJson = args.includes('--json');
  const pick = parsePick(args);
  const engineCommand = engineInvocation(engine, '').command;
  if (!asJson && !findExecutableOnPath(engineCommand)) {
    console.error(`orb warning: engine binary "${engineCommand}" is missing from PATH; picks will fail until it is installed.`);
  }

  const root = workspaceRoot();
  let context = await collectOrbContext(root, { threads: [] });

  if (asJson) {
    const suggestions = (context.suggestions || []).slice(0, MAX_VISIBLE_SUGGESTIONS);
    console.log(JSON.stringify(movesPayload(suggestions), null, 2));
    return 0;
  }

  let visibleSuggestions = renderContext(context);

  if (pick != null) {
    const choice = visibleSuggestions[pick - 1];
    if (!choice) {
      console.error(`orb: no move ${pick}. Pick 1-${visibleSuggestions.length || 0}.`);
      return 2;
    }
    // One-shot pick: record the choice and print the runnable command, then exit.
    // Interactive mode still launches background engines; agents use --json + --pick.
    const appended = await appendOrbChoice(root, cleanLabel(choice.label));
    if (!appended.ok) {
      console.error(`Could not update now.md: ${appended.error}`);
      return 1;
    }
    const command = suggestionCommand(choice, pick);
    console.log(`picked ${pick}: ${choice.label}`);
    console.log(`next: ${command}`);
    if (choice.prompt) console.log(`prompt: ${choice.prompt}`);
    return 0;
  }

  const once = args.includes('--once') || !process.stdin.isTTY || !process.stdout.isTTY;
  if (once) return 0;

  renderHint();
  const runsDir = path.join(root, '.atris', 'state', 'orb-runs');
  const indexPath = path.join(runsDir, 'index.jsonl');
  const jobs = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;

  function prompt() {
    if (!closing) rl.prompt();
  }

  function notifyReady(job) {
    if (closing) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(formatJobNotification(job));
    prompt();
  }

  function runningJobs() {
    return jobs.filter((job) => job.status === 'running');
  }

  function duplicateInFlight(label) {
    const normalized = cleanLabel(label).toLowerCase();
    return runningJobs().some((job) => cleanLabel(job.label).toLowerCase() === normalized);
  }

  function finishJob(job, code, error) {
    if (job.status !== 'running') return;
    job.exitCode = Number.isInteger(code) ? code : 1;
    job.error = error ? String(error.message || error) : null;
    job.status = job.exitCode === 0 && !job.error ? 'ready' : 'failed';
    job.unread = true;
    job.durationMs = Date.now() - job.startedAtMs;
    if (error) {
      try {
        fs.appendFileSync(job.logPath, `\nengine launch failed: ${error.message || error}\n`, 'utf8');
      } catch {}
    }
    const record = {
      status: job.status,
      ts: new Date().toISOString(),
      label: job.label,
      kind: job.kind,
      engine: job.engine,
      exitCode: job.exitCode,
      durationMs: job.durationMs,
      logPath: path.relative(root, job.logPath),
      error: job.error,
    };
    fs.promises.appendFile(indexPath, `${JSON.stringify(record)}\n`, 'utf8').catch(() => {});
    notifyReady(job);
  }

  async function dispatch(choice) {
    const label = cleanLabel(choice.label);
    if (duplicateInFlight(label)) {
      console.log('already working on that');
      return;
    }
    const running = runningJobs().length;
    if (running >= MAX_CONCURRENT_JOBS) {
      console.log(`that will have to wait - ${running} jobs running`);
      return;
    }

    const appended = await appendOrbChoice(root, label);
    if (!appended.ok) {
      console.error(`Could not update now.md: ${appended.error}`);
      return;
    }

    fs.mkdirSync(runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(runsDir, `${stamp}-${slugify(label)}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const invocation = engineInvocation(engine, choice.prompt);
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: root,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }

    const startedAt = new Date().toISOString();
    const relativeLogPath = path.relative(root, logPath);
    if (Number.isInteger(child.pid) && child.pid > 0) {
      fs.appendFileSync(indexPath, `${JSON.stringify({
        status: 'dispatched',
        ts: startedAt,
        label,
        kind: choice.kind || 'freeform',
        engine,
        logPath: relativeLogPath,
        pid: child.pid,
      })}\n`, 'utf8');
    }

    const job = {
      label,
      kind: choice.kind || 'freeform',
      engine,
      startedAt,
      startedAtMs: Date.now(),
      logPath,
      child,
      status: 'running',
      unread: false,
    };
    jobs.push(job);
    child.once('error', (error) => finishJob(job, 1, error));
    child.once('exit', (code) => finishJob(job, code));
    child.unref();
    console.log(`working: ${label}`);
  }

  async function refresh() {
    context = await collectOrbContext(root, { threads: [] });
    visibleSuggestions = renderContext(context);
    renderHint();
  }

  async function openReady() {
    const job = jobs.find((candidate) => ['ready', 'failed'].includes(candidate.status) && candidate.unread);
    if (!job) {
      console.log('No ready result yet.');
      return;
    }
    job.unread = false;
    try {
      const output = tailLines(await fs.promises.readFile(job.logPath, 'utf8'));
      console.log(`\n${job.label}`);
      console.log(output || '(empty result)');
      console.log('');
    } catch (error) {
      console.error(`Could not open result: ${error.message || error}`);
    }
  }

  return await new Promise((resolve) => {
    rl.setPrompt('> ');
    prompt();
    rl.on('line', async (line) => {
      rl.pause();
      const input = line.trim();
      if (input.toLowerCase() === 'q') {
        closing = true;
        rl.close();
        return;
      }
      if (!input) {
        await refresh();
      } else if (input.toLowerCase() === 'o') {
        await openReady();
      } else if (/^[1-9]$/.test(input) && visibleSuggestions[Number(input) - 1]) {
        await dispatch(visibleSuggestions[Number(input) - 1]);
      } else {
        await dispatch({ label: input, kind: 'freeform', prompt: input });
      }
      rl.resume();
      prompt();
    });
    rl.once('close', () => resolve(0));
  });
}

module.exports = {
  runOrb,
  formatJobNotification,
  tailLines,
};
