/**
 * Atris Run — Auto-chain plan → do → review cycles
 *
 * The ignition switch. Reads inbox/backlog, loops autonomously
 * until work is done or max cycles reached.
 *
 * Uses claude -p (subprocess) — no auth required.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { parseTodo } = require('../lib/todo');
const { cleanAtris } = require('./clean');

const pkg = require('../package.json');

const DEFAULT_MAX_CYCLES = 5;
const PHASE_TIMEOUT = 600000; // 10 min per phase

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
 * Execute a phase using claude -p
 */
function executePhase(phase, context, options = {}) {
  const { verbose = false, timeout = PHASE_TIMEOUT } = options;

  const prompt = buildRunPrompt(phase, context);
  const tmpFile = path.join(process.cwd(), '.run-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"`;
    // Strip CLAUDECODE env var to allow spawning from within a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const output = execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout,
      stdio: verbose ? 'inherit' : 'pipe',
      maxBuffer: 10 * 1024 * 1024,
      env
    });

    try { fs.unlinkSync(tmpFile); } catch {}
    return output || '';
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err.killed) {
      throw new Error(`${phase} timed out after ${timeout / 1000}s`);
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
    const inboxMatch = content.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      const items = inboxMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
      if (items.length > 0) return true;
    }
  }

  return false;
}

/**
 * Log completion to journal
 */
function logRunCompletion(cycles, startTime) {
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  let content = fs.readFileSync(logFile, 'utf8');
  const duration = Math.round((Date.now() - startTime) / 1000);
  const entry = `\n### Atris Run — ${new Date().toLocaleTimeString()}\n- Cycles: ${cycles}\n- Duration: ${duration}s\n`;

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
    noPush = false
  } = options;

  const cycles = once ? 1 : maxCycles;
  const atrisDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(atrisDir)) {
    console.error('atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Check claude CLI is available
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    console.error('claude CLI not found. Install Claude Code first.');
    process.exit(1);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Atris Run v${pkg.version} — autonomous plan → do → review       │`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Max cycles: ${cycles}`);
  console.log(`Verbose: ${verbose}`);
  console.log('');

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

  for (let cycle = 1; cycle <= cycles; cycle++) {
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`CYCLE ${cycle}/${cycles}`);
    console.log(`${'━'.repeat(60)}`);

    // Check if there's work
    if (!hasWork(atrisDir)) {
      console.log('\nInbox empty. Backlog empty. Nothing to do.');
      break;
    }

    try {
      // PLAN
      console.log('\n[1/3] PLAN — reading inbox, creating tasks...');
      const planOutput = executePhase('plan', context, { verbose });

      if (planOutput.includes('[NOTHING_TO_DO]')) {
        console.log('Nothing to do. Stopping.');
        break;
      }
      console.log('✓ Plan complete');

      // Check if plan created tasks
      if (!hasWork(atrisDir)) {
        console.log('No tasks created. Stopping.');
        break;
      }

      // DO
      console.log('\n[2/3] DO — building task...');
      executePhase('do', context, { verbose });
      console.log('✓ Build complete');

      // REVIEW
      console.log('\n[3/3] REVIEW — validating...');
      const reviewOutput = executePhase('review', context, { verbose });

      if (reviewOutput.includes('[REVIEW_FAILED]')) {
        console.log('⚠ Review found issues. Stopping for manual check.');
        break;
      }
      console.log('✓ Review complete');

      // Self-heal MAP.md refs after each cycle
      console.log('\n[+] CLEAN — healing MAP.md refs...');
      try {
        cleanAtris({ dryRun: false });
      } catch (cleanErr) {
        console.log(`⚠ Clean failed: ${cleanErr.message}`);
      }

      // Auto-push if not disabled
      if (!noPush) {
        console.log('\n[+] PUSH — pushing to remote...');
        try {
          execSync('git push', { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
          console.log('✓ Pushed to remote');
        } catch (pushErr) {
          console.log(`⚠ Push failed: ${pushErr.message.split('\n')[0]}`);
        }
      }

      console.log(`\n✓ Cycle ${cycle} done`);

    } catch (err) {
      console.error(`\n✗ Cycle ${cycle} failed: ${err.message}`);
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // Log to journal
  logRunCompletion(cycles, startTime);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Run complete. ${elapsed}s elapsed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

module.exports = { runAtris };
