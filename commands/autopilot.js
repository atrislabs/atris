/**
 * Atris Autopilot — Suggest, justify, execute. One task at a time.
 *
 * Scans the workspace for signals (stale pages, broken refs, abandoned tasks,
 * inbox items, backlog) and suggests the most important thing to do next.
 * Human approves, skips, or cancels. In --auto mode, runs without asking.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { parseTodo } = require('../lib/todo');
const { findStalePages, findStaleTasks, healBrokenMapRefs } = require('./clean');
const { readScorecards, writeScorecard, detectEndgameCompletion } = require('../lib/scorecard');

const pkg = require('../package.json');

const PHASE_TIMEOUT = 600000; // 10 min per phase

/**
 * Scan workspace for the next thing worth doing.
 * Returns { task, why, kind } or null.
 */
async function suggestNextTask(cwd, skipped = new Set()) {
  const atrisDir = path.join(cwd, 'atris');
  const suggestions = [];

  // --- Endgame tasks (highest priority — pursue the current horizon to completion) ---
  const todoPath = path.join(atrisDir, 'TODO.md');
  const todo = parseTodo(todoPath);

  for (const t of todo.backlog) {
    if (t.tag === 'endgame' && !skipped.has(t.title)) {
      suggestions.push({
        task: t.title,
        why: `Next step in the current endgame. Endgame steps are pursued to completion before any reactive signal.`,
        kind: 'endgame',
        priority: 0
      });
      break;
    }
  }

  // --- Resume interrupted work ---
  if (todo.inProgress.length > 0) {
    const t = todo.inProgress[0];
    if (!skipped.has(t.title)) {
      suggestions.push({
        task: t.title,
        why: `This was already started${t.claimed ? ` by ${t.claimed}` : ''} but never finished.`,
        kind: 'resume',
        priority: 1
      });
    }
  }

  // --- Stale wiki pages (knowledge rot) ---
  const stalePages = findStalePages(cwd, atrisDir);
  for (const sp of stalePages.slice(0, 2)) {
    const pageName = path.relative(cwd, sp.page);
    const key = `recompile:${pageName}`;
    if (skipped.has(key)) continue;
    suggestions.push({
      task: `Re-read sources and update ${pageName}`,
      why: `"${sp.staleSource}" changed on ${sp.sourceDate} but the page was last compiled ${sp.compiledDate}. The content may be wrong.`,
      kind: 'staleness',
      priority: 2
    });
    break;
  }

  // --- Stale tasks (claimed but abandoned >3 days) ---
  const staleTasks = findStaleTasks(atrisDir);
  for (const st of staleTasks.slice(0, 1)) {
    const key = `stale:${st.title}`;
    if (skipped.has(key)) continue;
    suggestions.push({
      task: `Finish or remove stale task: ${st.title}`,
      why: `Claimed ${st.daysSinceClaim} days ago and never completed. Either finish it or delete it — stale tasks add noise.`,
      kind: 'cleanup',
      priority: 3
    });
  }

  // --- Broken MAP.md references ---
  const { unhealable } = healBrokenMapRefs(cwd, atrisDir, true); // dry-run
  if (unhealable.length > 0 && !skipped.has('fix-map-refs')) {
    const sample = unhealable.slice(0, 3).map(r => `${r.file}:${r.line}`).join(', ');
    suggestions.push({
      task: `Fix ${unhealable.length} broken reference${unhealable.length > 1 ? 's' : ''} in MAP.md`,
      why: `These file:line references point to code that moved or was deleted: ${sample}. MAP.md is the navigation — it needs to be accurate.`,
      kind: 'docs',
      priority: 4
    });
  }

  // --- Backlog tasks ---
  for (const t of todo.backlog.slice(0, 1)) {
    if (skipped.has(t.title)) continue;
    const remaining = todo.backlog.length;
    suggestions.push({
      task: t.title,
      why: `Next in the backlog${t.tag ? ` (${t.tag})` : ''}. ${remaining} task${remaining > 1 ? 's' : ''} waiting.`,
      kind: 'backlog',
      priority: 5
    });
  }

  // --- Unprocessed inbox items ---
  const { logFile } = getLogPath();
  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, 'utf8');
    const inboxMatch = content.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      const items = inboxMatch[1].trim().split('\n').filter(l => {
        const t = l.trim();
        return t.startsWith('- ') && t.length > 2;
      });
      if (items.length > 0) {
        const firstItem = items[0].replace(/^-\s*\*\*I\d+:\*\*\s*/, '').replace(/^-\s*/, '').trim();
        const inboxTaskTitle = `Break down inbox idea: "${firstItem}"`;
        if (!skipped.has(inboxTaskTitle)) {
          suggestions.push({
            task: inboxTaskTitle,
            why: `${items.length} raw idea${items.length > 1 ? 's' : ''} sitting in the inbox. Needs to become concrete tasks before anything can happen.`,
            kind: 'inbox',
            priority: 6
          });
        }
      }
    }
  }

  // --- Incomplete features (idea.md exists but no build.md or validate.md) ---
  const featuresDir = path.join(atrisDir, 'features');
  if (fs.existsSync(featuresDir) && !skipped.has('incomplete-features')) {
    try {
      const featureDirs = fs.readdirSync(featuresDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'));
      for (const dir of featureDirs) {
        const fp = path.join(featuresDir, dir.name);
        const hasIdea = fs.existsSync(path.join(fp, 'idea.md'));
        const hasBuild = fs.existsSync(path.join(fp, 'build.md'));
        const hasValidate = fs.existsSync(path.join(fp, 'validate.md'));
        if (hasIdea && (!hasBuild || !hasValidate)) {
          const missing = [];
          if (!hasBuild) missing.push('build.md');
          if (!hasValidate) missing.push('validate.md');
          const key = `feature:${dir.name}`;
          if (!skipped.has(key)) {
            suggestions.push({
              task: `Complete feature spec for "${dir.name}" — missing ${missing.join(' and ')}`,
              why: `idea.md exists but the feature is incomplete. Navigator needs to create ${missing.join(' and ')} so executor can build it.`,
              kind: 'feature',
              priority: 6.5
            });
            break;
          }
        }
      }
    } catch {}
  }

  // --- Periodic review (suggest when nothing else is urgent) ---
  if (!skipped.has('review')) {
    const mapPath = path.join(atrisDir, 'MAP.md');
    if (fs.existsSync(mapPath)) {
      const mapStat = fs.statSync(mapPath);
      const daysSinceMapUpdate = (Date.now() - mapStat.mtime.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceMapUpdate > 7) {
        suggestions.push({
          task: 'Review and refresh MAP.md — it hasn\'t been updated in over a week',
          why: `Last modified ${Math.floor(daysSinceMapUpdate)} days ago. Code may have drifted from the map. A quick review keeps navigation accurate.`,
          kind: 'review',
          priority: 7
        });
      }
    }
  }

  // --- Lessons harvest (suggest if recent completions but no recent lessons) ---
  if (!skipped.has('lessons')) {
    const lessonsPath = path.join(atrisDir, 'lessons.md');
    const { logFile } = getLogPath();
    if (fs.existsSync(logFile)) {
      const journalContent = fs.readFileSync(logFile, 'utf8');
      const completions = (journalContent.match(/\*\*C\d+:/g) || []).length;
      if (completions >= 3) {
        const lessonsFresh = fs.existsSync(lessonsPath) &&
          (Date.now() - fs.statSync(lessonsPath).mtime.getTime()) < 3 * 24 * 60 * 60 * 1000;
        if (!lessonsFresh) {
          suggestions.push({
            task: 'Harvest lessons from recent work into lessons.md',
            why: `${completions} tasks completed today but lessons.md hasn't been updated. Patterns worth remembering should be captured while they're fresh.`,
            kind: 'lessons',
            priority: 7.5
          });
        }
      }
    }
  }

  if (suggestions.length === 0) {
    try {
      const candidates = await proposeCandidateHorizons(cwd);
      const top = scoreEndgameCandidates(cwd, candidates);
      return {
        task: top.title,
        why: top.rationale,
        kind: 'imagined',
        priority: 99
      };
    } catch {
      return null;
    }
  }

  suggestions.sort((a, b) => a.priority - b.priority);
  return suggestions[0];
}

/**
 * Prompt for approval. Returns 'approve', 'skip', or 'quit'.
 */
function askApproval() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  enter = go, s = skip, q = stop → ', (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (a === 'q' || a === 'quit' || a === 'exit') resolve('quit');
      else if (a === 's' || a === 'skip') resolve('skip');
      else resolve('approve');
    });
  });
}

/**
 * Run a phase via claude -p subprocess.
 */
function executePhaseDetailed(phase, context, options = {}) {
  const { verbose = false, timeout = PHASE_TIMEOUT } = options;

  const prompt = buildPrompt(phase, context, options);
  const tmpFile = path.join(process.cwd(), '.autopilot-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"`;
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
    return { prompt, output: output || '' };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    if (err.killed) throw new Error(`${phase} timed out after ${timeout / 1000}s`);
    if (err.stdout) {
      return { prompt, output: err.stdout };
    }
    throw err;
  }
}

function executePhase(phase, context, options = {}) {
  return executePhaseDetailed(phase, context, options).output;
}

/**
 * Build context-aware file list for prompts.
 */
function getContextFiles(phase, options = {}) {
  const cwd = process.cwd();
  const { extraReadFiles = [] } = options;
  const agentSpec = {
    plan: 'atris/team/navigator/MEMBER.md',
    do: 'atris/team/executor/MEMBER.md',
    review: 'atris/team/validator/MEMBER.md'
  }[phase];

  const files = [
    agentSpec && fs.existsSync(path.join(cwd, agentSpec)) ? agentSpec : null,
    'atris/PERSONA.md',
    'atris/MAP.md',
    'atris/TODO.md',
    fs.existsSync(path.join(cwd, 'atris/lessons.md')) ? 'atris/lessons.md' : null,
    (() => { const { logFile } = getLogPath(); return fs.existsSync(logFile) ? path.relative(cwd, logFile) : null; })(),
    ...extraReadFiles.filter((file) => fs.existsSync(path.join(cwd, file)) || fs.existsSync(path.resolve(cwd, file))),
  ];

  return [...new Set(files.filter(Boolean))].map((f) => `- ${f}`).join('\n');
}

/**
 * Build the right prompt for each phase, adapting to the kind of work.
 */
function buildPrompt(phase, context, options = {}) {
  const { task, kind } = context;
  const {
    benchmarkStrategy = '',
    contextNote = '',
    runnerName = '',
  } = options;
  const readFiles = getContextFiles(phase, options);
  const benchmarkProtocol = benchmarkStrategy === 'stack'
    ? 'coordinated stack run'
    : (benchmarkStrategy === 'single' ? 'pinned single-model baseline run' : '');
  const benchmarkContextLines = [
    runnerName ? `Runner profile: ${runnerName}` : '',
    benchmarkProtocol ? `Protocol: ${benchmarkProtocol}` : '',
    contextNote,
  ].filter(Boolean);
  const noteBlock = benchmarkContextLines.length > 0
    ? `\nBenchmark context:\n${benchmarkContextLines.join('\n')}\n`
    : '';

  if (phase === 'plan') {
    const baseRules = `You are the navigator. Read your MEMBER.md spec first if available.

Rules:
- You can read files and plan. You CANNOT write code or edit source files.
- Check MAP.md before grepping. If MAP has the answer, use it.
- Tasks must be small: one job, 1-2 files, clear exit condition.
- Format: - **T#:** Description [execute] or [explore]
- Read lessons.md to avoid repeating past mistakes.

Read these files first:
${readFiles}`;

    if (kind === 'benchmark') {
      return `${baseRules}${noteBlock}

Pinned benchmark task:
${task}

Rules for this run:
- Treat this as a ${benchmarkProtocol || 'pinned benchmark run'}.
- ${benchmarkStrategy === 'stack'
    ? 'Split the work into explicit repo lanes only when the task truly separates.'
    : 'Stay single-threaded and solve it directly without delegation theater.'}
- Do NOT write to TODO.md, journal, or feature specs.
- Do NOT invent follow-up tasks or widen scope.
- Read the benchmark contract and pack files in the read list before deciding.
- Produce the smallest honest plan for this exact task, then reply: done.`;
    }

    if (kind === 'inbox') {
      return `${baseRules}

Convert this inbox idea into concrete tasks:
${task}

Break it down. Add tasks to atris/TODO.md under ## Backlog.
If it's substantial (multi-file, needs design), create atris/features/<slug>/idea.md first.

When done, reply: done.`;
    }

    if (kind === 'staleness' || kind === 'docs' || kind === 'review') {
      return `${baseRules}

Maintenance task: ${task}

Figure out what needs to change and why. Create focused tasks in atris/TODO.md.
For stale pages, read both the page and its sources to understand the drift.

When done, reply: done.`;
    }

    if (kind === 'cleanup') {
      return `${baseRules}

Stale work: ${task}

Check if this is actually done (grep for the implementation). If done, delete the task.
If not done, either re-scope it into something actionable or remove it.

When done, reply: done.`;
    }

    if (kind === 'feature') {
      return `${baseRules}

Incomplete feature: ${task}

Read the existing idea.md in the feature directory.
Create the missing specs (build.md and/or validate.md) following the templates in atris/features/.
build.md should have: files_touched, steps with file:line refs, testing strategy.
validate.md should have: verification checklist, checks to run.

When done, reply: done.`;
    }

    if (kind === 'lessons') {
      return `${baseRules}

Task: ${task}

Read today's journal completions and the git log from the past few days.
Extract patterns worth remembering — things that surprised you, approaches that worked,
mistakes that were caught. Append to atris/lessons.md. One line per lesson. Be specific.

When done, reply: done.`;
    }

    return `${baseRules}

Task: ${task}

Understand the scope — what files need to change? Break into sub-tasks if needed.
Add tasks to atris/TODO.md under ## Backlog.

When done, reply: done.`;
  }

  if (phase === 'do') {
    if (kind === 'benchmark') {
      return `You are the executor. Read your MEMBER.md spec first if available.

Rules:
- This is a ${benchmarkProtocol || 'pinned benchmark run'}. Execute the task directly.
- You CAN read and write code. Do NOT modify TODO.md or journal state.
- Stay inside the exact task brief. No side quests.
- Check MAP.md before grepping.
- Do NOT create a git commit automatically. The benchmark runner records the result.

Read these files first:
${readFiles}${noteBlock}

Task: ${task}

1. Read the benchmark contract and pack files in the read list.
2. Make the smallest changes that satisfy the task brief.
3. Verify locally if you can.
4. Update MAP.md only if file locations truly shifted because of your change.
5. If updating wiki pages, set last_compiled in frontmatter to today's date.

When done, reply: done.`;
    }

    return `You are the executor. Read your MEMBER.md spec first if available.

Rules:
- You CAN read and write code. You CANNOT plan or create new tasks.
- Execute ONE step at a time. Verify each step before moving on.
- Check MAP.md for file locations before grepping.
- If you hit two errors on the same step, stop and flag for re-scope.
- Stay in scope. Don't touch files outside the task boundary.

Read these files first:
${readFiles}

Task: ${task}

1. Find the task in TODO.md, move to In Progress with: Claimed by: Executor at ${new Date().toISOString()}
2. Read MAP.md for exact file:line locations
3. Make the changes, verify they work
4. Update MAP.md if file locations shifted
5. If updating wiki pages, set last_compiled in frontmatter to today's date
6. Commit: git add <specific-files> && git commit -m "description"

When done, reply: done.`;
  }

  if (phase === 'review') {
    if (kind === 'benchmark') {
      return `You are the validator. Read your MEMBER.md spec first if available.

Rules:
- This is a ${benchmarkProtocol || 'pinned benchmark'} review. Check quality without widening scope.
- You CAN fix issues but CANNOT add new features.
- Run targeted verification if you can and name the commands explicitly in your response.
- Do NOT delete tasks from TODO.md or append completions to the journal. The outer benchmark runner records the receipt.

Read these files first:
${readFiles}${noteBlock}

Task: ${task}

1. Does it work for the exact task brief?
2. Name any tests or checks you ran and whether they passed.
3. Call out bugs, edge cases, or drift.
4. Reply \`done\` if this run passes the review bar.
5. Reply \`failed — [reason]\` if it does not.`;
    }

    return `You are the validator. Read your MEMBER.md spec first if available.

Rules:
- You check quality. You CAN fix issues but CANNOT add new features.
- Ultrathink: spec match, scope check, edge cases, integration.
- Run tests if they exist. Check MAP.md is still accurate.
- If you halted, were surprised, or learned a non-obvious lesson, append ONE line to atris/lessons.md in this exact format:
  - **[YYYY-MM-DD] short-slug** — pass|fail — One sentence on what surprised you or what to remember.
  Skip if the tick taught nothing non-obvious. Lessons compound — future /endgame runs read this file before picking horizons.

Read these files first:
${readFiles}

Task: ${task}

1. Does it actually work? Test if you can.
2. Does it match existing patterns? Check MAP.md.
3. Any bugs, edge cases, or security issues?
4. Check for stale wiki pages (source changed since last_compiled).
5. When satisfied:
   - Delete the task from TODO.md (target state: 0)
   - Add to Completed in today's journal: - **C#:** Description [reviewed]
   - Append any lessons to lessons.md
6. If something is wrong, fix it before signing off.

When done, reply: done.
If broken beyond quick fix, reply: failed — [reason].`;
  }

  return '';
}

/**
 * Write a lesson to atris/lessons.md
 * Appends a line in format: - **[YYYY-MM-DD] slug** — pass/fail — explanation
 */
function writeLesson(cwd, slug, status, explanation) {
  const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const lessonLine = `- **[${today}] ${slug}** — ${status} — ${explanation}`;

  if (!fs.existsSync(lessonsPath)) {
    fs.writeFileSync(lessonsPath, `# lessons.md — What We Learned\n\n> Append-only. One line per lesson.\n\n---\n\n${lessonLine}\n`);
    return;
  }

  let content = fs.readFileSync(lessonsPath, 'utf8');
  // Append after the --- separator
  if (content.includes('---\n')) {
    content = content.replace(/---\n/, `---\n\n${lessonLine}\n`);
  } else {
    content += `\n${lessonLine}\n`;
  }
  fs.writeFileSync(lessonsPath, content);
}

/**
 * Get the verify command for a task from TODO.md
 * Reads the In Progress section, finds the task by title, extracts verify field.
 * Defaults to 'npm test' if no verify field found.
 */
function getVerifyCommand(cwd, taskTitle) {
  const todoPath = path.join(cwd, 'atris', 'TODO.md');
  if (!fs.existsSync(todoPath)) return 'npm test';

  const todo = parseTodo(todoPath);
  const inProgressTask = todo.inProgress.find(t => t.title === taskTitle);

  if (!inProgressTask) return 'npm test';
  if (inProgressTask.verify) return inProgressTask.verify;
  return 'npm test';
}

function runTaskOnce(context, options = {}) {
  const { verbose = false, cwd = process.cwd() } = options;
  const phaseResults = {};
  const startedAt = Date.now();

  for (const phase of ['plan', 'do', 'review']) {
    const t0 = Date.now();
    const result = executePhaseDetailed(phase, context, options);
    phaseResults[phase] = {
      prompt: result.prompt,
      output: result.output || '',
      elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    };
  }

  const reviewOutput = phaseResults.review.output || '';

  // After review succeeds, run verify command if present
  let verifyPass = true;
  let verifyOutput = '';
  if (!reviewOutput.includes('failed')) {
    const verifyCmd = getVerifyCommand(cwd, context.task);
    if (verifyCmd) {
      let t0 = Date.now();
      try {
        execSync(verifyCmd, { cwd, stdio: 'pipe' });
        const verifyTime = Math.round((Date.now() - t0) / 1000);
        phaseResults.verify = {
          output: `Verify passed (${verifyTime}s)`,
          elapsedSeconds: verifyTime,
        };
      } catch (e) {
        verifyPass = false;
        const verifyTime = Math.round((Date.now() - t0) / 1000);
        phaseResults.verify = {
          output: `Verify failed: ${e.message}`,
          elapsedSeconds: verifyTime,
        };
        // RL: write lesson on verify failure so the loop learns
        try {
          const slug = (context.task || 'unknown').replace(/\s+/g, '-').toLowerCase().slice(0, 40);
          writeLesson(cwd, `verify-fail-${slug}`, 'fail', `Verify command \`${verifyCmd}\` failed: ${e.message.split('\n')[0]}`);
        } catch { /* lesson write must not crash the tick */ }
      }
    }
  }

  return {
    success: !reviewOutput.includes('failed') && verifyPass,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    phaseResults,
    reviewOutput,
    verifyPass,
  };
}

/**
 * Append a completion to today's journal.
 */
function logCompletion(description) {
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();

  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  let content = fs.readFileSync(logFile, 'utf8');

  const completionMatch = content.match(/\*\*C(\d+):/g);
  const nextId = completionMatch
    ? Math.max(...completionMatch.map(m => parseInt(m.match(/\d+/)[0]))) + 1
    : 1;

  const entry = `- **C${nextId}:** ${description} [reviewed]`;

  if (content.includes('## Completed')) {
    content = content.replace(/(## Completed[^\n]*\n)/, `$1\n${entry}\n`);
  } else {
    content += `\n## Completed\n\n${entry}\n`;
  }

  fs.writeFileSync(logFile, content);
}

/**
 * Compute per-tick reward score based on execution signals.
 * Rewards:
 *   - commit landed: +1
 *   - verify passed: +3 (any verify command, including npm test)
 *   - validator clean (review passed): +1
 *   - halt caught hallucination: -3
 */
function computeTickReward(execution, tickOutcome, verifyCmd) {
  let reward = 0;

  // Validator clean: review passed without 'failed'
  if (!execution.reviewOutput || !execution.reviewOutput.includes('failed')) {
    reward += 1;
  }

  // Verify passed: +3 (any verify command, including npm test — no double-counting)
  if (execution.verifyPass) {
    reward += 3;
  }

  // Commit landed: check do phase output for git commit patterns
  const doOutput = execution.phaseResults.do.output || '';
  if (doOutput.match(/\[.*\s\d+\sfile.*changed/i) || doOutput.includes('git commit') || doOutput.includes('committed')) {
    reward += 1;
  }

  // Halt caught hallucination: -3
  if (tickOutcome === 'halted') {
    reward -= 3;
  }

  return reward;
}

/**
 * Append a plain-language tick summary block to today's journal `## Notes`.
 * Fields:
 *   - time:     human clock string, e.g. "11:20 a.m."
 *   - outcome:  one-sentence description of what happened this tick
 *   - horizon:  current endgame slug (or "unset")
 *   - nextStep: what the next tick will do
 *   - idle:     when true, block must contain literal "0 tasks in 0s"
 *               so getIdleTickCount still works.
 *   - reward:   optional tick reward score (from computeTickReward)
 * Safe to call inside a try/catch — a write failure must never crash a tick.
 */
function appendTickSummary(cwd, { time, outcome, horizon, nextStep, idle, reward } = {}) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const journalPath = path.join(cwd, 'atris', 'logs', String(yyyy), `${yyyy}-${mm}-${dd}.md`);
  const dateFormatted = `${yyyy}-${mm}-${dd}`;

  if (!fs.existsSync(journalPath)) {
    const dir = path.dirname(journalPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    createLogFile(journalPath, dateFormatted);
  }

  const timeLabel = time || new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).toLowerCase();
  const outcomeLine = outcome || 'I ran an autopilot tick.';
  const horizonLine = horizon
    ? `We are still on the ${horizon} endgame.`
    : 'No endgame is set right now.';
  const nextLine = nextStep
    ? `Next tick will ${nextStep}.`
    : 'Next tick will look for new work.';
  const idleLine = idle ? 'This tick moved 0 tasks in 0s.' : null;

  const blockLines = [
    `- ${timeLabel}`,
    `  ${outcomeLine}`,
    `  ${horizonLine}`,
    `  ${nextLine}`,
  ];
  // Add reward score if present
  if (reward !== undefined && reward !== null) {
    blockLines.push(`  Reward: ${reward}`);
  }
  // Idle marker must be the last non-empty line so getIdleTickCount, which
  // scans bottom-up, counts this block when idle=true.
  if (idleLine) blockLines.push(`  ${idleLine}`);
  blockLines.push('');
  const block = blockLines.join('\n');

  let content = fs.readFileSync(journalPath, 'utf8');
  const notesMatch = content.match(/(##\s+Notes\s*\n)([\s\S]*?)(?=\n##\s|$)/);
  if (notesMatch) {
    const header = notesMatch[1];
    const body = notesMatch[2].replace(/\s*$/, '');
    const newSection = `${header}${body ? body + '\n\n' : ''}${block}\n`;
    content = content.replace(notesMatch[0], newSection);
  } else {
    const trimmed = content.replace(/\s*$/, '');
    content = `${trimmed}\n\n## Notes\n\n${block}\n`;
  }
  fs.writeFileSync(journalPath, content);
}

/**
 * Read the current endgame slug from atris/TODO.md. Returns 'unset' on miss.
 */
function readHorizonSlug(cwd) {
  try {
    const todoPath = path.join(cwd, 'atris', 'TODO.md');
    if (!fs.existsSync(todoPath)) return 'unset';
    const content = fs.readFileSync(todoPath, 'utf8');
    const match = content.match(/\*\*Slug:\*\*\s*(\S+)/);
    return match ? match[1].trim() : 'unset';
  } catch {
    return 'unset';
  }
}

/**
 * Main loop. Suggest → justify → approve → execute, one at a time.
 */
/**
 * Parse duration string like "1h", "30m", "90m", "2h" into milliseconds.
 */
function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(h|m|s)?$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 's') return val * 1000;
  return null;
}

function wrapText(text, width = 74) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];

  const words = normalized.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function compactWrappedText(text, width = 74, maxLines = 2) {
  const lines = wrapText(text, width);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const head = kept.slice(0, -1);
  let tail = kept[kept.length - 1].replace(/[ .,;:!?-]+$/, '');
  if (tail.length >= width) {
    tail = tail.slice(0, width - 1).replace(/[ .,;:!?-]+$/, '');
  }
  return [...head, `${tail}…`];
}

function printPlainBlock(text) {
  for (const line of String(text || '').split('\n')) {
    console.log(`  ${line}`);
  }
  console.log('');
}

function getTickStatus(cwd) {
  const atrisDir = path.join(cwd, 'atris');

  let identity = '(no identity set — see atris/PERSONA.md)';
  const personaPath = path.join(atrisDir, 'PERSONA.md');
  if (fs.existsSync(personaPath)) {
    const lines = fs.readFileSync(personaPath, 'utf8').split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('---') && !t.startsWith('*') && !t.startsWith('-') && !t.startsWith('|')) {
        identity = t;
        break;
      }
    }
  }

  let slug = '(no endgame active — feed inbox or /endgame)';
  let horizon = '';
  const todoPath = path.join(atrisDir, 'TODO.md');
  let remaining = 0;
  let completedEndgame = 0;
  if (fs.existsSync(todoPath)) {
    const todoContent = fs.readFileSync(todoPath, 'utf8');
    const endgameMatch = todoContent.match(/##\s+Endgame\s*\n([\s\S]*?)(?=\n##|$)/);
    if (endgameMatch) {
      const slugMatch = endgameMatch[1].match(/\*\*Slug:\*\*\s*(.+)/);
      const horizonMatch = endgameMatch[1].match(/\*\*Horizon:\*\*\s*(.+)/);
      if (slugMatch) slug = slugMatch[1].trim();
      if (horizonMatch) horizon = horizonMatch[1].trim();
    }
    const todo = parseTodo(todoPath);
    remaining = todo.backlog.filter(t => t.tag === 'endgame').length;
    completedEndgame = todo.completed.filter(t => /^[A-Z]\d+[a-z]?[:\s]/.test((t.title || '').trim())).length;
  }

  const total = remaining + completedEndgame;
  const done = completedEndgame;
  const time = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).toLowerCase();

  return { time, identity, slug, horizon, total, done, remaining };
}

function renderHumanTickIntro(status, options = {}) {
  const modeLabel = options.auto ? 'autonomous' : 'interactive';
  const horizonLines = status.horizon
    ? compactWrappedText(`Horizon: ${status.slug}. ${status.horizon}`, 74, 2)
    : compactWrappedText(`Horizon: ${status.slug}.`, 74, 2);
  const progressSentence = status.remaining === 0
    ? 'No tagged endgame steps are queued right now.'
    : status.total > 0
    ? `Progress is ${status.done} of ${status.total} endgame steps.`
    : 'No endgame steps are queued right now.';

  return [
    status.time,
    `I am starting an autopilot tick in ${modeLabel} mode. Limit: ${options.durationLabel || 'until clean'}.`,
    ...horizonLines,
    progressSentence,
    'Next I will scan the workspace and choose one task.'
  ].join('\n');
}

function renderHumanSuggestion(suggestion, step, maxIterations) {
  return [
    `I picked task ${step} of ${maxIterations}.`,
    ...compactWrappedText(`Task: ${suggestion.task}`, 74, 2),
    ...compactWrappedText(`Why now: ${suggestion.why}`, 74, 2),
    'Next: approve it, skip it, or stop the loop.'
  ].join('\n');
}

/**
 * Print the visual ASCII tick status block. Shows identity (forward / flow),
 * current endgame slug + horizon (backward / endgame), and progress through
 * endgame steps. Two halves of the same engine — flow and endgame — meeting
 * at the next tick. Called at the start of each autopilot run.
 */
function printTickStatus(cwd, options = {}) {
  const status = getTickStatus(cwd);
  if (!options.verbose) {
    printPlainBlock(renderHumanTickIntro(status, options));
    return;
  }

  const W = 64;        // total box width including borders
  const C = W - 4;     // content width per line

  const trim = (s, w) => {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + '…';
    return s;
  };
  const line = (content) => '  │ ' + content.padEnd(C) + ' │';

  const barWidth = 12;
  const filled = status.total > 0 ? Math.round((status.done / status.total) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const ratio = status.total > 0 ? `${status.done}/${status.total}` : '0/0';
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  console.log('');
  console.log('  ┌' + '─'.repeat(W - 2) + '┐');
  console.log(line(`tick · ${time}`));
  console.log(line(`identity:  ${trim(status.identity, C - 11)}`));
  console.log(line(`horizon:   ${trim(status.slug, C - 11)}`));
  if (status.horizon) {
    console.log(line(`           ${trim(status.horizon, C - 11)}`));
  }
  console.log(line(`progress:  ${bar}  ${ratio} endgame steps`));
  console.log('  └' + '─'.repeat(W - 2) + '┘');
}

/**
 * Count consecutive idle-tick markers at the bottom of today's journal `## Notes`.
 * Idle marker is the literal substring `0 tasks in 0s` (case-insensitive). Scans
 * the Notes section bottom-up; the first non-marker, non-blank line breaks the
 * streak. Returns 0 when the journal is missing or has no `## Notes` section.
 * Pure read-only — no side effects, no callers yet.
 */
function getIdleTickCount(cwd) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const journalPath = path.join(cwd, 'atris', 'logs', String(yyyy), `${yyyy}-${mm}-${dd}.md`);

  if (!fs.existsSync(journalPath)) return 0;

  const content = fs.readFileSync(journalPath, 'utf8');
  const notesMatch = content.match(/##\s+Notes\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!notesMatch) return 0;

  const marker = '0 tasks in 0s';
  const lines = notesMatch[1].split('\n');
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.toLowerCase().includes(marker)) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

/**
 * Read recent project signals for horizon proposals. Returns:
 *   - recentCommits: string[] from `git log --oneline -20` (empty on failure)
 *   - wikiHealth: string of `atris/wiki/STATUS.md` contents, or null if missing
 *   - recentLessons: string[] of last 10 non-empty lines from `atris/lessons.md`
 * Pure read-only — try/catch each source, safe defaults on failure. No callers yet.
 */
function getRecentSignals(cwd) {
  let recentCommits = [];
  try {
    const out = execSync('git log --oneline -20', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    recentCommits = out.split('\n').filter(l => l.trim().length > 0);
  } catch {
    recentCommits = [];
  }

  let wikiHealth = null;
  try {
    const wikiStatusPath = path.join(cwd, 'atris', 'wiki', 'STATUS.md');
    if (fs.existsSync(wikiStatusPath)) {
      wikiHealth = fs.readFileSync(wikiStatusPath, 'utf8');
    }
  } catch {
    wikiHealth = null;
  }

  let recentLessons = [];
  try {
    const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
    if (fs.existsSync(lessonsPath)) {
      const lines = fs.readFileSync(lessonsPath, 'utf8').split('\n').filter(l => l.trim().length > 0);
      recentLessons = lines.slice(-10);
    }
  } catch {
    recentLessons = [];
  }

  return { recentCommits, wikiHealth, recentLessons };
}

/**
 * Score endgame candidates by historical reward of similar horizon types.
 * Reads last 10 scorecards, infers type from slug prefix, calculates mean
 * reward per type, scores candidates by expected value, applies 80/20 exploit/explore.
 *
 * @param {string} cwd - Current working directory
 * @param {array} candidates - Array of { title, confidence, rationale }
 * @returns {object} - Single candidate: { title, confidence, rationale, scored: true, reason }
 */
function scoreEndgameCandidates(cwd, candidates) {
  const atrisDir = path.join(cwd, 'atris');
  if (!fs.existsSync(atrisDir)) {
    // No atris folder yet - can't score, return best by confidence
    const best = candidates.reduce((a, b) => (a.confidence > b.confidence ? a : b), candidates[0]);
    return { ...best, scored: false, reason: 'no atris folder' };
  }

  try {
    const scorecards = readScorecards(atrisDir).slice(-10); // Last 10
    if (scorecards.length === 0) {
      // No scorecards yet - return best by confidence
      const best = candidates.reduce((a, b) => (a.confidence > b.confidence ? a : b), candidates[0]);
      return { ...best, scored: false, reason: 'no scorecards' };
    }

    // Infer type from slug/title by taking prefix before first dash
    const typeToRewards = {};
    for (const sc of scorecards) {
      const type = sc.slug.split('-')[0];
      if (!typeToRewards[type]) typeToRewards[type] = [];
      typeToRewards[type].push(sc.totalReward);
    }

    // Calculate mean reward per type
    const typeMeans = {};
    for (const [type, rewards] of Object.entries(typeToRewards)) {
      const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
      typeMeans[type] = mean;
    }

    // Score each candidate by expected value based on historical type mean
    const scored = candidates.map(c => {
      // Infer type from title keywords that match scorecard slug prefixes
      const titleLower = (c.title || '').toLowerCase();
      const cType = Object.keys(typeMeans).find(t => titleLower.includes(t)) || titleLower.split(/[\s\-]+/)[0];
      const historicalMean = typeMeans[cType] !== undefined ? typeMeans[cType] : 0;
      const expectedValue = historicalMean * c.confidence;
      return {
        ...c,
        expectedValue,
        type: cType,
        historicalMean
      };
    });

    // Sort by expected value (descending)
    scored.sort((a, b) => b.expectedValue - a.expectedValue);

    // 80/20 split: 80% exploit (best), 20% explore (random)
    const choice = Math.random();
    let selected;
    if (choice < 0.8) {
      // Exploit: return highest expected value
      selected = scored[0];
    } else {
      // Explore: return random candidate
      selected = scored[Math.floor(Math.random() * scored.length)];
    }

    const reason = choice < 0.8
      ? `exploit: type=${selected.type} mean-reward=${selected.historicalMean.toFixed(1)} expected-value=${selected.expectedValue.toFixed(1)}`
      : `explore: random-candidate type=${selected.type}`;

    return {
      title: selected.title,
      confidence: selected.confidence,
      rationale: selected.rationale,
      scored: true,
      reason
    };
  } catch (err) {
    // If scoring fails, fall back to best by confidence
    const best = candidates.reduce((a, b) => (a.confidence > b.confidence ? a : b), candidates[0]);
    return { ...best, scored: false, reason: `scoring error: ${err.message}` };
  }
}

/**
 * Propose 3 candidate next horizons for the autopilot loop. Combines
 * `getIdleTickCount` + `getRecentSignals` into a prompt asking the LLM
 * to imagine what to work on next, spawns `claude -p`, and parses the
 * JSON response into `[{ title, confidence, rationale }]`.
 *
 * Throws on subprocess failure or when fewer than 3 valid candidates
 * come back. Callers are responsible for catching and falling back.
 */
async function proposeCandidateHorizons(cwd) {
  const idleTicks = getIdleTickCount(cwd);
  const signals = getRecentSignals(cwd);

  const commitsBlock = signals.recentCommits.length > 0
    ? signals.recentCommits.slice(0, 20).join('\n')
    : '(no recent commits)';
  const wikiBlock = signals.wikiHealth
    ? signals.wikiHealth.slice(0, 2000)
    : '(no atris/wiki/STATUS.md)';
  const lessonsBlock = signals.recentLessons.length > 0
    ? signals.recentLessons.join('\n')
    : '(no atris/lessons.md)';

  const prompt = `You are helping the Atris autopilot loop imagine the next horizon to pursue.

The loop has been idle for ${idleTicks} tick(s) (ticks where 0 tasks were picked up in 0s).

Recent commits (git log --oneline -20):
${commitsBlock}

Wiki STATUS (atris/wiki/STATUS.md):
${wikiBlock}

Recent lessons (tail of atris/lessons.md):
${lessonsBlock}

Based on these signals, propose exactly 3 candidate next horizons for the loop to pursue. Each candidate must be:
- A real, concrete horizon tied to what the signals actually reveal (no placeholders, no "candidate 1", no TODO/FIXME stubs).
- Something the loop can actually work on in this repo right now.
- Distinct from the other two candidates.

Output STRICT JSON ONLY — no prose, no markdown code fences, no commentary. The output must be a single JSON array with exactly 3 objects, each shaped:

[
  { "title": "one-line horizon title", "confidence": 0.0-1.0, "rationale": "one sentence why this is worth pursuing now" },
  { "title": "...", "confidence": 0.0-1.0, "rationale": "..." },
  { "title": "...", "confidence": 0.0-1.0, "rationale": "..." }
]

Reply with the JSON array and nothing else.`;

  const tmpFile = path.join(cwd, '.autopilot-horizons-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  let output = '';
  try {
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')"`;
    const env = { ...process.env };
    delete env.CLAUDECODE;
    output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: PHASE_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      env
    }).toString();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('proposeCandidateHorizons: claude -p returned no JSON array');
  }
  const jsonText = output.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`proposeCandidateHorizons: JSON parse failed — ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('proposeCandidateHorizons: expected JSON array');
  }

  const candidates = parsed
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      title: typeof c.title === 'string' ? c.title.trim() : '',
      confidence: typeof c.confidence === 'number' ? c.confidence : Number(c.confidence),
      rationale: typeof c.rationale === 'string' ? c.rationale.trim() : ''
    }))
    .filter(c =>
      c.title.length > 0 &&
      typeof c.confidence === 'number' && !Number.isNaN(c.confidence) &&
      c.confidence >= 0 && c.confidence <= 1 &&
      c.rationale.length > 0
    );

  if (candidates.length < 3) {
    throw new Error(`proposeCandidateHorizons: expected 3 valid candidates, got ${candidates.length}`);
  }

  return candidates.slice(0, 3);
}

async function autopilotAtris(description, options = {}) {
  const {
    maxIterations = 100,
    verbose = false,
    dryRun = false,
    auto = false,
    duration = null
  } = options;

  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');

  if (!fs.existsSync(atrisDir)) {
    console.error('No atris/ folder. Run "atris init" first.');
    process.exit(1);
  }

  try { execSync('which claude', { stdio: 'pipe' }); } catch {
    console.error('claude CLI not found. Install Claude Code first.');
    process.exit(1);
  }

  const durationMs = parseDuration(duration);
  const durationLabel = duration
    ? duration
    : (maxIterations < 100 ? `${maxIterations} task${maxIterations === 1 ? '' : 's'}` : 'until clean');

  if (verbose) {
    console.log('');
    console.log('  atris autopilot v' + pkg.version);
    console.log(`  mode: ${auto ? 'autonomous' : 'interactive'} · limit: ${durationLabel}`);
    printTickStatus(cwd, { verbose: true });
    console.log('');
    console.log('  scanning workspace for work...');
    console.log('');
  } else {
    printTickStatus(cwd, { auto, durationLabel });
  }

  // Seed inbox if a description was given
  if (description) {
    ensureLogDirectory();
    const { logFile, dateFormatted } = getLogPath();
    if (!fs.existsSync(logFile)) createLogFile(logFile, dateFormatted);

    let content = fs.readFileSync(logFile, 'utf8');
    const idMatch = content.match(/\*\*I(\d+):/g);
    const nextId = idMatch
      ? Math.max(...idMatch.map(m => parseInt(m.match(/\d+/)[0]))) + 1
      : 1;

    const entry = `- **I${nextId}:** ${description}`;
    if (content.includes('## Inbox')) {
      content = content.replace(/(## Inbox[^\n]*\n)/, `$1${entry}\n`);
    } else {
      content += `\n## Inbox\n${entry}\n`;
    }
    fs.writeFileSync(logFile, content);
    if (verbose) {
      console.log(`  added to inbox: "${description}"`);
      console.log('');
    } else {
      printPlainBlock([
        'I added this request to the inbox.',
        `"${description}"`,
        '',
        'Next I will scan the workspace with that request in mind.'
      ].join('\n'));
    }
  }

  const startTime = Date.now();
  let completed = 0;
  const skipped = new Set();
  let tickOutcome = 'halted';
  let tickOutcomeText = 'I stopped for a manual check.';
  let tickNextStep = 'look for new work';
  let lastTaskTitle = null;
  let lastExecution = null;
  let lastVerifyCmd = null;

  for (let i = 0; i < maxIterations; i++) {
    // Check time budget
    if (durationMs && (Date.now() - startTime) >= durationMs) {
      const mins = Math.round((Date.now() - startTime) / 60000);
      if (verbose) {
        console.log(`  time's up (${mins}m elapsed). stopping.`);
      } else {
        printPlainBlock([
          `I hit the time limit after ${mins} minute${mins === 1 ? '' : 's'}.`,
          '',
          'Next I am stopping the loop.'
        ].join('\n'));
      }
      break;
    }

    const suggestion = await suggestNextTask(cwd, skipped);

    if (!suggestion) {
      tickOutcome = 'idle';
      tickOutcomeText = 'I checked the repo and found no work to pick up this tick.';
      tickNextStep = 'scan for new signals and propose the next horizon';
      if (verbose) {
        console.log('  nothing to do. workspace is clean.');
      } else {
        printPlainBlock([
          'I found no work this tick.',
          'The workspace looks clean.',
          '',
          'Next I will stop until a new signal appears.'
        ].join('\n'));
      }
      break;
    }

    // Present the suggestion
    if (verbose) {
      console.log(`  ── suggestion ${i + 1}/${maxIterations} ──────────────────────────────`);
      console.log('');
      console.log(`  ${suggestion.task}`);
      console.log(`  why: ${suggestion.why}`);
      console.log(`  kind: ${suggestion.kind}`);
      console.log('');
    } else {
      printPlainBlock(renderHumanSuggestion(suggestion, i + 1, maxIterations));
    }

    if (dryRun) {
      if (verbose) {
        console.log('  (dry run — would execute this)');
        console.log('');
      } else {
        printPlainBlock([
          'This was a dry run, so I did not execute the task.',
          '',
          'Next I will look for another task on the next pass.'
        ].join('\n'));
      }
      // Track as skipped so dry-run shows variety
      skipped.add(suggestion.task);
      if (suggestion.kind === 'docs') skipped.add('fix-map-refs');
      if (suggestion.kind === 'review') skipped.add('review');
      if (suggestion.kind === 'lessons') skipped.add('lessons');
      if (suggestion.kind === 'feature') skipped.add('incomplete-features');
      continue;
    }

    // Get approval
    let decision;
    if (auto) {
      decision = 'approve';
    } else {
      decision = await askApproval();
    }

    if (decision === 'quit') {
      if (verbose) {
        console.log('  stopped.');
      } else {
        printPlainBlock([
          'I stopped the loop.',
          '',
          'Next nothing will run until autopilot starts again.'
        ].join('\n'));
      }
      break;
    }

    if (decision === 'skip') {
      skipped.add(suggestion.task);
      if (suggestion.kind === 'staleness') skipped.add(`recompile:${suggestion.task}`);
      if (suggestion.kind === 'docs') skipped.add('fix-map-refs');
      if (suggestion.kind === 'review') skipped.add('review');
      if (suggestion.kind === 'lessons') skipped.add('lessons');
      if (suggestion.kind === 'feature') skipped.add('incomplete-features');
      if (verbose) {
        console.log('  skipped.');
        console.log('');
      } else {
        printPlainBlock([
          'I skipped that task.',
          '',
          'Next I will look for another one.'
        ].join('\n'));
      }
      continue;
    }

    // Execute: plan → do → review
    lastTaskTitle = suggestion.task;
    const context = { task: suggestion.task, kind: suggestion.kind };

    try {
      if (verbose) {
        console.log('');
        console.log('  planning...');
      } else {
        printPlainBlock([
          'I am running that task now.',
          '',
          'Next I will report what happened and whether review passed.'
        ].join('\n'));
      }
      const execution = runTaskOnce(context, { verbose, cwd });
      lastExecution = execution;
      lastVerifyCmd = getVerifyCommand(cwd, context.task);
      const planTime = execution.phaseResults.plan.elapsedSeconds;
      if (verbose) console.log(`  planned (${planTime}s)`);

      if (verbose) console.log('  building...');
      const doTime = execution.phaseResults.do.elapsedSeconds;
      if (verbose) console.log(`  built (${doTime}s)`);

      if (verbose) console.log('  reviewing...');
      const reviewOutput = execution.reviewOutput;
      const reviewTime = execution.phaseResults.review.elapsedSeconds;

      if (reviewOutput.includes('failed')) {
        tickOutcome = 'halted';
        tickOutcomeText = `I built "${lastTaskTitle}" but review flagged issues.`;
        tickNextStep = 'wait for a human to check the review output';
        if (verbose) {
          console.log(`  review flagged issues (${reviewTime}s). stopping for manual check.`);
        } else {
          printPlainBlock([
            `I planned and built the task, but review found issues after ${reviewTime}s.`,
            '',
            'Next I stopped for a manual check.'
          ].join('\n'));
        }
        break;
      }
      if (verbose) console.log(`  reviewed (${reviewTime}s)`);

      // Handle verify failure
      if (!execution.verifyPass) {
        tickOutcome = 'halted';
        tickOutcomeText = `I planned, built, and reviewed "${lastTaskTitle}" but verify failed.`;
        tickNextStep = 'verify failed, halting';
        writeLesson(cwd, 'verify-failed', 'fail', `Task "${lastTaskTitle}" passed review but failed verify command.`);
        if (verbose) {
          console.log(`  verify failed. stopping for manual check.`);
        } else {
          printPlainBlock([
            `I planned, built, and reviewed the task, but the verify check failed.`,
            '',
            'Next I stopped for a manual check.'
          ].join('\n'));
        }
        break;
      }

      completed++;
      tickOutcome = 'built';
      tickOutcomeText = `I planned, built, and reviewed "${suggestion.task}".`;
      tickNextStep = 'pick the next endgame task';
      logCompletion(suggestion.task);
      if (verbose) {
        console.log(`  done. ${completed} task${completed > 1 ? 's' : ''} completed.`);
        console.log('');
      } else {
        printPlainBlock([
          'I planned, built, and reviewed the task.',
          `Plan took ${planTime}s, build took ${doTime}s, and review took ${reviewTime}s.`,
          '',
          `This tick has completed ${completed} task${completed > 1 ? 's' : ''}.`,
          '',
          'Next I will look for the next task.'
        ].join('\n'));
      }

    } catch (err) {
      tickOutcome = 'halted';
      tickOutcomeText = `I hit an error while running "${lastTaskTitle || 'a task'}": ${err.message}`;
      tickNextStep = 'stop until a human looks at the error';
      if (verbose) {
        console.error(`  error: ${err.message}`);
      } else {
        printPlainBlock([
          'I hit an error while running the task.',
          err.message,
          '',
          'Next I stopped the loop.'
        ].join('\n'));
      }
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // Heartbeat: plain-language tick summary into today's journal `## Notes`.
  // Guarded — a journal write failure must never crash the tick.
  try {
    const horizonSlug = readHorizonSlug(cwd);
    const time = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    }).toLowerCase();
    const idle = tickOutcome === 'idle' || (completed === 0 && tickOutcome !== 'halted');

    // Compute reward score if we had an execution
    let tickReward = undefined;
    if (lastExecution && lastVerifyCmd) {
      tickReward = computeTickReward(lastExecution, tickOutcome, lastVerifyCmd);
    }

    appendTickSummary(cwd, {
      time,
      outcome: tickOutcomeText,
      horizon: horizonSlug === 'unset' ? null : horizonSlug,
      nextStep: tickNextStep,
      idle,
      reward: tickReward
    });
  } catch {
    /* journal write failure must not crash the tick */
  }

  // RL: auto-write scorecard when endgame completes (all [endgame] tasks done)
  try {
    const atrisDir = path.join(cwd, 'atris');
    const { complete, endgameSlug } = detectEndgameCompletion(atrisDir);
    if (complete && endgameSlug) {
      // Sum per-tick rewards from today's journal for this endgame
      const journalPath = getLogPath();
      let totalReward = 0;
      if (fs.existsSync(journalPath)) {
        const jContent = fs.readFileSync(journalPath, 'utf8');
        const rewardMatches = jContent.matchAll(/reward:\s*([+-]?\d+)/g);
        for (const m of rewardMatches) totalReward += parseInt(m[1]);
      }
      writeScorecard(atrisDir, {
        slug: endgameSlug,
        startDate: new Date().toISOString().split('T')[0],
        tasksShipped: completed,
        tasksAttempted: completed + (tickOutcome === 'halted' ? 1 : 0),
        wallClockHours: elapsed / 3600,
        haltRatio: tickOutcome === 'halted' ? 1 : 0,
        totalReward,
        lessonsGenerated: 0,
      });
      if (!verbose) {
        printPlainBlock(`Scorecard written for endgame "${endgameSlug}". Total reward: ${totalReward}.`);
      }
    }
  } catch {
    /* scorecard write must not crash the tick */
  }

  if (verbose) {
    console.log('');
    console.log(`  autopilot finished. ${completed} task${completed !== 1 ? 's' : ''} in ${elapsed}s.`);
    console.log('');
  } else {
    printPlainBlock([
      'Autopilot finished.',
      `It completed ${completed} task${completed !== 1 ? 's' : ''} in ${elapsed}s.`
    ].join('\n'));
  }

  return { success: completed > 0, completed };
}

/**
 * Entry point when called without a description.
 */
async function autopilotFromTodo(options = {}) {
  return autopilotAtris(null, options);
}

module.exports = {
  appendTickSummary,
  autopilotAtris,
  autopilotFromTodo,
  buildPrompt,
  getIdleTickCount,
  getRecentSignals,
  getTickStatus,
  renderHumanSuggestion,
  renderHumanTickIntro,
  proposeCandidateHorizons,
  runTaskOnce,
  scoreEndgameCandidates,
  suggestNextTask
};
