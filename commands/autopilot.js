/**
 * Atris Autopilot — Suggest, justify, execute. One task at a time.
 *
 * Scans the workspace for signals (stale pages, broken refs, abandoned tasks,
 * inbox items, backlog) and suggests the most important thing to do next.
 * Human approves, skips, or cancels. In --auto mode, runs without asking.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawnSync } = require('child_process');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { parseTodo } = require('../lib/todo');
const { findStalePages, findStaleTasks, healBrokenMapRefs } = require('./clean');
const {
  buildScorecardData,
  readScorecards,
  writeScorecard,
  detectEndgameCompletion
} = require('../lib/scorecard');
const { REWARD_CONFIG, REWARD_CHECKSUM } = require('../lib/reward-config');

const pkg = require('../package.json');

const PHASE_TIMEOUT = 600000; // 10 min per phase

function looksOwnerClaimed(claimed) {
  const text = String(claimed || '').toLowerCase();
  return /\bkeshav(?:rao)?\b/.test(text) || /\b(owner|human|operator)\b/.test(text);
}

function looksOwnerGatedTitle(title) {
  const text = String(title || '').toLowerCase();
  return (
    /\bowner[- ](?:approval|input|gate|gated)\b/.test(text) ||
    /\bhuman[- ](?:approval|input|gate|gated)\b/.test(text) ||
    /\bmanual send\b/.test(text) ||
    /\broute confirmation\b/.test(text) ||
    /\bconfirm pallet destination\b/.test(text) ||
    /\bconfirm .+ destination before .+ approval\b/.test(text) ||
    /\bapprove and manually send\b/.test(text)
  );
}

function shouldSkipAutoHumanGate(task) {
  if (!task) return false;
  return looksOwnerClaimed(task.claimed) || looksOwnerGatedTitle(task.title || task.task);
}

function repoMapAuditReportsClean(cwd) {
  const auditPath = path.join(cwd, 'scripts', 'audit_map_refs.py');
  if (!fs.existsSync(auditPath)) return false;

  const result = spawnSync('python3', [auditPath], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) return false;

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/Total broken references:\s*(\d+)/i);
  return Boolean(match && Number(match[1]) === 0);
}

/**
 * Scan workspace for the next thing worth doing.
 * Returns { task, why, kind } or null.
 */
async function suggestNextTask(cwd, skipped = new Set(), { auto = false } = {}) {
  const atrisDir = path.join(cwd, 'atris');
  const suggestions = [];

  // --- Endgame tasks (highest priority — pursue the current horizon to completion) ---
  const todoPath = path.join(atrisDir, 'TODO.md');
  const todo = parseTodo(todoPath);

  for (const t of todo.backlog) {
    if (t.tags && t.tags.includes('unverified')) continue;
    if (shouldSkipEndgameAtPicker(cwd, t)) continue;
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
    if (!(t.tags && t.tags.includes('unverified')) && !skipped.has(t.title) && !(auto && shouldSkipAutoHumanGate(t))) {
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
      priority: 2,
      files: [pageName, sp.staleSource],
      skipKey: key
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
      priority: 3,
      skipKey: key
    });
  }

  // --- Broken MAP.md references ---
  const { unhealable } = repoMapAuditReportsClean(cwd)
    ? { unhealable: [] }
    : healBrokenMapRefs(cwd, atrisDir, true); // dry-run
  if (unhealable.length > 0 && !skipped.has('fix-map-refs')) {
    const sample = unhealable.slice(0, 3).map(r => `${r.file}:${r.line}`).join(', ');
    suggestions.push({
      task: `Fix ${unhealable.length} broken reference${unhealable.length > 1 ? 's' : ''} in MAP.md`,
      why: `These file:line references point to code that moved or was deleted: ${sample}. MAP.md is the navigation — it needs to be accurate.`,
      kind: 'docs',
      priority: 4
    });
  }

  // --- Self-healing: unresolved fail lessons (bug still present per grep) ---
  if (!skipped.has('self-heal')) {
    const failLesson = pickUnresolvedFailLesson(cwd);
    if (failLesson && !skipped.has(`self-heal:${failLesson.slug}`)) {
      suggestions.push({
        task: `Fix unresolved fail lesson: ${failLesson.slug}`,
        why: `Lesson from ${failLesson.date} tagged \`fail\` and grep confirms the bug pattern is still present in-repo. Self-heal before taking new work.`,
        kind: 'self-heal',
        priority: 4.5,
        lessonLine: failLesson.line,
        lessonSlug: failLesson.slug,
        lessonDate: failLesson.date,
        skipKey: `self-heal:${failLesson.slug}`
      });
    }
  }

  // --- Backlog tasks ---
  for (const t of todo.backlog) {
    if (t.tags && t.tags.includes('unverified')) continue;
    if (shouldSkipEndgameAtPicker(cwd, t)) continue;
    if (auto && shouldSkipAutoHumanGate(t)) continue;
    if (skipped.has(t.title)) continue;
    const remaining = todo.backlog.filter(b => !(b.tags && b.tags.includes('unverified'))).length;
    suggestions.push({
      task: t.title,
      why: `Next in the backlog${t.tag ? ` (${t.tag})` : ''}. ${remaining} task${remaining > 1 ? 's' : ''} waiting.`,
      kind: 'backlog',
      priority: 5
    });
    break;
  }

  // --- Proactive "surprise me" anomalies (didn't-ask-but-noticed signals) ---
  try {
    for (const anomaly of scanAnomalies(cwd)) {
      if (anomaly.skipKey && skipped.has(anomaly.skipKey)) continue;
      suggestions.push(anomaly);
    }
  } catch { /* anomaly scanner must never crash the tick */ }

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

  // Staleness gate: filter out unverified/stale suggestions
  const staleSkipped = [];
  const fresh = [];
  for (const s of suggestions) {
    const fakeTask = { title: s.task, tag: s.kind === 'endgame' ? 'endgame' : null, claimed: null };
    if (s.kind === 'resume' && todo.inProgress.length > 0) {
      fakeTask.claimed = todo.inProgress[0].claimed;
    }
    const age = getTaskAgeDays(fakeTask, todoPath);
    const status = isStillTrue({ title: s.task, age, source: null }, cwd);
    if (status === 'stale') {
      staleSkipped.push({ task: s.task, status, reasoning: null });
      continue;
    }
    if (status === 'unverified') {
      if (auto) {
        // Auto mode: use model check
        const result = askModel({ title: s.task, age, source: null }, cwd);
        if (!result.fresh) {
          staleSkipped.push({ task: s.task, status: 'unverified (model: not fresh)', reasoning: result.reasoning });
          continue;
        }
      } else {
        // Interactive mode: ask the human
        const result = await askHuman(s.task);
        if (!result.fresh) {
          staleSkipped.push({ task: s.task, status: 'unverified (human: not relevant)', reasoning: null });
          continue;
        }
      }
    }
    fresh.push(s);
  }

  // Log skipped items to journal
  if (staleSkipped.length > 0) {
    try {
      const { logFile } = getLogPath();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const lines = staleSkipped.map(s => `- ${s.task} (${s.status})${s.reasoning ? ` — ${s.reasoning}` : ''}`);
      const note = `\n### Staleness skip — ${hhmm}\n${lines.join('\n')}\n`;
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const notesIdx = content.indexOf('## Notes');
        if (notesIdx !== -1) {
          const insertAt = content.indexOf('\n', notesIdx) + 1;
          const updated = content.slice(0, insertAt) + note + content.slice(insertAt);
          fs.writeFileSync(logFile, updated);
        } else {
          fs.appendFileSync(logFile, `\n## Notes\n${note}`);
        }
      }
    } catch {}
  }

  return fresh[0] || null;
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
 * Ask the human whether an unverified task is still relevant.
 * Interactive mode only — in auto mode, caller skips silently.
 * Returns { fresh: boolean }.
 */
function askHuman(taskTitle) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  is "${taskTitle}" still relevant? y/n → `, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve({ fresh: a === 'y' || a === 'yes' });
    });
  });
}

/**
 * Type-check a child_process error as a timeout/kill. Node's execSync attaches
 * `code: 'ETIMEDOUT'` and `signal` on timeout — it does NOT set `killed`, so a
 * `killed`-only guard is dead code on the exact error it was written for
 * (lesson: etimedout-error-shape, 2026-06-10).
 */
function isPhaseTimeoutError(err) {
  return Boolean(err && (err.killed || err.code === 'ETIMEDOUT' || err.signal));
}

/**
 * execSync with the phase-timeout orphan fix. Node's sync-exec timeout signals
 * only the direct child pid — the `/bin/sh -c` wrapper — so the `claude` it
 * spawned kept committing 160–296s past the 600s wall (lesson:
 * etimedout-error-shape, 2026-06-10). `detached: true` makes the wrapper a
 * process-group leader; on timeout we sweep the whole group via
 * `process.kill(-pid, 'SIGKILL')`. ESRCH on the sweep means the group already
 * died — fine. The original error is rethrown untouched so every call site
 * keeps its existing catch contract (err.stdout passthrough included).
 */
function execPhaseCommandSync(cmd, opts = {}) {
  try {
    return execSync(cmd, { ...opts, detached: true });
  } catch (err) {
    if (isPhaseTimeoutError(err) && err.pid) {
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
 * Run a phase via claude -p subprocess.
 */
function executePhaseDetailed(phase, context, options = {}) {
  const { verbose = false, timeout = PHASE_TIMEOUT } = options;

  const prompt = buildPrompt(phase, context, options);
  const tmpFile = path.join(process.cwd(), '.autopilot-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = options.cmdOverride
      || `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"`;
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const output = execPhaseCommandSync(cmd, {
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
    if (isPhaseTimeoutError(err)) {
      throw new Error(`${phase} phase timed out after ${timeout / 1000}s (claude -p hit the wall; any work it committed survives — reconcile from pre-tick HEADs)`);
    }
    if (err.stdout) {
      return { prompt, output: err.stdout };
    }
    throw err;
  }
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
  const readFiles = getContextFiles(phase, {
    ...options,
    extraReadFiles: [
      ...(options.extraReadFiles || []),
      ...(Array.isArray(context.files) ? context.files : []),
    ],
  });
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
      const fileList = Array.isArray(context.files) && context.files.length
        ? context.files.map((file) => `- ${file}`).join('\n')
        : '- target page or MAP entry from the task title\n- source file(s) that changed';
      return `${baseRules}

Maintenance task: ${task}

Relevant files:
${fileList}

Figure out what needs to change and why. Create exactly one focused task in atris/TODO.md unless the drift truly requires separate commits.
For stale pages, read both the page and its sources to understand the drift.
The task row must include these fields so plan-review can prove it is executable:
- **Files:** concrete target page plus source file paths
- **Exit:** the observable post-update state
- **Verify:** one raw shell command that checks concrete facts and rejects stale phrases; use shell operators like \`&&\`, \`grep -q\`, or \`test\`, not Markdown backticks or English like "returns 1" / "shows today's date"
- **Rollback:** git checkout -- <changed-files> before commit, or git revert HEAD --no-edit after commit
Do not write tasks without Verify and Rollback. Do not use \`true\`, \`echo ok\`, or vague "review manually" verification.

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

    if (kind === 'self-heal') {
      const { lessonLine = '', lessonSlug = '' } = context;
      const lessonBlock = lessonLine ? `\nUnresolved fail lesson:\n${lessonLine}\n` : '';
      return `${baseRules}${lessonBlock}
Self-heal task: ${task}

This is an unresolved \`fail\` lesson from atris/lessons.md. grep confirms the bug pattern
is still present in-repo — the fix has NOT been shipped yet.

Plan the smallest fix:
1. Parse the lesson for file:line references and the described bug pattern.
2. Read those files to confirm the bug is exactly as described (or has drifted).
3. Write ONE task in atris/TODO.md with:
   - **Exit:** the specific behavior that proves the fix
   - **Verify:** a command that fails now and will pass after the fix${lessonSlug ? ` (include "${lessonSlug}" in the task title so the lesson auto-resolves)` : ''}
   - **Rollback:** how to revert if the fix misses
4. Do NOT fix it in this phase — planner only. The executor will do the work.

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

    if (kind === 'self-heal') {
      const { lessonLine = '', lessonSlug = '' } = context;
      const lessonBlock = lessonLine ? `\nUnresolved fail lesson:\n${lessonLine}\n` : '';
      return `You are the executor. Read your MEMBER.md spec first if available.

Rules:
- You CAN read and write code. You CANNOT plan or create new tasks.
- Execute ONE step at a time. Verify each step before moving on.
- Check MAP.md for file locations before grepping.
- Stay in scope. Only fix the bug described in the lesson — no side quests.

Read these files first:
${readFiles}
${lessonBlock}
Self-heal task: ${task}

1. Find the self-heal task in TODO.md and claim it (Claimed by: Executor at ${new Date().toISOString()}).
2. Parse the lesson above for file:line references. Open those files and locate the bug pattern.
3. Make the smallest change that removes the bug pattern AND makes the lesson's Verify command pass.
4. Run the Verify command yourself to confirm it passes.
5. Update MAP.md only if file:line locations shifted because of your fix.
6. Commit: git add <specific-files> && git commit -m "fix: ${lessonSlug || 'self-heal'}"

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
 * Build a clean kebab-case lesson slug from free text. Strips non-alphanumerics
 * (em-dashes were leaking into slugs verbatim) and truncates at a word boundary
 * instead of mid-word (e.g. the old `.slice(0, 40)` produced
 * `verify-fail-per-member-model-selection-—-the-member-`).
 */
function lessonSlug(text, maxLen = 40) {
  const base = String(text || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'unknown';
  if (base.length <= maxLen) return base;
  const cut = base.slice(0, maxLen);
  const lastDash = cut.lastIndexOf('-');
  // base[maxLen] continues a word — back up to the last full word.
  const atBoundary = base[maxLen] === '-';
  const trimmed = atBoundary ? cut : (lastDash > 0 ? cut.slice(0, lastDash) : cut);
  return trimmed.replace(/-+$/g, '') || 'unknown';
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
  // Same-day dedup: if an identical line already exists, skip the write. A
  // cron firing every 13min produced 5 identical no-verify-field lessons in
  // one day (2026-05-08) before the picker-side fix landed — pure noise. The
  // append-only contract still holds across days because today's date is in
  // the line.
  if (content.includes(lessonLine)) return;
  // Append after the --- separator
  if (content.includes('---\n')) {
    content = content.replace(/---\n/, `---\n\n${lessonLine}\n`);
  } else {
    content += `\n${lessonLine}\n`;
  }
  fs.writeFileSync(lessonsPath, content);
}

/**
 * Record a tick's commit hash and verify command in atris/tick-registry.json.
 * Each entry: { hash, verifyCmd, slug, timestamp }.
 */
function recordTickCommit(cwd, hash, verifyCmd, slug) {
  const registryPath = path.join(cwd, 'atris', 'tick-registry.json');
  let registry = [];
  if (fs.existsSync(registryPath)) {
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { registry = []; }
  }
  registry.push({ hash, verifyCmd, slug, timestamp: new Date().toISOString() });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Retroactive regression check. Reads last 10 entries from tick-registry.json,
 * re-runs each verify command at its original commit using git worktree,
 * returns array of { hash, slug, pass }. On failure: writes a lesson with
 * retroactive context.
 */
function regressionCheck(cwd) {
  const registryPath = path.join(cwd, 'atris', 'tick-registry.json');
  if (!fs.existsSync(registryPath)) return [];

  let registry = [];
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return []; }
  if (!Array.isArray(registry) || registry.length === 0) return [];

  const entries = registry.slice(-10);
  const results = [];

  for (const entry of entries) {
    if (!entry.hash || !entry.verifyCmd) {
      results.push({ hash: entry.hash, slug: entry.slug, pass: true, skipped: true });
      continue;
    }

    const worktreePath = path.join(cwd, '.regression-worktree-' + entry.hash.slice(0, 8));
    let pass = false;
    try {
      // Create a worktree at the commit
      execSync(`git worktree add "${worktreePath}" ${entry.hash} --detach 2>/dev/null`, { cwd, stdio: 'pipe' });
      try {
        execSync(entry.verifyCmd, { cwd: worktreePath, stdio: 'pipe', timeout: 60000 });
        pass = true;
      } catch {
        pass = false;
      }
    } catch {
      // If worktree creation fails (e.g., commit doesn't exist), skip
      results.push({ hash: entry.hash, slug: entry.slug, pass: true, skipped: true });
      continue;
    } finally {
      // Clean up worktree
      try { execSync(`git worktree remove "${worktreePath}" --force 2>/dev/null`, { cwd, stdio: 'pipe' }); } catch {}
    }

    if (!pass) {
      writeLesson(cwd, `regression-${entry.slug || 'unknown'}`, 'fail',
        `Retroactive regression: verify command for tick ${entry.hash.slice(0, 7)} (${entry.slug}) now fails. -5 retroactive penalty applied.`);
    }

    results.push({ hash: entry.hash, slug: entry.slug, pass });
  }

  return results;
}

/**
 * Get the verify command for a task from TODO.md
 * Reads TODO.md, finds the task by title across active/completed sections,
 * and extracts the verify field.
 * Returns { cmd, explicit } — explicit is true only if the task has an explicit Verify field.
 */
function getVerifyCommand(cwd, taskTitle) {
  const todoPath = path.join(cwd, 'atris', 'TODO.md');
  if (fs.existsSync(todoPath)) {
    const todo = parseTodo(todoPath);
    const task = [...todo.inProgress, ...(todo.review || []), ...todo.backlog, ...todo.completed]
      .find(t => t.title === taskTitle);
    if (task && task.verify) return { cmd: task.verify, explicit: true };
  }
  // Fallback: detect repo shape and pick a sensible default.
  // Reactive tasks (inbox/staleness/imagined) don't carry explicit verify fields,
  // so without shape detection they get `npm test` even on Python/Rust/Go repos.
  return { cmd: detectDefaultVerify(cwd), explicit: false };
}

function collectExplicitVerifyTasks(cwd) {
  const todoPath = path.join(cwd, 'atris', 'TODO.md');
  if (!fs.existsSync(todoPath)) return [];
  const todo = parseTodo(todoPath);
  return [...todo.inProgress, ...(todo.review || []), ...todo.backlog, ...todo.completed]
    .filter((task) => task && task.verify)
    .map((task) => ({
      title: task.title,
      verify: task.verify,
      key: `${task.title}\0${task.verify}`,
    }));
}

function findNewExplicitVerifyCommand(cwd, beforeKeys) {
  const prior = beforeKeys instanceof Set ? beforeKeys : new Set(beforeKeys || []);
  const added = collectExplicitVerifyTasks(cwd).filter((task) => !prior.has(task.key));
  if (added.length !== 1) return null;
  return { cmd: added[0].verify, explicit: true, task: added[0].title };
}

function shouldAdoptPlannedVerify(kind) {
  return ['staleness', 'docs', 'review', 'inbox', 'cleanup', 'feature', 'lessons', 'imagined'].includes(kind);
}

function validateVerifyCommandShape(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return { ok: true };
  if (text.includes('`')) {
    return { ok: false, reason: 'Verify contains markdown backticks instead of a raw shell command' };
  }
  if (/\b(returns?|shows?|equals?|should|must)\b/i.test(text)) {
    return { ok: false, reason: 'Verify contains prose expectations instead of shell operators/assertions' };
  }
  return { ok: true };
}

function haltInvalidVerify(cwd, context, verifyCmd, reason, startedAt, phaseResults = {}) {
  writeLesson(cwd, 'verify-not-runnable', 'fail',
    `Verify \`${verifyCmd}\` for "${context.task}" is not a runnable shell command: ${reason}. Tick halted.`);
  return {
    outcome: 'halted',
    reason: 'verify-not-runnable',
    phaseResults,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    verifyRan: false,
    verifyPass: false,
    verifyCmd,
  };
}

/**
 * Infer a default verify command from the repo shape. Order matters:
 * package.json with a non-stub test script → `npm test`; then pytest/python;
 * then rust/go; otherwise null (no default — skip verify).
 */
function detectDefaultVerify(cwd) {
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const test = parsed.scripts && parsed.scripts.test;
      if (test && test !== 'echo "Error: no test specified" && exit 1') {
        return 'npm test';
      }
    } catch { /* fall through */ }
  }
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) ||
      fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
      fs.existsSync(path.join(cwd, 'setup.py'))) {
    // Prefer a repo-curated fast lane over bare `pytest`. Large repos (e.g.
    // atrisos-backend) ship a critical-path runner because the full suite is
    // unsafe to run unsupervised (CLAUDE.md: "NEVER run pytest tests/ ... eats
    // 10GB+ RAM"). lessons.md 2026-05-10 verify-failed: bare `pytest` failed
    // a reactive-signal verify and halted the loop.
    for (const fast of ['backend/scripts/test_fast.sh', 'scripts/test_fast.sh', 'test_fast.sh']) {
      if (fs.existsSync(path.join(cwd, fast))) return `bash ${fast}`;
    }
    return 'pytest';
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return 'cargo test';
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return 'go test ./...';
  }
  return null;
}

/**
 * Verify that computeTickReward has not been modified since ship time.
 * Returns { ok, expected, actual }.
 */
function verifyJudgeIntegrity() {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(REWARD_CONFIG));
  h.update(computeTickReward.toString());
  const actual = h.digest('hex');
  return { ok: actual === REWARD_CHECKSUM, expected: REWARD_CHECKSUM, actual };
}

/**
 * Build the validator's plan-review prompt. Fresh context — the validator
 * reads the plan output and the contract fields as if it has never seen them.
 */
function buildPlanReviewPrompt(context, planOutput) {
  const files = Array.isArray(context.files) && context.files.length
    ? context.files.join(', ')
    : 'none declared in context';
  return `You are the validator in plan-review mode. You have NOT seen the planning context — read everything fresh.

Task: "${context.task}"
Kind: ${context.kind || 'unknown'}
Files declared in context: ${files}

Plan output from the navigator:
---
${planOutput || '(no plan output captured)'}
---

Read from disk:
- atris/atris.md (the workspace protocol — operating rules and task shape)
- atris/TODO.md (find this task; inspect Files, Exit, Verify, After, Rollback)
- atris/lessons.md (recent failures — last 20 lines)

Decide if the plan is safe to execute. Check:
1. Verify points at a falsifiable raw shell command or rubric (not \`true\`, \`echo ok\`, Markdown backticks, or English like "returns 1" / "shows today's date").
   Prefer \`atris verify <slug> --section <name>\`.
2. Files are explicitly declared (not empty, not vague).
3. Rollback is named (commit, checkpoint, or \`git revert\`).
4. The plan's claims match the declared Task fields.
5. Nothing in lessons.md contradicts this plan.

Output EXACTLY one of these two formats as the LAST thing in your response. No preamble before the verdict line.

SIGNOFF: <one sentence on why the plan is safe>

or

REJECT: <one sentence on what is wrong>
FIX: <one sentence on what must change>
PROPOSED:
  Files: <concrete path list, or omit this line if original is fine>
  Exit: <sharp observable done condition, or omit this line if original is fine>
  Verify: <falsifiable shell command, or omit this line if original is fine>
  Rollback: <git revert <sha> or concrete checkpoint, or omit this line if original is fine>

Be a drafting partner, not just a critic. When you REJECT, write the PROPOSED block as a concrete draft the human can accept as-is, edit, or reject. Include each PROPOSED line only for fields that need changing; skip a line if the original is correct. Omit the entire PROPOSED block only if the rejection is about scope or intent rather than a draftable field.
`;
}

/**
 * Parse the validator's verdict line(s) from their output. Returns one of:
 *   { verdict: 'SIGNOFF', reason }
 *   { verdict: 'REJECT', reason, fix }
 * If neither format is present, treats it as a REJECT with a parse-fail reason.
 */
function parseVerdict(output) {
  const text = String(output || '');
  const rawLines = text.split('\n');
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  // Scan from the end backwards — the verdict is supposed to be LAST.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^SIGNOFF\s*:/i.test(line)) {
      return { verdict: 'SIGNOFF', reason: line.replace(/^SIGNOFF\s*:\s*/i, ''), fix: '', proposed: null };
    }
    if (/^REJECT\s*:/i.test(line)) {
      const reason = line.replace(/^REJECT\s*:\s*/i, '');
      // Fix line is usually immediately after REJECT.
      const tail = lines.slice(i);
      const fixLine = tail.find((l) => /^FIX\s*:/i.test(l));
      const fix = fixLine ? fixLine.replace(/^FIX\s*:\s*/i, '') : '';
      const proposed = parseProposedBlock(rawLines.slice(rawLines.findIndex((l) => /PROPOSED\s*:/i.test(l))));
      return { verdict: 'REJECT', reason, fix, proposed };
    }
  }
  return {
    verdict: 'REJECT',
    reason: 'validator output did not contain SIGNOFF or REJECT',
    fix: 'ensure validator emits machine-parseable verdict as the last line',
    proposed: null,
  };
}

/**
 * Parse the PROPOSED block: 4 optional indented fields (Files, Exit, Verify,
 * Rollback). Returns null if no block, or an object with only the fields the
 * validator chose to propose.
 */
function parseProposedBlock(lines) {
  if (!lines || !lines.length || !/PROPOSED\s*:/i.test(lines[0] || '')) return null;
  const proposed = {};
  const fieldMatchers = {
    files: /^\s*Files\s*:\s*(.+)$/i,
    exit: /^\s*Exit\s*:\s*(.+)$/i,
    verify: /^\s*Verify\s*:\s*(.+)$/i,
    rollback: /^\s*Rollback\s*:\s*(.+)$/i,
  };
  for (let j = 1; j < lines.length; j++) {
    const raw = lines[j];
    // Stop at a blank line or a new top-level marker (no leading whitespace
    // and a known verb). Keep scanning through indented lines.
    if (/^\S/.test(raw) && !/^(Files|Exit|Verify|Rollback)\s*:/i.test(raw)) break;
    for (const [key, matcher] of Object.entries(fieldMatchers)) {
      const m = raw.match(matcher);
      if (m) proposed[key] = m[1].trim();
    }
  }
  return Object.keys(proposed).length ? proposed : null;
}

/**
 * Default executor for plan-review: spawn a fresh claude -p call.
 * Kept thin so tests can inject a stub via options.planReviewExec.
 */
function defaultPlanReviewExecutor(prompt, { cwd, timeout = 180000 } = {}) {
  const tmpFile = path.join(cwd, '.autopilot-plan-review.tmp');
  fs.writeFileSync(tmpFile, prompt);
  try {
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Grep,Glob"`;
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const output = execPhaseCommandSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    return output || '';
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Default executor for codex: spawn `codex` with the prompt via stdin.
 * Users can override with ATRIS_CODEX_CMD env var; tests inject via options.codexExec.
 */
function defaultCodexExecutor(prompt, { cwd, timeout = 180000 } = {}) {
  const cmd = process.env.ATRIS_CODEX_CMD || 'codex';
  const proc = spawnSync(cmd, ['-p', prompt], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: 'pipe',
    maxBuffer: 10 * 1024 * 1024,
    detached: true,
  });
  // No sh wrapper here, but codex spawns its own children — sweep the group
  // on timeout so they cannot outlive the wall (same orphan class as the
  // claude sites; ESRCH means the tree is already dead).
  if (proc.pid && ((proc.error && proc.error.code === 'ETIMEDOUT') || proc.signal)) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch (sweepErr) {
      if (sweepErr.code !== 'ESRCH') throw sweepErr;
    }
  }
  if (proc.status !== 0 && !proc.stdout) {
    throw new Error(`codex exited with status ${proc.status}: ${proc.stderr || 'no output'}`);
  }
  return proc.stdout || '';
}

/**
 * Check if codex is available on PATH (or ATRIS_CODEX_CMD points to something runnable).
 * Kept simple: `which` probe. Tests override via options.hasCodex.
 */
function hasCodex() {
  const cmd = process.env.ATRIS_CODEX_CMD || 'codex';
  try {
    const r = spawnSync('which', [cmd], { stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run plan-review: the validator (and optionally codex) read the plan and
 * decide if it is safe to execute. Returns { verdict, reason, fix, signers, notes }.
 *
 * Codex is invoked only when the task explicitly opts in:
 *   - env ATRIS_USE_CODEX=1, or
 *   - context.tags includes 'codex', or
 *   - context.kind === 'endgame' AND context.tags includes 'gray' or 'high-risk'
 *
 * If codex is opted-in but not installed, we skip gracefully and surface a note.
 * If both signers run and disagree, verdict is REJECT with both opinions in reason.
 */
function runPlanReview({ cwd, context, planOutput, options = {} }) {
  const prompt = buildPlanReviewPrompt(context, planOutput);
  const tags = Array.isArray(context.tags) ? context.tags : [];

  // Primary signer: validator.
  const validatorExec = options.planReviewExec || defaultPlanReviewExecutor;
  const validatorOutput = validatorExec(prompt, { cwd, role: 'validator' });
  const primary = parseVerdict(validatorOutput);

  // Codex: opted in explicitly, not inferred.
  const codexOptIn =
    process.env.ATRIS_USE_CODEX === '1' ||
    tags.includes('codex') ||
    tags.includes('gray') ||
    tags.includes('high-risk');

  if (!codexOptIn) {
    return { ...primary, signers: ['validator'], proposed: primary.proposed || null };
  }

  const codexCheck = options.hasCodex != null ? options.hasCodex : hasCodex();
  if (!codexCheck) {
    return {
      ...primary,
      signers: ['validator'],
      proposed: primary.proposed || null,
      notes: 'codex was requested but not on PATH; skipped gracefully',
    };
  }

  const codexExec = options.codexExec || defaultCodexExecutor;
  let codexOutput;
  try {
    codexOutput = codexExec(prompt, { cwd, role: 'codex' });
  } catch (err) {
    return {
      ...primary,
      signers: ['validator'],
      notes: `codex invocation failed: ${err.message}; falling back to single signer`,
    };
  }
  const codex = parseVerdict(codexOutput);

  if (primary.verdict === 'SIGNOFF' && codex.verdict === 'SIGNOFF') {
    return {
      verdict: 'SIGNOFF',
      reason: primary.reason,
      fix: '',
      proposed: null,
      signers: ['validator', 'codex'],
    };
  }

  // Any disagreement or joint reject → halt with both opinions surfaced.
  // If either signer wrote a PROPOSED draft, surface the validator's first
  // (or codex's if validator didn't propose one).
  return {
    verdict: 'REJECT',
    reason: `Split verdict. validator=${primary.verdict} (${primary.reason || 'no reason'}); codex=${codex.verdict} (${codex.reason || 'no reason'}).`,
    fix: primary.fix || codex.fix || 'reconcile the two signers before re-planning',
    proposed: primary.proposed || codex.proposed || null,
    signers: ['validator', 'codex'],
    split: true,
  };
}

/**
 * Append a plan-review rejection to today's journal under ## Notes.
 * Intentionally does NOT write to lessons.md — rejections only become lessons
 * if a human spots a reusable failure pattern.
 */
function appendPlanRejection(cwd, context, review) {
  try {
    // Compute the journal path from the passed cwd so tests and isolated
    // workspaces both work. getLogPath() resolves against process.cwd()
    // which isn't always the task's workspace.
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const logFile = path.join(cwd, 'atris', 'logs', String(year), `${year}-${month}-${day}.md`);
    if (!fs.existsSync(logFile)) return;
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const signers = (review.signers || []).join(' + ');
    const proposedBlock = review.proposed
      ? `**Proposed draft:**\n` +
        (review.proposed.files ? `- Files: ${review.proposed.files}\n` : '') +
        (review.proposed.exit ? `- Exit: ${review.proposed.exit}\n` : '') +
        (review.proposed.verify ? `- Verify: ${review.proposed.verify}\n` : '') +
        (review.proposed.rollback ? `- Rollback: ${review.proposed.rollback}\n` : '')
      : '';
    const block =
      `\n### Plan rejected — ${now}\n\n` +
      `**Task:** ${context.task}\n` +
      `**Signers:** ${signers}\n` +
      `**Reason:** ${review.reason}\n` +
      (review.fix ? `**Fix:** ${review.fix}\n` : '') +
      (proposedBlock ? `${proposedBlock}` : '') +
      (review.notes ? `**Notes:** ${review.notes}\n` : '');
    let content = fs.readFileSync(logFile, 'utf8');
    const notesIdx = content.indexOf('## Notes');
    if (notesIdx === -1) {
      content = content.replace(/\s*$/, '') + `\n\n## Notes\n${block}\n`;
    } else {
      const eol = content.indexOf('\n', notesIdx);
      content = content.slice(0, eol + 1) + block + content.slice(eol + 1);
    }
    fs.writeFileSync(logFile, content);
  } catch {
    // journaling must never crash the tick
  }
}

// ── Timeout reconciliation (T33, endgame loop-self-repair) ─────────────────
// A do-phase wall-clock timeout kills the reporter, not the work: 12 of 13
// ETIMEDOUT halts in the 2026-06-10 RSI audit had real commits landed with no
// receipt, no checked bullet, and a human halt (lessons: executor-timeout-wall,
// tick-must-mark-own-bullet). These helpers let the tick reconcile from
// pre-tick HEADs instead of halting when work provably landed.

function todayJournalPath(cwd) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return {
    logFile: path.join(cwd, 'atris', 'logs', String(yyyy), `${yyyy}-${mm}-${dd}.md`),
    dateFormatted: `${yyyy}-${mm}-${dd}`,
  };
}

/**
 * Normalize text for fuzzy task-title matching: lowercase, strip code spans,
 * tags, and markdown punctuation down to single-spaced words.
 */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[[\w-]+\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * A word-boundary-truncated normalized prefix of the task title, used to find
 * the task's TODO bullet and journal receipts without exact-string fragility.
 */
function taskMatchNeedle(taskTitle, maxLen = 60) {
  const norm = normalizeForMatch(taskTitle);
  if (!norm) return '';
  if (norm.length <= maxLen) return norm;
  return norm.slice(0, maxLen).replace(/\s+\S*$/, '');
}

function gitHeadAt(dir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Snapshot HEAD of the workspace repo plus any sibling repos named in the
 * task text — both explicit `../atris-cli`-style refs (the journal convention)
 * and bare sibling-directory names like `atris-cli` that resolve to a git
 * repo next to cwd. Returns [{ label, dir, head }].
 */
function snapshotRepoHeads(cwd, taskText = '') {
  const root = path.resolve(cwd);
  const repos = new Map([[root, '.']]);
  const text = String(taskText || '');
  for (const ref of text.match(/\.\.\/[A-Za-z0-9._-]+/g) || []) {
    const dir = path.resolve(cwd, ref);
    if (dir !== root && fs.existsSync(path.join(dir, '.git'))) repos.set(dir, ref);
  }
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []) {
    const dir = path.resolve(cwd, '..', tok);
    if (dir !== root && !repos.has(dir) && fs.existsSync(path.join(dir, '.git'))) {
      repos.set(dir, `../${tok}`);
    }
  }
  return [...repos].map(([dir, label]) => ({ label, dir, head: gitHeadAt(dir) }));
}

/**
 * Re-read HEADs for a prior snapshot; return the repos whose HEAD advanced
 * as [{ label, dir, before, after }].
 */
function diffAdvancedRepoHeads(snapshot) {
  const advanced = [];
  for (const repo of snapshot || []) {
    if (!repo || !repo.head) continue;
    const after = gitHeadAt(repo.dir);
    if (after && after !== repo.head) {
      advanced.push({ label: repo.label, dir: repo.dir, before: repo.head, after });
    }
  }
  return advanced;
}

/**
 * The T31-typed do-phase timeout message thrown by executePhaseDetailed.
 * Plan/review timeouts stay human halts — only the do phase commits work
 * worth reconciling.
 */
function isDoPhaseTimeoutMessage(message) {
  return /\bdo phase timed out after\b/.test(String(message || ''));
}

/**
 * Mark the task's TODO bullet `[x]`. Matches the first un-checked,
 * un-struck bullet whose normalized text contains the normalized title
 * prefix; `- **T33:** …` becomes `- [x] **T33:** …`, `- [ ]` becomes `- [x]`.
 * Returns true if a bullet was marked.
 */
function markTodoBulletDone(cwd, taskTitle) {
  const needle = taskMatchNeedle(taskTitle);
  if (!needle) return false;
  for (const name of ['TODO.md', 'todo.md']) {
    const todoPath = path.join(cwd, 'atris', name);
    if (!fs.existsSync(todoPath)) continue;
    const lines = fs.readFileSync(todoPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const bullet = lines[i].match(/^(\s*)- (?:\[( |x)\]\s+)?(.*)$/);
      if (!bullet) continue;
      if (bullet[2] === 'x') continue;
      if (bullet[3].startsWith('~~')) continue;
      if (!normalizeForMatch(lines[i]).includes(needle)) continue;
      lines[i] = `${bullet[1]}- [x] ${bullet[3]}`;
      fs.writeFileSync(todoPath, lines.join('\n'));
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Append a block under today's journal `## Notes`, creating the journal file
 * if the tick dies before any other writer got to it. Never throws.
 */
function appendUnderNotes(cwd, block) {
  try {
    const { logFile, dateFormatted } = todayJournalPath(cwd);
    if (!fs.existsSync(logFile)) {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      createLogFile(logFile, dateFormatted);
    }
    let content = fs.readFileSync(logFile, 'utf8');
    const notesIdx = content.indexOf('## Notes');
    if (notesIdx === -1) {
      content = content.replace(/\s*$/, '') + `\n\n## Notes\n${block}\n`;
    } else {
      const eol = content.indexOf('\n', notesIdx);
      content = content.slice(0, eol + 1) + block + content.slice(eol + 1);
    }
    fs.writeFileSync(logFile, content);
    return true;
  } catch {
    return false;
  }
}

function appendTimeoutReconciliation(cwd, { task, advanced }) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const repoLines = (advanced || [])
    .map((r) => `- ${r.label}: ${String(r.before).slice(0, 7)} → ${String(r.after).slice(0, 7)}`)
    .join('\n');
  const block =
    `\n### Timeout reconciliation — ${now} — work-landed-receipt-died\n\n` +
    `**Task:** ${task}\n` +
    `**What happened:** the do-phase wall killed the reporter, but commits landed:\n` +
    `${repoLines}\n` +
    `Receipt auto-written and the TODO bullet marked; no human halt required.\n`;
  return appendUnderNotes(cwd, block);
}

function appendCheckAndAdvance(cwd, task, receiptLine) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block =
    `\n### Check-and-advance — ${now} — advanced-already-done\n\n` +
    `**Task:** ${task}\n` +
    `**What happened:** verify passed before work started AND today's journal already carries a completion receipt — the work shipped on a prior tick whose reporter died before bookkeeping. Bullet marked, picker advanced.\n` +
    `**Receipt:** ${receiptLine}\n`;
  return appendUnderNotes(cwd, block);
}

/**
 * Scan today's journal for a completion receipt naming the task: a `C#`
 * completed line, a timeout-reconciliation entry, or a `**Task:**` line.
 * Returns the matching line, or null.
 */
function findCompletionReceipt(cwd, taskTitle) {
  const { logFile } = todayJournalPath(cwd);
  if (!fs.existsSync(logFile)) return null;
  const needle = taskMatchNeedle(taskTitle);
  if (!needle) return null;
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    const receiptShaped =
      /\*\*C\d+:\*\*/.test(line) || /\*\*Task:\*\*/.test(line) || /reconciliation/i.test(line);
    if (receiptShaped && normalizeForMatch(line).includes(needle)) return line.trim();
  }
  return null;
}

/**
 * After a do-phase timeout: diff the pre-tick HEAD snapshot. If commits
 * landed, write the journal reconciliation receipt, mark the TODO bullet, and
 * report outcome `work-landed-receipt-died`. If nothing landed, the caller
 * halts exactly as before.
 */
function reconcileTimedOutTick(cwd, snapshot, taskTitle) {
  const advanced = diffAdvancedRepoHeads(snapshot);
  if (advanced.length === 0) return { reconciled: false, advanced: [] };
  appendTimeoutReconciliation(cwd, { task: taskTitle, advanced });
  const bulletMarked = markTodoBulletDone(cwd, taskTitle);
  return { reconciled: true, outcome: 'work-landed-receipt-died', advanced, bulletMarked };
}

function runTaskOnce(context, options = {}) {
  const { verbose = false, cwd = process.cwd() } = options;

  // Judge integrity check — halt if computeTickReward was tampered with
  const integrity = verifyJudgeIntegrity();
  if (!integrity.ok) {
    writeLesson(cwd, 'judge-corruption', 'fail',
      `computeTickReward checksum mismatch. Expected ${integrity.expected}, got ${integrity.actual}. Tick halted.`);
    return {
      outcome: 'halted',
      reason: 'judge-corruption',
      phaseResults: {},
      elapsedSeconds: 0,
      verifyRan: false,
      verifyPass: false,
    };
  }

  const phaseResults = {};
  const startedAt = Date.now();
  let verifyResult = getVerifyCommand(cwd, context.task);
  let verifyCmd = verifyResult.cmd;
  const explicitVerifyBefore = new Set(
    collectExplicitVerifyTasks(cwd).map((task) => task.key)
  );
  const initialVerifyShape = validateVerifyCommandShape(verifyCmd);
  if (!initialVerifyShape.ok) {
    return haltInvalidVerify(cwd, context, verifyCmd, initialVerifyShape.reason, startedAt, phaseResults);
  }

  // Guard: endgame tasks must have an explicit Verify field.
  // Reactive signals (inbox, staleness, imagined) use npm test as default.
  if (!verifyResult.explicit && context.kind === 'endgame') {
    writeLesson(cwd, 'no-verify-field', 'fail',
      `Task "${context.task}" has no explicit **Verify:** field in TODO.md. Tick halted — every endgame task must declare how to verify it.`);
    return {
      outcome: 'halted',
      reason: 'no-verify-field',
      phaseResults: {},
      elapsedSeconds: 0,
      verifyRan: false,
      verifyPass: false,
    };
  }

  // Falsifiability gate (endgame + explicit Verify only).
  // Run Verify BEFORE the work. If it passes, the rubric is trivial or the
  // task is already done — either way, halt. This is the keystone that makes
  // Verify load-bearing. The cmd is captured here and reused post-execute so
  // an agent cannot swap the rubric mid-tick.
  //
  // Timeout: 300s. Many endgame Verify clauses chain a fast-suite run
  // (test_fast.sh ~60s) plus extra assertions. At 60s the gate timed out
  // before the chain could finish, the catch branch labeled it "falsifiable",
  // and the loop executed already-done work. 300s lets the standard
  // pytest+fast-suite shape complete cleanly.
  const skipFalsifiability = options.skipFalsifiability === true;
  if (!skipFalsifiability && verifyResult.explicit && context.kind === 'endgame' && verifyCmd) {
    try {
      execSync(verifyCmd, { cwd, stdio: 'pipe', timeout: 300000 });
      // T33b (lesson: tick-must-mark-own-bullet): a pre-work verify pass WITH
      // a completion receipt already in today's journal means the work shipped
      // but the reporter died before bookkeeping. Check the bullet and advance
      // instead of wedging the picker on verify-not-falsifiable.
      const receipt = findCompletionReceipt(cwd, context.task);
      if (receipt) {
        const bulletMarked = markTodoBulletDone(cwd, context.task);
        appendCheckAndAdvance(cwd, context.task, receipt);
        return {
          outcome: 'advanced-already-done',
          reason: 'advanced-already-done',
          receipt,
          bulletMarked,
          phaseResults: {},
          elapsedSeconds: 0,
          verifyRan: true,
          verifyPass: true,
        };
      }
      writeLesson(cwd, 'verify-not-falsifiable', 'fail',
        `Verify \`${verifyCmd}\` passed before work started on "${context.task}". Either the rubric is trivial or the task is already done. Tick halted.`);
      return {
        outcome: 'halted',
        reason: 'verify-not-falsifiable',
        phaseResults: {},
        elapsedSeconds: 0,
        verifyRan: true,
        verifyPass: false,
      };
    } catch {
      // Pre-verify failed — good, the rubric is falsifiable. Proceed.
    }
  }

  // Phase: plan
  {
    const t0 = Date.now();
    const result = (options.phaseExec || executePhaseDetailed)('plan', context, options);
    phaseResults.plan = {
      prompt: result.prompt,
      output: result.output || '',
      elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    };
  }

  // Phase: plan-review — validator reads the plan fresh and signs off or rejects.
  // Can be skipped via options.skipPlanReview (tests only). Codex is optional,
  // opt-in via env var / tags. On REJECT, the tick halts and the rejection is
  // journaled; lessons.md is NOT touched (only promoted lessons go there).
  if (!options.skipPlanReview) {
    const t0 = Date.now();
    const review = runPlanReview({
      cwd,
      context,
      planOutput: phaseResults.plan.output,
      options,
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    phaseResults['plan-review'] = {
      output:
        `${review.verdict}: ${review.reason || ''}` +
        (review.fix ? `\nFIX: ${review.fix}` : '') +
        (review.notes ? `\n(${review.notes})` : ''),
      signers: review.signers,
      elapsedSeconds: elapsed,
    };

    if (review.verdict === 'REJECT') {
      appendPlanRejection(cwd, context, review);
      return {
        outcome: 'halted',
        reason: 'plan-rejected-at-review',
        phaseResults,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        verifyRan: false,
        verifyPass: false,
      };
    }
  }

  if (!verifyResult.explicit && shouldAdoptPlannedVerify(context.kind)) {
    const plannedVerify = findNewExplicitVerifyCommand(cwd, explicitVerifyBefore);
    if (plannedVerify) {
      verifyResult = plannedVerify;
      verifyCmd = plannedVerify.cmd;
    }
  }
  const plannedVerifyShape = validateVerifyCommandShape(verifyCmd);
  if (!plannedVerifyShape.ok) {
    return haltInvalidVerify(cwd, context, verifyCmd, plannedVerifyShape.reason, startedAt, phaseResults);
  }

  // Phase: do
  {
    const t0 = Date.now();
    const result = (options.phaseExec || executePhaseDetailed)('do', context, options);
    phaseResults.do = {
      prompt: result.prompt,
      output: result.output || '',
      elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    };
  }

  // Phase: review
  {
    const t0 = Date.now();
    const result = (options.phaseExec || executePhaseDetailed)('review', context, options);
    phaseResults.review = {
      prompt: result.prompt,
      output: result.output || '',
      elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    };
  }

  const reviewOutput = phaseResults.review.output || '';

  // After review succeeds, run verify command if present
  let verifyPass = false;
  let verifyRan = false;
  if (verifyCmd) {
    verifyRan = true;
    let t0 = Date.now();
    try {
      execSync(verifyCmd, { cwd, stdio: 'pipe' });
      verifyPass = true;
      const verifyTime = Math.round((Date.now() - t0) / 1000);
      phaseResults.verify = {
        output: `Verify passed (${verifyTime}s)`,
        elapsedSeconds: verifyTime,
      };
    } catch (e) {
      const verifyTime = Math.round((Date.now() - t0) / 1000);
      phaseResults.verify = {
        output: `Verify failed: ${e.message}`,
        elapsedSeconds: verifyTime,
      };
      try {
        const slug = lessonSlug(context.task);
        writeLesson(cwd, `verify-fail-${slug}`, 'fail', `Verify command \`${verifyCmd}\` failed: ${e.message.split('\n')[0]}`);
      } catch { /* lesson write must not crash the tick */ }
    }
  }

  return {
    success: verifyRan && verifyPass,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    phaseResults,
    reviewOutput,
    verifyCmd,
    verifyPass,
    verifyRan,
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
 *   - verify passed: +3
 *   - npm test passed: +2
 *   - validator clean (review passed): +1
 *   - halt caught hallucination: -3
 */
function computeTickReward(execution, tickOutcome, verifyCmd) {
  let reward = 0;

  // Validator clean: review passed without 'failed'
  if (!execution.reviewOutput || !execution.reviewOutput.includes('failed')) {
    reward += REWARD_CONFIG.REVIEW_CLEAN;
  }

  // Verify passed
  if (execution.verifyRan && execution.verifyPass) {
    reward += REWARD_CONFIG.VERIFY_PASS;
  }

  // npm test passed
  if (execution.verifyRan && execution.verifyPass && verifyCmd === 'npm test') {
    reward += REWARD_CONFIG.NPM_TEST_BONUS;
  }

  // Commit landed: check do phase output for git commit patterns
  const doOutput = execution.phaseResults.do.output || '';
  if (doOutput.match(/\[.*\s\d+\sfile.*changed/i) || doOutput.includes('git commit') || doOutput.includes('committed')) {
    reward += REWARD_CONFIG.COMMIT_LANDED;
  }

  // Halt caught hallucination
  if (tickOutcome === 'halted') {
    reward += REWARD_CONFIG.HALT_PENALTY;
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
 * Read the current endgame state from atris/TODO.md.
 */
function readEndgameState(cwd) {
  try {
    const todoPath = path.join(cwd, 'atris', 'TODO.md');
    if (!fs.existsSync(todoPath)) {
      return { slug: 'unset', pickedAt: null, horizon: '', remaining: 0, completed: 0 };
    }

    const todo = parseTodo(todoPath);
    const content = fs.readFileSync(todoPath, 'utf8');
    const endgameMatch = content.match(/##\s+Endgame\s*\n([\s\S]*?)(?=\n##|$)/);
    const section = endgameMatch ? endgameMatch[1] : '';
    const slugMatch = section.match(/\*\*Slug:\*\*\s*(\S+)/);
    const pickedMatch = section.match(/\*\*Picked:\*\*\s*(.+)/);
    const horizonMatch = section.match(/\*\*Horizon:\*\*\s*(.+)/);

    return {
      slug: slugMatch ? slugMatch[1].trim() : 'unset',
      pickedAt: pickedMatch ? pickedMatch[1].trim() : null,
      horizon: horizonMatch ? horizonMatch[1].trim() : '',
      remaining: todo.backlog.filter(t => t.tag === 'endgame').length
        + todo.inProgress.filter(t => t.tag === 'endgame').length
        + (todo.review || []).filter(t => t.tag === 'endgame').length,
      completed: todo.completed.filter(t => t.tag === 'endgame').length,
    };
  } catch {
    return { slug: 'unset', pickedAt: null, horizon: '', remaining: 0, completed: 0 };
  }
}

function readHorizonSlug(cwd) {
  return readEndgameState(cwd).slug;
}

function maybeWriteCompletedEndgameScorecard(cwd, startingEndgame) {
  if (!startingEndgame || startingEndgame.slug === 'unset' || startingEndgame.remaining === 0) {
    return false;
  }

  const atrisDir = path.join(cwd, 'atris');
  if (!fs.existsSync(atrisDir)) return false;

  const { complete, endgameSlug } = detectEndgameCompletion(atrisDir);
  if (!complete || endgameSlug !== startingEndgame.slug) return false;

  const alreadyWritten = readScorecards(atrisDir).some(sc => sc.slug === endgameSlug);
  if (alreadyWritten) return false;

  const data = buildScorecardData(atrisDir, {
    slug: endgameSlug,
    pickedAt: startingEndgame.pickedAt,
  });
  writeScorecard(atrisDir, data);
  return true;
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

  const endgame = readEndgameState(cwd);
  const slug = endgame.slug === 'unset' ? '(no endgame active — feed inbox or /endgame)' : endgame.slug;
  const horizon = endgame.horizon;
  const remaining = endgame.remaining;
  const completedEndgame = endgame.completed;

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
 * reward per type, scores candidates by expected value.
 *
 * Adaptive explore rate: if the last 5 endgames are all the same type,
 * explore rate boosts to 50%. Otherwise scales between 20%-50% based on
 * type repetition in the last 5.
 *
 * Difficulty floor: candidates whose inferred type has >80% success rate
 * AND mean reward >5 are filtered out when harder candidates exist, so
 * easy wins don't starve hard work.
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
    const typeToAttempts = {}; // track shipped/attempted per type
    for (const sc of scorecards) {
      const type = sc.slug.split('-')[0];
      if (!typeToRewards[type]) typeToRewards[type] = [];
      typeToRewards[type].push(sc.totalReward);
      if (!typeToAttempts[type]) typeToAttempts[type] = { shipped: 0, attempted: 0 };
      typeToAttempts[type].shipped += sc.tasksShipped;
      typeToAttempts[type].attempted += sc.tasksAttempted;
    }

    // Calculate mean reward per type
    const typeMeans = {};
    for (const [type, rewards] of Object.entries(typeToRewards)) {
      const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
      typeMeans[type] = mean;
    }

    // Calculate success rate per type
    const typeSuccessRate = {};
    for (const [type, counts] of Object.entries(typeToAttempts)) {
      typeSuccessRate[type] = counts.attempted > 0 ? counts.shipped / counts.attempted : 0;
    }

    // Adaptive explore rate based on diversity of last 5 scorecards
    const last5 = scorecards.slice(-5);
    const last5Types = last5.map(sc => sc.slug.split('-')[0]);
    const uniqueTypes = new Set(last5Types).size;
    // All same type → exploreRate=0.5; all different → exploreRate=0.2
    // Linear interpolation: exploreRate = 0.5 - (uniqueTypes - 1) * 0.3 / (last5Types.length - 1 || 1)
    const maxTypes = last5Types.length;
    const exploreRate = maxTypes <= 1
      ? 0.2
      : 0.5 - (uniqueTypes - 1) * 0.3 / (maxTypes - 1);

    // Score each candidate by expected value based on historical type mean
    const scored = candidates.map(c => {
      // Infer type from title keywords that match scorecard slug prefixes
      const titleLower = (c.title || '').toLowerCase();
      const cType = Object.keys(typeMeans).find(t => titleLower.includes(t)) || titleLower.split(/[\s\-]+/)[0];
      const historicalMean = typeMeans[cType] !== undefined ? typeMeans[cType] : 0;
      const successRate = typeSuccessRate[cType] !== undefined ? typeSuccessRate[cType] : 0;
      const expectedValue = historicalMean * c.confidence;
      return {
        ...c,
        expectedValue,
        type: cType,
        historicalMean,
        successRate
      };
    });

    // Difficulty floor: filter out easy-win candidates (>80% success rate AND
    // mean reward >5) when harder candidates exist
    const hardCandidates = scored.filter(c => !(c.successRate > 0.8 && c.historicalMean > 5));
    const pool = hardCandidates.length > 0 ? hardCandidates : scored;

    // Sort by expected value (descending)
    pool.sort((a, b) => b.expectedValue - a.expectedValue);

    // Adaptive exploit/explore split
    const choice = Math.random();
    let selected;
    if (choice < (1 - exploreRate)) {
      // Exploit: return highest expected value
      selected = pool[0];
    } else {
      // Explore: return random candidate from full scored list (not filtered)
      selected = scored[Math.floor(Math.random() * scored.length)];
    }

    const reason = choice < (1 - exploreRate)
      ? `exploit: type=${selected.type} mean-reward=${selected.historicalMean.toFixed(1)} expected-value=${selected.expectedValue.toFixed(1)} explore-rate=${exploreRate.toFixed(2)}`
      : `explore: random-candidate type=${selected.type} explore-rate=${exploreRate.toFixed(2)}`;

    return {
      title: selected.title,
      confidence: selected.confidence,
      rationale: selected.rationale,
      scored: true,
      reason,
      exploreRate
    };
  } catch (err) {
    // If scoring fails, fall back to best by confidence
    const best = candidates.reduce((a, b) => (a.confidence > b.confidence ? a : b), candidates[0]);
    return { ...best, scored: false, reason: `scoring error: ${err.message}` };
  }
}

/**
 * Proactive "surprise me" scanner — surfaces things the user didn't ask about.
 * Returns an array of suggestion objects in the same shape as the reactive
 * signals in suggestNextTask. Three orthogonal checks, none requiring
 * cross-session state:
 *   - orphan-todo: `// TODO` or `// FIXME` in source with no matching backlog item
 *   - unverified-detector: typed lesson has a detector but no last_detected stamp
 *   - hotspot: file with >5 git commits in last 24h (churn signal)
 *
 * Each suggestion includes a `skipKey` so dry-run / skip doesn't re-fire it.
 */
function scanAnomalies(cwd) {
  const results = [];
  const atrisDir = path.join(cwd, 'atris');

  // --- orphan-todo: code TODOs not tracked in TODO.md backlog ---
  try {
    const codeTodos = findCodeTodos(cwd);
    if (codeTodos.length > 0) {
      const todoFile = path.join(atrisDir, 'TODO.md');
      const backlogText = fs.existsSync(todoFile) ? fs.readFileSync(todoFile, 'utf8') : '';
      const untracked = codeTodos.filter(t => !isTodoTracked(t.text, backlogText));
      if (untracked.length > 0) {
        const first = untracked[0];
        const sample = untracked.slice(0, 3).map(t => `${t.file}:${t.line}`).join(', ');
        const firstText = first.text.slice(0, 60);
        results.push({
          task: `Track the ${untracked.length} orphan TODO${untracked.length > 1 ? 's' : ''} in source — first: "${firstText}"`,
          why: `Code has ${untracked.length} \`// TODO\`/\`// FIXME\` comment${untracked.length > 1 ? 's' : ''} never written to TODO.md. First: "${firstText}" (${sample}). Either convert to real tasks or delete if obsolete.`,
          kind: 'orphan-todo',
          priority: 6,
          skipKey: 'orphan-todo'
        });
      }
    }
  } catch { /* best-effort scan */ }

  // --- unverified-detector: lesson has detector but last_detected missing/stale ---
  try {
    const meta = loadLessonMetadata(cwd);
    const unverified = [];
    for (const [slug, entry] of Object.entries(meta)) {
      if (slug === '_schema') continue;
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.detector) continue;
      if (!entry.last_detected) unverified.push(slug);
    }
    if (unverified.length > 0) {
      results.push({
        task: `Run the ${unverified.length} unverified detector${unverified.length > 1 ? 's' : ''} in atris/lessons.json`,
        why: `These lessons claim they're resolved via a detector but the detector has never been run: ${unverified.slice(0, 3).join(', ')}${unverified.length > 3 ? ', …' : ''}. Until it runs and exits 0, the resolved claim is unverified.`,
        kind: 'unverified-detector',
        priority: 5.5,
        skipKey: 'unverified-detector'
      });
    }
  } catch { /* best-effort */ }

  // --- hotspot: file with high churn in last 24h ---
  try {
    const hotspot = findHotspot(cwd);
    if (hotspot) {
      results.push({
        task: `Pause and review ${hotspot.file} — ${hotspot.commits} commits in the last 24h`,
        why: `That file has churned more than any other file today. Could be genuine progress or a sign the change isn't sticking. Worth reading the diff before continuing.`,
        kind: 'hotspot',
        priority: 6.5,
        skipKey: `hotspot:${hotspot.file}`
      });
    }
  } catch { /* best-effort */ }

  return results;
}

/**
 * Grep source code for TODO/FIXME comments. Skips test/, node_modules/,
 * atris/, and .md files. Returns [{file, line, text}].
 *
 * Uses a loose grep then filters to real comment prefixes in JS — git grep's
 * -E flag doesn't support `\s` on macOS, so we keep the pattern simple and
 * refine post-hoc.
 */
function findCodeTodos(cwd) {
  try {
    const out = execFileSync('git', [
      'grep', '-n', '-I', '-E', '(TODO|FIXME)',
      '--', ':!test/', ':!node_modules/', ':!atris/', ':!**/_archive/**', ':!**/*.md'
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const results = [];
    for (const raw of out.split('\n').filter(Boolean)) {
      const m = raw.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      if (m[1].split(/[\\/]/).includes('_archive')) continue;
      const line = m[3];
      // A real TODO is a comment marker at the start of the line (allowing
      // leading indent) followed by TODO/FIXME and at least one word. This
      // rejects "TODO.md" string literals in templates (init.js:398 style).
      const commentMatch = line.match(/^\s*(?:\/\/|#|\/\*|\*)\s*(TODO|FIXME):?\s+(\S.*)/);
      if (!commentMatch) continue;
      const text = commentMatch[2].replace(/\*\/\s*$/, '').trim();
      if (!text) continue;
      results.push({ file: m[1], line: parseInt(m[2], 10), text });
      if (results.length >= 100) break;
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Heuristic: is a code TODO text substring already mentioned in the backlog?
 * We check for significant words (>=4 chars) overlap. At least 2 must match.
 */
function isTodoTracked(todoText, backlogText) {
  if (!todoText || !backlogText) return false;
  const significantWords = todoText
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length >= 4 && !['todo', 'fixme', 'this', 'that', 'with', 'from', 'when', 'then'].includes(w));
  if (significantWords.length === 0) return false;
  const lowerBacklog = backlogText.toLowerCase();
  const matches = significantWords.filter(w => lowerBacklog.includes(w)).length;
  return matches >= Math.min(2, significantWords.length);
}

/**
 * Find the file with the most commits in the last 24 hours. Returns null if
 * no file has more than 5 commits (below the "hotspot" threshold).
 */
function findHotspot(cwd) {
  try {
    const out = execFileSync('git', [
      'log', '--since=24.hours.ago', '--name-only', '--pretty=format:'
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const counts = {};
    for (const f of out.split('\n').map(s => s.trim()).filter(Boolean)) {
      counts[f] = (counts[f] || 0) + 1;
    }
    let best = null;
    for (const [file, commits] of Object.entries(counts)) {
      if (commits < 6) continue;
      if (!best || commits > best.commits) best = { file, commits };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Write `status: attempted` back to the typed lesson sidecar for a slug when
 * a self-heal tick tried and failed. Increments `attempts`, stamps
 * `last_attempt` (YYYY-MM-DD) and `last_attempt_reason`. Creates the sidecar
 * (and the slug entry) if missing.
 *
 * This closes the survivorship-bias loop the oracle flagged: without this,
 * the ledger only records fixes that worked, never the ones that didn't.
 *
 * @returns {boolean} true on success, false on malformed sidecar or write error
 */
function markLessonAttempted(cwd, slug, reason) {
  if (!slug || typeof slug !== 'string') return false;
  const metaPath = path.join(cwd, 'atris', 'lessons.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return false; }
  }
  if (!meta[slug] || typeof meta[slug] !== 'object') meta[slug] = {};
  meta[slug].status = 'attempted';
  meta[slug].attempts = (typeof meta[slug].attempts === 'number' ? meta[slug].attempts : 0) + 1;
  meta[slug].last_attempt = new Date().toISOString().slice(0, 10);
  if (reason) meta[slug].last_attempt_reason = String(reason);
  try {
    const atrisDir = path.join(cwd, 'atris');
    if (!fs.existsSync(atrisDir)) fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/**
 * Load the typed lesson metadata sidecar (atris/lessons.json).
 * Keyed by slug. Each entry may carry: scope, applies_to, detector, status.
 * Missing file or parse errors → empty object (prose-only fallback).
 */
function loadLessonMetadata(cwd) {
  const metaPath = path.join(cwd, 'atris', 'lessons.json');
  if (!fs.existsSync(metaPath)) return {};
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse atris/lessons.md into structured lesson objects, joined with the
 * optional atris/lessons.json sidecar by slug. Returns an array of:
 *   { id, date, verdict, body, line, resolvedTag, meta, legacy }
 * where `legacy` is true when no sidecar metadata exists for the slug.
 */
function parseLessons(cwd) {
  const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
  if (!fs.existsSync(lessonsPath)) return [];
  const content = fs.readFileSync(lessonsPath, 'utf8');
  const metadata = loadLessonMetadata(cwd);

  const out = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine;
    if (!line.trim().startsWith('- **[')) continue;
    const m = line.match(/\*\*\[(\d{4}-\d{2}-\d{2})\]\s+([\w-]+)\*\*\s*[—-]\s*(pass|fail)?\s*[—-]?\s*(.*)$/);
    if (!m) continue;
    const [, date, id, verdict, rest] = m;
    const resolvedTag = /\[resolved\]/.test(rest);
    const body = rest.replace(/^\[resolved\]\s*/, '').trim();
    const meta = metadata[id] || null;
    out.push({
      id,
      date,
      verdict: verdict || null,
      body,
      line: line.trim(),
      resolvedTag,
      meta,
      legacy: !meta
    });
  }
  return out;
}

/**
 * Run a lesson's detector command. Returns true if the detector exits 0,
 * false otherwise (non-zero exit, timeout, spawn error).
 * execFileSync is intentionally avoided for detectors because they may
 * legitimately shell out (e.g. `node --test path | grep X`).
 */
function runLessonDetector(detector, cwd, timeoutMs = 60000) {
  if (!detector || typeof detector !== 'string') return false;
  try {
    execSync(detector, { cwd, stdio: 'pipe', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a lesson's bug pattern is still present in the named files.
 *
 * Detector-backed path (preferred): if sidecar metadata has `detector`, run it.
 *   exit 0 → resolved (true). non-zero → not resolved (false).
 *
 * Legacy path (fallback): parse the lesson line for file paths + slug keywords
 * and grep. If no keyword matches any named file → resolved (true).
 *
 * @param {string} lessonLine - A single line from lessons.md
 * @param {string} cwd - Current working directory
 * @param {object} [options] - Optional pre-loaded metadata ({ meta, detectorTimeout })
 * @returns {boolean} true if the bug pattern is gone (resolved)
 */
function isLessonResolved(lessonLine, cwd, options = {}) {
  const slugMatch = lessonLine.match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+([\w-]+)\*\*/);
  if (!slugMatch) return false;
  const slug = slugMatch[1];

  if (isCleanMapBrokenRefFailLesson(lessonLine, cwd)) return true;

  // Detector-backed check (typed lesson sidecar)
  const meta = options.meta || loadLessonMetadata(cwd)[slug];
  if (meta && meta.detector) {
    return runLessonDetector(meta.detector, cwd, options.detectorTimeout);
  }

  if (inlinePythonVerifyFailureNowPasses(lessonLine, cwd, options.detectorTimeout)) return true;

  // Legacy fallback: keyword grep against referenced files.
  return isLessonResolvedLegacy(lessonLine, cwd);
}

function isCleanMapBrokenRefFailLesson(lessonLine, cwd) {
  const text = String(lessonLine || '').toLowerCase();
  if (!/fix \d+ broken references? in map\.md/.test(text)) return false;
  return repoMapAuditReportsClean(cwd);
}

function extractInlinePythonVerifyFailure(lessonLine) {
  const commandMatch = String(lessonLine || '').match(/Verify command\s+``([\s\S]*?)``\s+failed/i);
  if (!commandMatch) return null;
  const matches = [...commandMatch[1].matchAll(/\b(python3?)\s+-c\s+(["'])([\s\S]*?)\2/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  return {
    executable: match[1],
    code: match[3].replace(/\\"/g, '"').replace(/\\'/g, "'")
  };
}

function inlinePythonVerifyFailureNowPasses(lessonLine, cwd, timeout = 10000) {
  const parsed = extractInlinePythonVerifyFailure(lessonLine);
  if (!parsed) return false;
  const result = spawnSync(parsed.executable, ['-c', parsed.code], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  return result.status === 0;
}

function legacyLessonFileRefs(lessonLine) {
  const fileRefs = [];
  const filePattern = /`([a-zA-Z0-9_/./-]+\.[a-zA-Z]+(?::\d+(?:-\d+)?)?)`/g;
  let m;
  while ((m = filePattern.exec(lessonLine)) !== null) {
    const ref = m[1].replace(/:\d+(-\d+)?$/, '');
    if (ref.includes('/') || ref.endsWith('.js') || ref.endsWith('.md') || ref.endsWith('.ts')) {
      fileRefs.push(ref);
    }
  }
  return fileRefs;
}

/**
 * The pre-v3.8 resolver — kept as an internal fallback for prose-only lessons
 * that don't have detector metadata yet. Never auto-promotes a prose lesson to
 * resolved in the typed system (callers can still use the `resolvedTag` field
 * from parseLessons for hand-tagged entries).
 */
function isLessonResolvedLegacy(lessonLine, cwd) {
  // Extract slug: bold text after date, e.g. **[2026-04-08] inbox-parser-eats-hr-separator**
  const slugMatch = lessonLine.match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+([\w-]+)\*\*/);
  if (!slugMatch) return false;
  const slug = slugMatch[1];

  const fileRefs = legacyLessonFileRefs(lessonLine);

  if (fileRefs.length === 0) return false;

  // Derive keywords from slug (split on dashes, drop short words)
  const keywords = slug.split('-').filter(w => w.length > 2);
  if (keywords.length === 0) return false;

  // Grep each named file for any keyword. If at least one file still matches → not resolved.
  for (const ref of fileRefs) {
    const absPath = path.isAbsolute(ref) ? ref : path.join(cwd, ref);
    if (!fs.existsSync(absPath)) continue; // file deleted = pattern gone
    for (const kw of keywords) {
      try {
        execFileSync('grep', ['-q', '-i', kw, absPath], {
          cwd,
          timeout: 5000,
          stdio: ['ignore', 'ignore', 'ignore']
        });
        // grep exited 0 → keyword found → lesson still applies
        return false;
      } catch {
        // grep exited non-zero → keyword not found in this file, continue
      }
    }
  }

  // No keyword matched in any named file → lesson is resolved
  return true;
}

/**
 * Pick the oldest unresolved `fail` lesson whose bug pattern is still present.
 * Returns { date, slug, line } for the top candidate, or null if none.
 *
 * Self-healing seed: instead of imagining new horizons via LLM, use what the
 * system already wrote down about itself. A `fail` lesson with `isLessonResolved
 * === false` means grep confirms the bug pattern is still present — actionable.
 */
/**
 * Returns true if a recent (within `windowDays`) `verify-not-falsifiable`
 * lesson references this exact task title. The falsifiability gate halts the
 * tick when the Verify clause already passes before work starts (task is
 * already shipped or rubric is trivial), but nothing in TODO.md changes —
 * so the next tick re-picks the same task and burns another 90s+ halting in
 * the same place. Reading the lesson log breaks the loop without requiring
 * a TODO.md hand-edit (which is the structurally-broken file we route around
 * per feedback_todo_md_is_the_problem).
 */
function hasRecentVerifyPrePass(cwd, taskTitle, windowDays = 7) {
  if (!taskTitle) return false;
  const lessons = parseLessons(cwd);
  if (lessons.length === 0) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffDate = cutoff.toISOString().split('T')[0];
  const needle = `"${taskTitle}"`;
  for (const l of lessons) {
    if (l.id !== 'verify-not-falsifiable') continue;
    if (l.date < cutoffDate) continue;
    if (l.body.includes(needle)) return true;
  }
  return false;
}

function shouldSkipEndgameAtPicker(cwd, task) {
  if (!task || task.tag !== 'endgame') return false;
  // Endgame tasks must declare an explicit **Verify:** field. runTaskOnce would
  // halt them, so the picker must not downgrade them into generic backlog work.
  if (!task.verify) return true;
  // If Verify already passed before work started recently, the task is already
  // shipped or the rubric is trivial. Keep it out of all picker paths.
  return hasRecentVerifyPrePass(cwd, task.title);
}

function pickUnresolvedFailLesson(cwd) {
  const lessons = parseLessons(cwd);
  if (lessons.length === 0) return null;

  const MAX_ATTEMPTS = 3;
  const candidates = [];
  for (const lesson of lessons) {
    if (lesson.verdict !== 'fail') continue;
    if (lesson.id === 'verify-not-falsifiable') continue;
    if (lesson.id === 'no-verify-field') continue;
    if (lesson.id === 'verify-failed' && lesson.legacy) continue;
    if (lesson.resolvedTag) continue;
    // Typed lesson with explicit status wins — respect the sidecar.
    // `resolved` = done. `observed` = process rule, not a fixable code state.
    // `attempted` with attempts >= MAX_ATTEMPTS = needs human re-scoping, skip.
    // Only `open` and `attempted` (under the cap) flow to self-heal execution.
    if (lesson.meta && lesson.meta.status) {
      const s = lesson.meta.status;
      if (s === 'resolved' || s === 'observed') continue;
      if (s === 'attempted' && (lesson.meta.attempts || 0) >= MAX_ATTEMPTS) continue;
    }
    if (lesson.legacy && legacyLessonFileRefs(lesson.line).length === 0) continue;
    // Detector-backed or legacy grep check.
    if (isLessonResolved(lesson.line, cwd, { meta: lesson.meta })) continue;

    candidates.push({
      date: lesson.date,
      slug: lesson.id,
      line: lesson.line,
      typed: !lesson.legacy,
      detector: lesson.meta ? lesson.meta.detector || null : null,
      attempts: lesson.meta ? (lesson.meta.attempts || 0) : 0
    });
  }

  if (candidates.length === 0) return null;

  // Oldest first — longest-standing fails get priority
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  return candidates[0];
}

function getLessonVerdict(lessonLine) {
  const match = lessonLine.match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+[\w-]+\*\*\s*[—-]\s*(pass|fail)\b/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Propose 3 candidate next horizons for the autopilot loop. Combines
 * `getIdleTickCount` + `getRecentSignals` into a prompt asking the LLM
 * to imagine what to work on next, spawns `claude -p`, and parses the
 * JSON response into `[{ title, confidence, rationale }]`.
 *
 * Filters out candidates derived from resolved lessons (bug pattern no
 * longer present in named files). Resolved lessons get tagged `[resolved]`
 * in lessons.md. Requires at least 1 valid candidate after filtering.
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
- Not a restatement of a \`pass\` lesson; pass lessons are shipped constraints, not open work.

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
    output = execPhaseCommandSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: PHASE_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      env
    }).toString();
  } catch (err) {
    if (isPhaseTimeoutError(err)) {
      throw new Error(`horizon-proposal phase timed out after ${PHASE_TIMEOUT / 1000}s`);
    }
    throw err;
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

  if (candidates.length < 1) {
    throw new Error(`proposeCandidateHorizons: expected at least 1 valid candidate, got ${candidates.length}`);
  }

  // Filter out candidates derived from shipped/resolved lessons.
  const lessonsPath = path.join(cwd, 'atris', 'lessons.md');
  const filtered = [];
  for (const c of candidates) {
    const combinedText = `${c.title} ${c.rationale}`.toLowerCase();
    let droppedByLesson = false;
    for (const lessonLine of signals.recentLessons) {
      const slugMatch = lessonLine.match(/\*\*\[\d{4}-\d{2}-\d{2}\]\s+([\w-]+)\*\*/);
      if (!slugMatch) continue;
      const alreadyResolved = lessonLine.includes('[resolved]');
      const slug = slugMatch[1];
      // Fuzzy match: check if slug keywords appear in the candidate text
      const slugWords = slug.split('-').filter(w => w.length > 2);
      const matchCount = slugWords.filter(w => combinedText.includes(w)).length;
      if (matchCount < Math.ceil(slugWords.length * 0.5)) continue;
      if (alreadyResolved || getLessonVerdict(lessonLine) === 'pass') {
        droppedByLesson = true;
        break;
      }
      // Candidate matches this lesson — check if the lesson is resolved
      if (isLessonResolved(lessonLine, cwd)) {
        // Tag lesson [resolved] in lessons.md
        try {
          let content = fs.readFileSync(lessonsPath, 'utf8');
          const taggedLine = lessonLine.replace(
            /\*\*\[(\d{4}-\d{2}-\d{2})\]\s+([\w-]+)\*\*/,
            '**[$1] $2** [resolved]'
          );
          content = content.replace(lessonLine.trim(), taggedLine.trim());
          fs.writeFileSync(lessonsPath, content);
        } catch {}
        droppedByLesson = true;
        break;
      }
    }
    if (!droppedByLesson) filtered.push(c);
  }

  if (filtered.length < 1) {
    throw new Error('proposeCandidateHorizons: all candidates were from resolved lessons');
  }

  return filtered.slice(0, 3);
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

    const suggestion = await suggestNextTask(cwd, skipped, { auto });

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
      if (suggestion.skipKey) skipped.add(suggestion.skipKey);
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
      if (suggestion.skipKey) skipped.add(suggestion.skipKey);
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
    const context = {
      task: suggestion.task,
      kind: suggestion.kind,
      ...(suggestion.files ? { files: suggestion.files } : {}),
      ...(suggestion.lessonLine ? { lessonLine: suggestion.lessonLine } : {}),
      ...(suggestion.lessonSlug ? { lessonSlug: suggestion.lessonSlug } : {}),
      ...(suggestion.lessonDate ? { lessonDate: suggestion.lessonDate } : {})
    };
    const startingEndgame = readEndgameState(cwd);

    // T33a: snapshot pre-tick HEADs (cwd + sibling repos named in the task)
    // so a do-phase timeout can be reconciled against what actually landed.
    let preTickHeads = null;
    try {
      const verifyHint = getVerifyCommand(cwd, suggestion.task).cmd || '';
      preTickHeads = snapshotRepoHeads(
        cwd,
        [suggestion.task, ...(suggestion.files || []), verifyHint].join(' ')
      );
    } catch { /* snapshot failure must not block the tick */ }

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
      lastVerifyCmd = execution.verifyCmd;

      // Early halt — judge corruption or no verify field
      if (execution.outcome === 'halted') {
        tickOutcome = 'halted';
        tickOutcomeText = `I halted before running "${lastTaskTitle}": ${execution.reason}.`;
        tickNextStep = 'stop until a human looks at the error';
        if (suggestion.kind === 'self-heal' && suggestion.lessonSlug) {
          markLessonAttempted(cwd, suggestion.lessonSlug, `halted:${execution.reason}`);
        }
        if (!verbose) {
          printPlainBlock([
            `I halted: ${execution.reason}.`,
            '',
            'Next I stopped the loop.'
          ].join('\n'));
        }
        break;
      }

      // T33b: the falsifiability gate found a completion receipt — the work
      // already shipped, the bullet is checked, move straight to the next pick.
      if (execution.outcome === 'advanced-already-done') {
        completed++;
        tickOutcome = 'built';
        tickOutcomeText = `"${lastTaskTitle}" was already done — verify passed pre-work and today's journal carries its completion receipt, so I checked the bullet and advanced.`;
        tickNextStep = 'pick the next endgame task';
        if (verbose) {
          console.log('  already done (journal receipt found). bullet checked, advancing.');
        } else {
          printPlainBlock([
            'That task was already done — verify passed before work and a completion receipt exists in today\'s journal.',
            'I checked the bullet and advanced.',
            '',
            'Next I will look for the next task.'
          ].join('\n'));
        }
        continue;
      }

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
        if (suggestion.kind === 'self-heal' && suggestion.lessonSlug) {
          markLessonAttempted(cwd, suggestion.lessonSlug, 'review-rejected');
        }
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
        if (suggestion.kind === 'self-heal' && suggestion.lessonSlug) {
          markLessonAttempted(cwd, suggestion.lessonSlug, 'verify-failed');
        }
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

      // Record commit hash + verify command for retroactive regression checks
      try {
        const commitHash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
        const taskSlug = lessonSlug(suggestion.task);
        recordTickCommit(cwd, commitHash, execution.verifyCmd || '', taskSlug);

        // Every 10th tick, run retroactive regression check
        const registryPath = path.join(cwd, 'atris', 'tick-registry.json');
        if (fs.existsSync(registryPath)) {
          try {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
            if (Array.isArray(registry) && registry.length % 10 === 0) {
              const regressionResults = regressionCheck(cwd);
              const failures = regressionResults.filter(r => !r.pass && !r.skipped);
              if (failures.length > 0) {
                // Apply -5 retroactive penalty per failure via journal note
                for (const f of failures) {
                  appendTickSummary(cwd, {
                    outcome: `Retroactive regression failure: tick ${f.hash.slice(0, 7)} (${f.slug}) verify now fails. -5 penalty.`,
                    horizon: readHorizonSlug(cwd),
                    nextStep: 'investigate regression',
                    reward: -5,
                  });
                }
                if (verbose) console.log(`  regression check: ${failures.length} failure(s) found`);
              } else if (verbose) {
                console.log(`  regression check: all ${regressionResults.length} entries pass`);
              }
            }
          } catch { /* registry read failure must not crash */ }
        }
      } catch { /* commit recording failure must not crash the tick */ }
      if (maybeWriteCompletedEndgameScorecard(cwd, startingEndgame)) {
        tickNextStep = 'pick the next horizon';
      }
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
      // T33a: a do-phase timeout with commits landed is a dead reporter, not
      // dead work — write the reconciliation receipt, mark the bullet, and
      // record work-landed-receipt-died instead of halting for a human.
      let reconciliation = null;
      if (isDoPhaseTimeoutMessage(err.message)) {
        try {
          reconciliation = reconcileTimedOutTick(cwd, preTickHeads, lastTaskTitle || suggestion.task);
        } catch { reconciliation = null; }
      }
      if (reconciliation && reconciliation.reconciled) {
        completed++;
        const landed = reconciliation.advanced
          .map((r) => `${r.label} ${String(r.before).slice(0, 7)} → ${String(r.after).slice(0, 7)}`)
          .join(', ');
        tickOutcome = 'work-landed-receipt-died';
        tickOutcomeText = `"${lastTaskTitle}" hit the do-phase wall but commits landed (${landed}). I wrote the reconciliation receipt and marked the bullet — work-landed-receipt-died, no human halt.`;
        tickNextStep = 'pick the next task';
        if (verbose) {
          console.log(`  do phase timed out, but work landed (${landed}). reconciled — no human halt.`);
        } else {
          printPlainBlock([
            'The do phase timed out, but commits landed before the wall.',
            `Landed: ${landed}.`,
            'I wrote the reconciliation receipt and marked the task bullet.',
            '',
            'Next tick will pick the next task.'
          ].join('\n'));
        }
        break;
      }
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
 * Compute age in days for a task.
 * Endgame tasks use the Picked: date from TODO.md Endgame section.
 * In-progress tasks parse timestamp from Claimed by: field.
 * Fallback returns 0 (fresh).
 */
function getTaskAgeDays(task, todoPath) {
  if (task.claimed) {
    const tsMatch = task.claimed.match(/\d{4}-\d{2}-\d{2}/);
    if (tsMatch) {
      const d = new Date(tsMatch[0]);
      if (!isNaN(d)) return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  if (task.tag === 'endgame' && todoPath && fs.existsSync(todoPath)) {
    const content = fs.readFileSync(todoPath, 'utf8');
    const m = content.match(/\*\*Picked:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d)) return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  return 0;
}

/**
 * Check whether a task/fact is still actionable.
 *
 * @param {{ title: string, age: number, source?: string }} fact
 *   - title: the task or fact description
 *   - age: age in days since the task was created/last verified
 *   - source: optional file path or identifier where the fact originated
 * @param {string} cwd - workspace root
 * @returns {'actionable'|'unverified'|'stale'}
 */
function isStillTrue(fact, cwd) {
  const { title, age, source } = fact;

  // Fresh tasks are always actionable
  if (age <= 7) return 'actionable';

  // Extract searchable keywords from the title (skip short/common words)
  const keywords = title
    .replace(/[`\[\](){}]/g, '')
    .split(/[\s/\\.:,;]+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  if (keywords.length === 0) return 'unverified';

  // Strategy 1: If source file is given, check it still exists
  if (source) {
    const sourcePath = path.isAbsolute(source) ? source : path.join(cwd, source);
    if (!fs.existsSync(sourcePath)) return 'stale';
  }

  // Strategy 2: grep the codebase for key terms from the title
  let grepHits = 0;
  for (const kw of keywords) {
    try {
      execFileSync('grep', ['-r', '-l', '--include=*.js', '--include=*.md', '-m', '1', kw, '.'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      });
      grepHits++;
    } catch {
      // grep returns non-zero when no match — that's fine
    }
  }

  // If none of the keywords appear in the codebase, it's stale
  if (grepHits === 0) return 'stale';

  // Strategy 3: check git log for recent activity related to the keywords
  let gitHits = 0;
  for (const kw of keywords.slice(0, 3)) {
    try {
      const out = execFileSync(
        'git', ['log', '--oneline', '--since=30 days ago', '--all', `--grep=${kw}`, '-1'],
        { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
      ).toString().trim();
      if (out.length > 0) gitHits++;
    } catch {
      // git-log failure is non-fatal
    }
  }

  // Strong mechanical evidence: grep found terms AND recent git activity
  if (gitHits > 0) return 'actionable';

  // Grep found terms but no recent git activity — can't fully verify
  return 'unverified';
}

/**
 * Ask a local model whether a task/fact is still relevant.
 * Called when isStillTrue returns 'unverified' — the mechanical check
 * couldn't confirm or deny, so we ask claude -p to inspect the codebase.
 *
 * @param {{ title: string, age: number, source?: string }} fact
 * @param {string} cwd - workspace root
 * @returns {{ fresh: boolean, reasoning: string }}
 */
function askModel(fact, cwd) {
  const { title, source } = fact;
  const sourceHint = source ? `\nOriginal source file: ${source}` : '';
  const prompt = `You are a staleness checker. Answer with exactly one line: YES or NO, followed by a short reason (under 30 words).

Is this task still relevant to the codebase? Check for the mentioned files, functions, or patterns.

Task: "${title}"${sourceHint}

Search the codebase to verify. Reply: YES <reason> or NO <reason>`;

  const tmpFile = path.join(cwd, '.staleness-prompt.tmp');
  fs.writeFileSync(tmpFile, prompt);

  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const cmd = `claude -p "$(cat '${tmpFile.replace(/'/g, "'\\''")}')" --allowedTools "Bash,Read,Glob,Grep"`;
    const output = execPhaseCommandSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      stdio: 'pipe',
      maxBuffer: 2 * 1024 * 1024,
      env
    }).trim();

    try { fs.unlinkSync(tmpFile); } catch {}

    // Parse YES/NO from the first line of output
    const firstLine = output.split('\n').find(l => /^\s*(YES|NO)\b/i.test(l)) || output.split('\n')[0] || '';
    const fresh = /^\s*YES\b/i.test(firstLine);
    const reasoning = firstLine.replace(/^\s*(YES|NO)\s*/i, '').trim() || output.slice(0, 200);

    return { fresh, reasoning };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    // On timeout or crash, treat as unverifiable — conservative default
    return { fresh: false, reasoning: `Model check failed: ${(err.message || '').slice(0, 100)}` };
  }
}

/**
 * Entry point when called without a description.
 */
async function autopilotFromTodo(options = {}) {
  return autopilotAtris(null, options);
}

module.exports = {
  appendTickSummary,
  snapshotRepoHeads,
  diffAdvancedRepoHeads,
  reconcileTimedOutTick,
  markTodoBulletDone,
  findCompletionReceipt,
  isDoPhaseTimeoutMessage,
  askHuman,
  askModel,
  autopilotAtris,
  autopilotFromTodo,
  buildPrompt,
  isLessonResolved,
  isLessonResolvedLegacy,
  loadLessonMetadata,
  markLessonAttempted,
  parseLessons,
  pickUnresolvedFailLesson,
  runLessonDetector,
  isStillTrue,
  getTaskAgeDays,
  getIdleTickCount,
  getRecentSignals,
  getTickStatus,
  getVerifyCommand,
  computeTickReward,
  detectDefaultVerify,
  findCodeTodos,
  findHotspot,
  isTodoTracked,
  scanAnomalies,
  verifyJudgeIntegrity,
  maybeWriteCompletedEndgameScorecard,
  renderHumanSuggestion,
  renderHumanTickIntro,
  proposeCandidateHorizons,
  recordTickCommit,
  regressionCheck,
  repoMapAuditReportsClean,
  isCleanMapBrokenRefFailLesson,
  inlinePythonVerifyFailureNowPasses,
  runPlanReview,
  runTaskOnce,
  buildPlanReviewPrompt,
  parseVerdict,
  scoreEndgameCandidates,
  suggestNextTask,
  shouldSkipAutoHumanGate,
  writeLesson,
  isPhaseTimeoutError,
  execPhaseCommandSync,
  executePhaseDetailed,
  lessonSlug
};
