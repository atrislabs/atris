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

const pkg = require('../package.json');

const PHASE_TIMEOUT = 600000; // 10 min per phase

/**
 * Scan workspace for the next thing worth doing.
 * Returns { task, why, kind } or null.
 */
function suggestNextTask(cwd, skipped = new Set()) {
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
      const items = inboxMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
      if (items.length > 0) {
        const firstItem = items[0].replace(/^-\s*\*\*I\d+:\*\*\s*/, '').replace(/^-\s*/, '').trim();
        if (!skipped.has(firstItem)) {
          suggestions.push({
            task: `Break down inbox idea: "${firstItem}"`,
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

  if (suggestions.length === 0) return null;

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

  return [
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
  const { contextNote = '' } = options;
  const readFiles = getContextFiles(phase, options);
  const noteBlock = contextNote ? `\nBenchmark context:\n${contextNote}\n` : '';

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
- This is a pinned benchmark run. Execute the task directly.
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
- This is a pinned benchmark review. Check quality without widening scope.
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

function runTaskOnce(context, options = {}) {
  const { verbose = false } = options;
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

  return {
    success: !reviewOutput.includes('failed'),
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    phaseResults,
    reviewOutput,
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

/**
 * Print the visual ASCII tick status block. Shows identity (forward / flow),
 * current endgame slug + horizon (backward / endgame), and progress through
 * endgame steps. Two halves of the same engine — flow and endgame — meeting
 * at the next tick. Called at the start of each autopilot run.
 */
function printTickStatus(cwd) {
  const atrisDir = path.join(cwd, 'atris');
  const W = 64;        // total box width including borders
  const C = W - 4;     // content width per line

  const trim = (s, w) => {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + '…';
    return s;
  };
  const line = (content) => '  │ ' + content.padEnd(C) + ' │';

  // FLOW side — identity from PERSONA.md (first non-trivial line)
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

  // ENDGAME side — slug + horizon from TODO.md ## Endgame section
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

  const barWidth = 12;
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const ratio = total > 0 ? `${done}/${total}` : '0/0';

  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  console.log('');
  console.log('  ┌' + '─'.repeat(W - 2) + '┐');
  console.log(line(`tick · ${time}`));
  console.log(line(`identity:  ${trim(identity, C - 11)}`));
  console.log(line(`horizon:   ${trim(slug, C - 11)}`));
  if (horizon) {
    console.log(line(`           ${trim(horizon, C - 11)}`));
  }
  console.log(line(`progress:  ${bar}  ${ratio} endgame steps`));
  console.log('  └' + '─'.repeat(W - 2) + '┘');
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
  const durationLabel = duration ? duration : (maxIterations < 100 ? `${maxIterations} tasks` : 'until clean');

  console.log('');
  console.log('  atris autopilot v' + pkg.version);
  console.log(`  mode: ${auto ? 'autonomous' : 'interactive'} · limit: ${durationLabel}`);
  printTickStatus(cwd);
  console.log('');
  console.log('  scanning workspace for work...');
  console.log('');

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
    console.log(`  added to inbox: "${description}"`);
    console.log('');
  }

  const startTime = Date.now();
  let completed = 0;
  const skipped = new Set();

  for (let i = 0; i < maxIterations; i++) {
    // Check time budget
    if (durationMs && (Date.now() - startTime) >= durationMs) {
      const mins = Math.round((Date.now() - startTime) / 60000);
      console.log(`  time's up (${mins}m elapsed). stopping.`);
      break;
    }

    const suggestion = suggestNextTask(cwd, skipped);

    if (!suggestion) {
      console.log('  nothing to do. workspace is clean.');
      break;
    }

    // Present the suggestion
    console.log(`  ── suggestion ${i + 1}/${maxIterations} ──────────────────────────────`);
    console.log('');
    console.log(`  ${suggestion.task}`);
    console.log(`  why: ${suggestion.why}`);
    console.log(`  kind: ${suggestion.kind}`);
    console.log('');

    if (dryRun) {
      console.log('  (dry run — would execute this)');
      console.log('');
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
      console.log('  stopped.');
      break;
    }

    if (decision === 'skip') {
      skipped.add(suggestion.task);
      if (suggestion.kind === 'staleness') skipped.add(`recompile:${suggestion.task}`);
      if (suggestion.kind === 'docs') skipped.add('fix-map-refs');
      if (suggestion.kind === 'review') skipped.add('review');
      if (suggestion.kind === 'lessons') skipped.add('lessons');
      if (suggestion.kind === 'feature') skipped.add('incomplete-features');
      console.log('  skipped.');
      console.log('');
      continue;
    }

    // Execute: plan → do → review
    const context = { task: suggestion.task, kind: suggestion.kind };

    try {
      console.log('');
      console.log('  planning...');
      let t0 = Date.now();
      const execution = runTaskOnce(context, { verbose });
      const planTime = execution.phaseResults.plan.elapsedSeconds;
      console.log(`  planned (${planTime}s)`);

      console.log('  building...');
      t0 = Date.now();
      const doTime = execution.phaseResults.do.elapsedSeconds;
      console.log(`  built (${doTime}s)`);

      console.log('  reviewing...');
      t0 = Date.now();
      const reviewOutput = execution.reviewOutput;
      const reviewTime = execution.phaseResults.review.elapsedSeconds;

      if (reviewOutput.includes('failed')) {
        console.log(`  review flagged issues (${reviewTime}s). stopping for manual check.`);
        break;
      }
      console.log(`  reviewed (${reviewTime}s)`);

      completed++;
      logCompletion(suggestion.task);
      console.log(`  done. ${completed} task${completed > 1 ? 's' : ''} completed.`);
      console.log('');

    } catch (err) {
      console.error(`  error: ${err.message}`);
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('');
  console.log(`  autopilot finished. ${completed} task${completed !== 1 ? 's' : ''} in ${elapsed}s.`);
  console.log('');

  return { success: completed > 0, completed };
}

/**
 * Entry point when called without a description.
 */
async function autopilotFromTodo(options = {}) {
  return autopilotAtris(null, options);
}

module.exports = {
  autopilotAtris,
  autopilotFromTodo,
  buildPrompt,
  runTaskOnce,
  suggestNextTask
};
