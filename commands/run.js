/**
 * Atris Run — Auto-chain plan → do → review cycles
 *
 * The ignition switch. Reads inbox/backlog, loops autonomously
 * until work is done or max cycles reached.
 *
 * Uses the shared runner command (default Claude-compatible subprocess).
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { parseTodo } = require('../lib/todo');
const {
  buildRunnerCommand,
  buildRunnerAvailabilityCommand,
  resolveClaudeRunnerBin,
} = require('../lib/runner-command');
const { cleanAtris } = require('./clean');

const pkg = require('../package.json');

const DEFAULT_MAX_CYCLES = 5;
const PHASE_TIMEOUT = 600000; // 10 min per phase

/**
 * Resolve the run log directory (atris/logs/runs/), creating it if needed.
 * Returns the directory path.
 */
function getRunLogDir() {
  const runsDir = path.join(process.cwd(), 'atris', 'logs', 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  return runsDir;
}

/**
 * Build a per-cycle run log path with a run-scoped timestamp so multiple
 * same-day runs don't clobber each other.
 */
function getRunLogPath(runStamp, cycle) {
  const { dateFormatted } = getLogPath();
  const runsDir = getRunLogDir();
  return path.join(runsDir, `${dateFormatted}-${runStamp}-cycle-${cycle}.md`);
}

/**
 * Append a phase section to the cycle's run log. Creates the file with a
 * header on first write.
 */
function writePhaseToRunLog(runLogPath, cycle, phase, output, durationMs) {
  const header = `# Run Log — Cycle ${cycle}\n\n`;
  const phaseSection = `## ${phase.toUpperCase()} (${Math.round(durationMs / 1000)}s)\n\n${output || '(no output)'}\n\n---\n\n`;

  if (!fs.existsSync(runLogPath)) {
    fs.writeFileSync(runLogPath, header + phaseSection);
  } else {
    fs.appendFileSync(runLogPath, phaseSection);
  }
}

function isPhaseTimeoutError(err) {
  return Boolean(err && err.code === 'ETIMEDOUT');
}

function isPhaseKillError(err) {
  return Boolean(err && (err.killed || err.code === 'ETIMEDOUT' || err.signal));
}

function execPhaseCommandSync(cmd, opts = {}) {
  try {
    // Use spawnSync for better stdio control. In verbose mode, stdout inherits
    // for live streaming while stderr also inherits. In non-verbose mode,
    // stdout is piped for capture. stdout is always available in result.stdout
    // when piped.
    const spawnOpts = {
      cwd: opts.cwd,
      encoding: opts.encoding,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      env: opts.env,
      detached: true,
      stdio: opts.stdio,
      shell: true,
    };
    const result = spawnSync(cmd, [], spawnOpts);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const err = new Error(`${cmd} exited with code ${result.status}`);
      err.status = result.status;
      err.stdout = result.stdout;
      err.stderr = result.stderr;
      err.signal = result.signal;
      err.killed = result.killed;
      err.pid = result.pid;
      throw err;
    }
    return result.stdout || '';
  } catch (err) {
    if (isPhaseKillError(err) && err.pid) {
      try {
        process.kill(-err.pid, 'SIGKILL');
      } catch (sweepErr) {
        if (sweepErr.code !== 'ESRCH') throw sweepErr;
      }
    }
    throw err;
  }
}

/**
 * Build prompt for each phase with full context
 */
function buildRunPrompt(phase, context) {
  const { mapPath, todoPath, personaPath, lessonsPath, journalPath } = context;

  const readFiles = [
    personaPath && `- ${personaPath}`,
    mapPath && `- ${mapPath}`,
    todoPath && `- ${todoPath}`,
    lessonsPath && `- ${lessonsPath}`,
    journalPath && `- ${journalPath}`,
  ].filter(Boolean).join('\n');

  if (phase === 'plan') {
    return `You are the Navigator agent. Your job is to plan work from the inbox.

Read these files first:
${readFiles}

Workflow:
1. Read the journal's ## Inbox section for ideas/tasks
2. Read MAP.md for codebase navigation (file:line references)
3. Read lessons.md for past learnings (if it exists)
4. For each inbox item, create a task in TODO.md under ## Backlog
   Format: - **T#:** Description [execute]
5. Keep tasks small and specific (one function, one file, one fix)
6. Do NOT write code. Planning only.

If inbox is empty but TODO.md has backlog tasks, skip planning — tasks already exist.
If both inbox and backlog are empty, reply: [NOTHING_TO_DO]

Reply [PLAN_COMPLETE] when done.`;
  }

  if (phase === 'do') {
    return `You are the Executor agent. Your job is to build tasks from the backlog.

Read these files first:
${readFiles}

Workflow:
1. Read TODO.md — pick the first task from ## Backlog
2. Move it to ## In Progress with: **Claimed by:** Executor at ${new Date().toISOString()}
3. Read MAP.md to find exact file:line locations
4. Implement the task step by step
5. After implementation, verify the changes work
6. Update MAP.md if you changed function locations or added new functions
7. Commit changes: git add <specific-files> && git commit -m "feat: <description>"

Do NOT skip steps. Verify before marking complete.

Reply [DO_COMPLETE] when the task is built and committed.`;
  }

  if (phase === 'review') {
    return `You are the Validator agent. Your job is to verify work quality.

Read these files first:
${readFiles}

Workflow:
1. Read TODO.md — find the task in ## In Progress
2. Review the implementation:
   - Does it actually work? Test it if possible.
   - Does it follow existing patterns? (check MAP.md)
   - Any bugs, edge cases, or security issues?
3. If tests exist, run them
4. If issues found: fix them, then continue
5. When satisfied:
   a. Delete the task from TODO.md (target state = 0)
   b. Move the inbox item to ## Completed in today's journal
      Format: - **C#:** Description [reviewed]
   c. If you learned something, append to lessons.md
6. Run: atris clean --dry-run (to check MAP.md refs)

Reply [REVIEW_COMPLETE] when validation passes.
Reply [REVIEW_FAILED] reason if something is broken.`;
  }

  return '';
}

/**
 * Execute a phase using the configured runner command.
 */
function executePhase(phase, context, options = {}) {
  const { verbose = false, timeout = PHASE_TIMEOUT } = options;

  const prompt = buildRunPrompt(phase, context);
  const tmpFile = path.join(process.cwd(), '.run-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = buildRunnerCommand({ promptFile: tmpFile, allowedTools: 'Bash,Read,Write,Edit,Glob,Grep' });
    // Strip CLAUDECODE env var to allow spawning from within a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const output = execPhaseCommandSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout,
      // In verbose mode: inherit stdout+stderr for live streaming.
      // In non-verbose mode: pipe stdout for capture (run logs), inherit stderr.
      stdio: verbose ? 'inherit' : ['pipe', 'pipe', 'inherit'],
      maxBuffer: 10 * 1024 * 1024,
      env
    });

    try { fs.unlinkSync(tmpFile); } catch {}
    return output || '';
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (isPhaseTimeoutError(err)) {
      throw new Error(`${phase} timed out after ${timeout / 1000}s`);
    }
    if (isPhaseKillError(err)) {
      throw new Error(`${phase} killed by ${err.signal || 'a signal'} before the ${timeout / 1000}s wall`);
    }
    // execSync throws on non-zero exit but may still have output
    if (err.stdout) return err.stdout;
    throw err;
  }
}

/**
 * Check if there's work to do (inbox items or backlog tasks)
 */
function hasWork(atrisDir) {
  // Check backlog tasks
  const todoPath = path.join(atrisDir, 'TODO.md');
  const todo = parseTodo(todoPath);
  if (todo.backlog.length > 0 || todo.inProgress.length > 0) return true;

  // Check inbox
  const { logFile } = getLogPath();
  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, 'utf8');
    const inboxMatch = content.match(/## Inbox\r?\n([\s\S]*?)(?=\r?\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      const items = inboxMatch[1].trim().split('\n').filter(l => {
        const t = l.trim();
        return t.startsWith('- ') && t.length > 2;
      });
      if (items.length > 0) return true;
    }
  }

  return false;
}

/**
 * Log completion to journal
 */
function logRunCompletion(cycles, startTime, cycleTimings = []) {
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  let content = fs.readFileSync(logFile, 'utf8');
  const duration = Math.round((Date.now() - startTime) / 1000);

  let timingLines = '';
  if (cycleTimings.length > 0) {
    timingLines = cycleTimings.map((t, i) =>
      `- Cycle ${i + 1}: plan ${Math.round(t.plan / 1000)}s, do ${Math.round(t.do / 1000)}s, review ${Math.round(t.review / 1000)}s`
    ).join('\n');
    timingLines = '\n' + timingLines;
  }

  const entry = `\n### Atris Run — ${new Date().toLocaleTimeString()}\n- Cycles: ${cycles}\n- Duration: ${duration}s${timingLines}\n`;

  if (content.includes('## Notes')) {
    content = content.replace(/(## Notes[^\n]*\n)/, `$1${entry}\n`);
  } else {
    content += `\n## Notes\n${entry}\n`;
  }

  fs.writeFileSync(logFile, content);
}

/**
 * Main run function — the ignition switch
 */
async function runAtris(options = {}) {
  const {
    maxCycles = DEFAULT_MAX_CYCLES,
    verbose = false,
    dryRun = false,
    once = false,
    push = true,
    timeout = PHASE_TIMEOUT
  } = options;

  const cycles = once ? 1 : maxCycles;
  const atrisDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(atrisDir)) {
    console.error('atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Check configured runner CLI is available.
  try {
    execSync(buildRunnerAvailabilityCommand(), { stdio: 'pipe' });
  } catch {
    console.error(`${resolveClaudeRunnerBin()} CLI not found. Set ATRIS_RUNNER_BIN (or legacy ATRIS_CLAUDE_BIN), or install the configured runner first.`);
    process.exit(1);
  }

  console.log('');
  if (verbose) {
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│ Atris Run v${pkg.version} — autonomous plan → do → review       │`);
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`Max cycles: ${cycles}`);
    console.log(`Phase timeout: ${timeout / 1000}s`);
    console.log(`Verbose: ${verbose}`);
    console.log(`Run logs: atris/logs/runs/`);
    console.log('');
  } else {
    console.log(`atris run v${pkg.version} — plan, do, review, repeat.`);
    console.log(`i'll run up to ${cycles} cycle${cycles === 1 ? '' : 's'}, ${timeout / 1000}s per phase. next i'll check the backlog.`);
    console.log(`phase reasoning will be saved to atris/logs/runs/ — you can read what i thought after.`);
    console.log('');
  }

  // Build context paths
  const context = {
    mapPath: fs.existsSync(path.join(atrisDir, 'MAP.md')) ? 'atris/MAP.md' : null,
    todoPath: fs.existsSync(path.join(atrisDir, 'TODO.md')) ? 'atris/TODO.md' : null,
    personaPath: fs.existsSync(path.join(atrisDir, 'PERSONA.md')) ? 'atris/PERSONA.md' : null,
    lessonsPath: fs.existsSync(path.join(atrisDir, 'lessons.md')) ? 'atris/lessons.md' : null,
    journalPath: (() => { const { logFile } = getLogPath(); return fs.existsSync(logFile) ? path.relative(process.cwd(), logFile) : null; })(),
  };

  if (dryRun) {
    console.log('[DRY RUN] Would execute:');
    console.log(`  ${cycles} cycles of plan → do → review`);
    console.log('  Context:', JSON.stringify(context, null, 2));
    return;
  }

  const startTime = Date.now();
  const runStamp = String(startTime).slice(-6); // HHMMSS-style run-scoped suffix
  const cycleTimings = [];
  const writtenRunLogs = [];
  let completedCycles = 0;

  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (verbose) {
      console.log(`\n${'━'.repeat(60)}`);
      console.log(`CYCLE ${cycle}/${cycles}`);
      console.log(`${'━'.repeat(60)}`);
    } else {
      console.log(`\ncycle ${cycle} of ${cycles}.`);
    }

    // Check if there's work
    if (!hasWork(atrisDir)) {
      console.log(verbose
        ? '\nInbox empty. Backlog empty. Nothing to do.'
        : 'i checked the inbox and backlog. both empty. nothing to do.');
      break;
    }

    const timing = { plan: 0, do: 0, review: 0 };
    const runLogPath = getRunLogPath(runStamp, cycle);

    try {
      // PLAN
      console.log(verbose
        ? '\n[1/3] PLAN — reading inbox, creating tasks...'
        : 'planning… reading inbox, turning ideas into tasks.');
      let phaseStart = Date.now();
      const planOutput = executePhase('plan', context, { verbose, timeout });
      timing.plan = Date.now() - phaseStart;

      writePhaseToRunLog(runLogPath, cycle, 'plan', planOutput, timing.plan);
      if (!writtenRunLogs.includes(runLogPath)) writtenRunLogs.push(runLogPath);

      if (planOutput.includes('[NOTHING_TO_DO]')) {
        console.log(verbose ? 'Nothing to do. Stopping.' : 'navigator says nothing to do. stopping.');
        break;
      }
      console.log(verbose
        ? `✓ Plan complete (${Math.round(timing.plan / 1000)}s)`
        : `planned in ${Math.round(timing.plan / 1000)}s. next i'll pick the top backlog task and build it.`);

      // Check if plan created tasks
      if (!hasWork(atrisDir)) {
        console.log(verbose ? 'No tasks created. Stopping.' : 'no tasks got created. stopping.');
        break;
      }

      // DO
      console.log(verbose ? '\n[2/3] DO — building task...' : 'building the top task now.');
      phaseStart = Date.now();
      const doOutput = executePhase('do', context, { verbose, timeout });
      timing.do = Date.now() - phaseStart;
      writePhaseToRunLog(runLogPath, cycle, 'do', doOutput, timing.do);

      console.log(verbose
        ? `✓ Build complete (${Math.round(timing.do / 1000)}s)`
        : `built in ${Math.round(timing.do / 1000)}s. next i'll review it.`);

      // REVIEW
      console.log(verbose ? '\n[3/3] REVIEW — validating...' : 'reviewing the change against tests and validate.md.');
      phaseStart = Date.now();
      const reviewOutput = executePhase('review', context, { verbose, timeout });
      timing.review = Date.now() - phaseStart;
      writePhaseToRunLog(runLogPath, cycle, 'review', reviewOutput, timing.review);

      if (reviewOutput.includes('[REVIEW_FAILED]')) {
        console.log(verbose
          ? '⚠ Review found issues. Stopping for manual check.'
          : 'review found issues. stopping so a human can look.');
        cycleTimings.push(timing);
        completedCycles++;
        break;
      }
      console.log(verbose
        ? `✓ Review complete (${Math.round(timing.review / 1000)}s)`
        : `review passed in ${Math.round(timing.review / 1000)}s.`);

      cycleTimings.push(timing);
      completedCycles++;

      // Self-heal MAP.md refs after each cycle
      console.log(verbose
        ? '\n[+] CLEAN — healing MAP.md refs...'
        : 'cleaning up drifted MAP.md refs.');
      try {
        cleanAtris({ dryRun: false });
      } catch (cleanErr) {
        console.log(`${verbose ? '⚠ Clean failed: ' : 'clean failed: '}${cleanErr.message}`);
      }

      // Auto-push if not disabled
      if (push) {
        console.log(verbose ? '\n[+] PUSH — pushing to remote...' : 'pushing to remote.');
        try {
          execSync('git push', { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
          console.log(verbose ? '✓ Pushed to remote' : 'pushed.');
        } catch (pushErr) {
          console.log(`${verbose ? '⚠ Push failed: ' : 'push failed: '}${pushErr.message.split('\n')[0]}`);
        }
      }

      console.log(verbose
        ? `\n✓ Cycle ${cycle} done`
        : `cycle ${cycle} done. next cycle.`);

    } catch (err) {
      console.error(`\n✗ Cycle ${cycle} failed: ${err.message}`);
      // Log the failure to the run log for forensic value
      try {
        writePhaseToRunLog(runLogPath, cycle, 'error', `Error: ${err.message}\n\nStack: ${err.stack || '(no stack)'}`, 0);
        if (!writtenRunLogs.includes(runLogPath)) writtenRunLogs.push(runLogPath);
      } catch {}
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // Log to journal
  logRunCompletion(completedCycles, startTime, cycleTimings);

  console.log('');
  if (verbose) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Run complete. ${elapsed}s elapsed.`);

    if (cycleTimings.length > 0) {
      console.log('');
      console.log('  Cycle  │  Plan   │   Do    │ Review');
      console.log('  ───────┼─────────┼─────────┼────────');
      cycleTimings.forEach((t, i) => {
        const p = `${Math.round(t.plan / 1000)}s`.padStart(5);
        const d = `${Math.round(t.do / 1000)}s`.padStart(5);
        const r = `${Math.round(t.review / 1000)}s`.padStart(5);
        console.log(`    ${String(i + 1).padStart(2)}   │ ${p}   │ ${d}   │ ${r}`);
      });
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  } else {
    console.log(`run complete. ${completedCycles} cycle${completedCycles === 1 ? '' : 's'} in ${elapsed}s. logged to today's journal.`);
    console.log('');
  }

  // Print run log paths so the reasoning is discoverable as material
  if (writtenRunLogs.length > 0) {
    console.log(`run logs: atris/logs/runs/ (${writtenRunLogs.length} file${writtenRunLogs.length === 1 ? '' : 's'})`);
    for (const logPath of writtenRunLogs) {
      console.log(`  ${path.relative(process.cwd(), logPath)}`);
    }
    console.log('');
  }

  // Auto-prune old run logs (keep last 100)
  try {
    const runsDir = getRunLogDir();
    if (fs.existsSync(runsDir)) {
      const allLogs = fs.readdirSync(runsDir).filter(f => f.endsWith('.md')).sort().reverse();
      const keep = 100;
      if (allLogs.length > keep) {
        const toDelete = allLogs.slice(keep);
        for (const file of toDelete) {
          try { fs.unlinkSync(path.join(runsDir, file)); } catch {}
        }
      }
    }
  } catch {}
}

/**
 * List and display run logs from atris/logs/runs/.
 * Options:
 *   --tail N    Show last N lines of each log (default: 5)
 *   --cat FILE  Print full contents of a specific log file
 *   --json      Output machine-readable JSON
 */
function listRunLogs(args = []) {
  const runsDir = getRunLogDir();
  const jsonMode = args.includes('--json');

  // --cat FILE: print full contents
  const catIdx = args.indexOf('--cat');
  if (catIdx !== -1 && args[catIdx + 1]) {
    const file = args[catIdx + 1];
    const filePath = path.isAbsolute(file) ? file : path.join(runsDir, file);
    if (!fs.existsSync(filePath)) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, error: `Run log not found: ${file}` }));
      } else {
        console.error(`Run log not found: ${file}`);
      }
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, file, content }));
    } else {
      console.log(content);
    }
    return;
  }

  // --tail N: show last N lines of each log
  let tailLines = 5;
  const tailIdx = args.indexOf('--tail');
  if (tailIdx !== -1 && args[tailIdx + 1]) {
    tailLines = parseInt(args[tailIdx + 1]) || 5;
  }

  // List all run logs
  const files = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
    : [];

  if (files.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, logs: [], count: 0 }));
    } else {
      console.log('No run logs found. Run "atris run" to generate them.');
    }
    return;
  }

  // Build log entries
  const logs = files.map(file => {
    const filePath = path.join(runsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const cycleMatch = content.match(/# Run Log — Cycle (\d+)/);
    const phases = [...content.matchAll(/## (\w+)/g)].map(m => m[1]);
    return {
      file,
      cycle: cycleMatch ? parseInt(cycleMatch[1]) : null,
      phases,
      tail: tailLines > 0 ? lines.slice(-tailLines).filter(l => l.trim()) : undefined,
    };
  });

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, logs, count: logs.length }));
    return;
  }

  console.log('');
  console.log(`Run logs (${files.length} file${files.length === 1 ? '' : 's'}):`);
  console.log('');

  for (const entry of logs) {
    console.log(`  ${entry.file}`);
    console.log(`    Cycle: ${entry.cycle ?? '?'}, Phases: ${entry.phases.join(', ')}`);

    if (entry.tail && entry.tail.length > 0) {
      console.log(`    ...last ${tailLines} lines:`);
      for (const line of entry.tail) {
        console.log(`    ${line}`);
      }
    }
    console.log('');
  }
}

/**
 * Prune old run logs, keeping only the most recent N files.
 * Options:
 *   --keep N    Number of recent logs to keep (default: 50)
 *   --dry-run   Show what would be deleted without deleting
 */
function pruneRunLogs(args = []) {
  const runsDir = getRunLogDir();
  const dryRun = args.includes('--dry-run');

  let keep = 50;
  const keepIdx = args.indexOf('--keep');
  if (keepIdx !== -1 && args[keepIdx + 1]) {
    keep = parseInt(args[keepIdx + 1]) || 50;
  }

  const files = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
    : [];

  if (files.length <= keep) {
    console.log(`No pruning needed. ${files.length} run log${files.length === 1 ? '' : 's'} exist, keeping ${keep}.`);
    return;
  }

  const toDelete = files.slice(keep);
  console.log(`Pruning ${toDelete.length} old run log${toDelete.length === 1 ? '' : 's'} (keeping ${keep} of ${files.length}):`);

  for (const file of toDelete) {
    const filePath = path.join(runsDir, file);
    if (dryRun) {
      console.log(`  [DRY RUN] Would delete: ${file}`);
    } else {
      try {
        fs.unlinkSync(filePath);
        console.log(`  Deleted: ${file}`);
      } catch (err) {
        console.log(`  Failed: ${file} (${err.message})`);
      }
    }
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] No files were actually deleted.`);
  } else {
    console.log(`\nPruned ${toDelete.length} run log${toDelete.length === 1 ? '' : 's'}.`);
  }
}

module.exports = { runAtris, getRunLogDir, getRunLogPath, writePhaseToRunLog, listRunLogs, pruneRunLogs };
