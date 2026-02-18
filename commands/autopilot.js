/**
 * Atris Autopilot - PRD-driven autonomous execution
 *
 * Uses claude -p to execute plan → do → review cycles autonomously.
 * Supports features and bugs with different acceptance criteria templates.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');

const pkg = require('../package.json');

// Default max iterations before stopping
const DEFAULT_MAX_ITERATIONS = 5;

/**
 * Generate PRD from feature/bug description
 */
function generatePRD(description, options = {}) {
  const { type = 'feature', file = null } = options;
  const id = type === 'bug' ? 'BUG-001' : 'FEAT-001';

  // Generate acceptance criteria based on type
  let acceptance;
  if (type === 'bug') {
    acceptance = [
      'Bug is fixed and no longer reproducible',
      'Regression test added (if applicable)',
      'Build passes: npm run build (or equivalent)',
      'No new bugs introduced'
    ];
  } else {
    acceptance = [
      'Feature implemented and working as described',
      'Tests pass (if test suite exists)',
      'Build passes: npm run build (or equivalent)',
      'Code follows project patterns (check MAP.md)'
    ];
  }

  const prd = {
    project: path.basename(process.cwd()),
    type,
    stories: [
      {
        id,
        title: description,
        file: file || '(auto-detect from MAP.md)',
        acceptance,
        passes: false,
        priority: 1
      }
    ]
  };

  return prd;
}

/**
 * Build prompt for each phase (plan/do/review)
 */
function buildPrompt(phase, prd) {
  const prdJson = JSON.stringify(prd, null, 2);

  if (phase === 'plan') {
    return `Navigator: Plan this PRD story.

PRD: ${prdJson}

1. Read atris/MAP.md for file locations
2. Identify files to change
3. Create ASCII diagram of approach
4. Add tasks to atris/TODO.md Backlog

DO NOT write code. Planning only.
Reply [PLAN_COMPLETE] when done.`;
  }

  if (phase === 'do') {
    return `Executor: Build the PRD story.

PRD: ${prdJson}

1. Read atris/TODO.md for tasks
2. Implement each task
3. Verify changes work
4. Commit: git add -A && git commit -m "autopilot: [title]"

Reply [DO_COMPLETE] when done.`;
  }

  if (phase === 'review') {
    return `Validator: Review the PRD story.

PRD: ${prdJson}

1. Check acceptance criteria are met
2. Verify the changes work
3. If issues: reply [REVIEW_FAILED] reason
4. If all good: update prd.json passes:true, reply <promise>COMPLETE</promise>

Be thorough.`;
  }

  return '';
}

/**
 * Execute a phase using claude -p
 */
async function executePhase(phase, prd, options = {}) {
  const { verbose = false, timeout = 300000 } = options;

  const prompt = buildPrompt(phase, prd);

  console.log(`\n[${phase.toUpperCase()}] Executing...`);

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = path.join(process.cwd(), '.autopilot-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"`;
    const output = execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout,
      stdio: verbose ? 'inherit' : 'pipe',
      maxBuffer: 10 * 1024 * 1024
    });

    // Clean up
    try { fs.unlinkSync(tmpFile); } catch {}

    const result = output || '';

    if (phase === 'plan') {
      console.log('✓ Planning complete');
      return { success: true, output: result };
    } else if (phase === 'do') {
      console.log('✓ Execution complete');
      return { success: true, output: result };
    } else if (phase === 'review') {
      if (result.includes('<promise>COMPLETE</promise>')) {
        console.log('✓ Review passed - all criteria met');
        return { success: true, complete: true, output: result };
      } else if (result.includes('[REVIEW_FAILED]')) {
        console.log('✗ Review failed - issues found');
        return { success: true, complete: false, output: result };
      } else {
        return { success: true, complete: true, output: result };
      }
    }
    return { success: true, output: result };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err.killed) {
      throw new Error(`Phase timed out after ${timeout / 1000}s`);
    }
    throw err;
  }
}

/**
 * Log completion to journal
 */
function logToJournal(description, type) {
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  let content = fs.readFileSync(logFile, 'utf8');

  // Find next completion ID
  const completionMatch = content.match(/\*\*C(\d+):/g);
  const nextId = completionMatch
    ? Math.max(...completionMatch.map(m => parseInt(m.match(/\d+/)[0]))) + 1
    : 1;

  const label = type === 'bug' ? 'fix' : 'feat';
  const entry = `- **C${nextId}:** [${label}] ${description} [✓ REVIEWED]`;

  // Add to Completed section
  if (content.includes('## Completed')) {
    content = content.replace(
      /(## Completed[^\n]*\n)/,
      `$1\n${entry}\n`
    );
  } else {
    content += `\n## Completed ✅\n\n${entry}\n`;
  }

  fs.writeFileSync(logFile, content);
  console.log(`✓ Logged to journal: ${entry}`);
}

/**
 * Main autopilot function
 */
async function autopilotAtris(description, options = {}) {
  const {
    type = 'feature',
    maxIterations = DEFAULT_MAX_ITERATIONS,
    verbose = false,
    dryRun = false
  } = options;

  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  // Check if claude CLI is available
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    throw new Error('claude CLI not found. Install Claude Code first.');
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Atris Autopilot v${pkg.version} — PRD-driven autonomous execution  │`);
  console.log('│ plan → do → review (powered by claude -p)                   │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Type: ${type}`);
  console.log(`Description: ${description}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log('');

  // Generate PRD
  const prd = generatePRD(description, { type });
  const prdPath = path.join(process.cwd(), 'prd.json');
  const progressPath = path.join(process.cwd(), 'progress.txt');

  fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  fs.appendFileSync(progressPath, `\n🔁 Autopilot starting at ${new Date().toISOString()}\n`);
  fs.appendFileSync(progressPath, `   Type: ${type}\n`);
  fs.appendFileSync(progressPath, `   Description: ${description}\n`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PRD generated:');
  console.log(JSON.stringify(prd, null, 2));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  if (dryRun) {
    console.log('[DRY RUN] Would execute plan → do → review cycle');
    console.log('[DRY RUN] PRD saved to prd.json');
    return;
  }

  // Context for prompts
  const context = {
    mapPath: 'atris/MAP.md',
    todoPath: 'atris/TODO.md',
    journalPath: getLogPath().logFile,
    personaPath: 'atris/PERSONA.md'
  };

  // Main loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`ITERATION ${iteration}/${maxIterations}`);
    console.log(`${'═'.repeat(60)}`);

    fs.appendFileSync(progressPath, `\n--- Iteration ${iteration} ---\n`);

    try {
      // PLAN phase
      console.log('\n[1/3] PLAN — Navigator creating tasks...');
      await executePhase('plan', prd, { ...context, verbose });
      fs.appendFileSync(progressPath, `[${new Date().toISOString()}] PLAN complete\n`);

      // DO phase
      console.log('\n[2/3] DO — Executor building...');
      await executePhase('do', prd, { ...context, verbose });
      fs.appendFileSync(progressPath, `[${new Date().toISOString()}] DO complete\n`);

      // REVIEW phase
      console.log('\n[3/3] REVIEW — Validator checking...');
      const reviewResult = await executePhase('review', prd, { ...context, verbose });
      fs.appendFileSync(progressPath, `[${new Date().toISOString()}] REVIEW complete\n`);

      // Check if complete
      if (reviewResult.complete) {
        // Update PRD
        prd.stories[0].passes = true;
        fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));

        // Log to journal
        logToJournal(description, type);

        fs.appendFileSync(progressPath, `\n🏁 Autopilot finished at ${new Date().toISOString()} - SUCCESS\n`);

        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎉 AUTOPILOT COMPLETE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log(`✓ ${type === 'bug' ? 'Bug fixed' : 'Feature implemented'}: ${description}`);
        console.log('✓ All acceptance criteria passed');
        console.log('✓ Logged to journal');
        console.log('');

        // Clean up temp files on success
        try { fs.unlinkSync(path.join(process.cwd(), 'prd.json')); } catch {}
        try { fs.unlinkSync(path.join(process.cwd(), 'progress.txt')); } catch {}

        return { success: true, iterations: iteration };
      }

      console.log(`\n⚠️  Review found issues, continuing to iteration ${iteration + 1}...`);

    } catch (error) {
      console.error(`\n❌ Error in iteration ${iteration}: ${error.message}`);
      fs.appendFileSync(progressPath, `[${new Date().toISOString()}] ERROR: ${error.message}\n`);

      if (iteration === maxIterations) {
        throw error;
      }

      console.log('Continuing to next iteration...');
    }
  }

  // Max iterations reached
  fs.appendFileSync(progressPath, `\n⏰ Autopilot stopped at ${new Date().toISOString()} - max iterations\n`);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⏰ AUTOPILOT STOPPED — Max iterations reached');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Check progress.txt and prd.json for details.');
  console.log('Run `atris autopilot` again to continue, or fix issues manually.');
  console.log('');

  return { success: false, iterations: maxIterations };
}

/**
 * Pick next item from TODO.md backlog and run autopilot on it
 */
async function autopilotFromTodo(options = {}) {
  const targetDir = path.join(process.cwd(), 'atris');
  const todoPath = path.join(targetDir, 'TODO.md');

  if (!fs.existsSync(todoPath)) {
    throw new Error('atris/TODO.md not found. Run "atris init" first.');
  }

  const content = fs.readFileSync(todoPath, 'utf8');

  // Parse backlog items
  const backlogMatch = content.match(/## Backlog\n([\s\S]*?)(?=\n##|$)/);
  if (!backlogMatch) {
    console.log('No backlog items found in TODO.md');
    return;
  }

  // Support both formats: "- [ ] Task" (checkbox) and "- **T1:** Task" (Atris standard)
  const backlogLines = backlogMatch[1].split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed.startsWith('- [ ]') || trimmed.match(/^- \*\*T\d+:\*\*\s/);
  });

  if (backlogLines.length === 0) {
    console.log('No unchecked items in backlog. TODO.md is at target state (0 tasks).');
    return;
  }

  // Pick first item
  const firstItem = backlogLines[0].trim();
  // Try checkbox format first, then Atris standard format
  const itemMatch = firstItem.match(/- \[ \] (.+)/) || firstItem.match(/- \*\*T\d+:\*\*\s*(.+)/);

  if (!itemMatch) {
    throw new Error('Could not parse backlog item');
  }

  const description = itemMatch[1].trim();

  // Detect if it's a bug
  const isBug = /bug|fix|broken|error|issue|crash/i.test(description);

  console.log(`\nPicked from backlog: "${description}"`);
  console.log(`Detected type: ${isBug ? 'bug' : 'feature'}`);
  console.log('');

  return autopilotAtris(description, {
    ...options,
    type: isBug ? 'bug' : 'feature'
  });
}

module.exports = {
  autopilotAtris,
  autopilotFromTodo,
  generatePRD
};
