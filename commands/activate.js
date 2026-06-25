const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');
const { readWikiStatus } = require('../lib/wiki');

function activateAtris() {
  const workspaceDir = process.cwd();
  const targetDir = path.join(workspaceDir, 'atris');

  if (!fs.existsSync(targetDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const personaFile = path.join(targetDir, 'PERSONA.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');

  // Journal (create today's file if missing so the system is always runnable)
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  const state = detectWorkspaceState(workspaceDir);
  const context = loadContext(workspaceDir);
  const wikiStatus = readWikiStatus(workspaceDir);

  // Check for handoff from previous session
  let handoffContent = null;
  if (fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const handoffMatch = journalContent.match(/## Handoff\n([\s\S]*?)(?=\n---|\n## |$)/);
    if (handoffMatch && handoffMatch[1].trim() && handoffMatch[1].includes('**Context:**')) {
      handoffContent = handoffMatch[1].trim();
    }
  }

  // Get last 3 completions from journal logs
  let recentCompletions = [];
  const logsDir = path.join(targetDir, 'logs');
  if (fs.existsSync(logsDir)) {
    const allLogs = [];
    const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of yearDirs) {
      const yearPath = path.join(logsDir, year);
      if (fs.statSync(yearPath).isDirectory()) {
        const files = fs.readdirSync(yearPath).filter(f => f.endsWith('.md'));
        files.forEach(f => allLogs.push(path.join(yearPath, f)));
      }
    }
    // Sort descending (most recent first)
    allLogs.sort().reverse();

    // Extract C# items from logs until we have 3. Dedupe by ID across files
    // since per-day numbering reuses C1, C2, etc. — the same ID appearing
    // in two day-files would otherwise render as duplicate rows.
    const seenIds = new Set();
    for (const logPath of allLogs) {
      if (recentCompletions.length >= 3) break;
      const content = fs.readFileSync(logPath, 'utf8');
      const completedSection = content.match(/## Completed ✅\n([\s\S]*?)(?=\n## |$)/);
      if (completedSection) {
        // Match `- **C#: Title**` (title between the bold markers). If extra
        // prose follows after `**`, ignore it — the activation panel shows
        // titles only, truncated to 59 chars.
        const matches = completedSection[1].matchAll(/- \*\*C(\d+):\s*([^*\n]+?)\*\*/gm);
        for (const match of matches) {
          if (recentCompletions.length >= 3) break;
          const id = `C${match[1]}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          recentCompletions.push({ id, desc: match[2].trim(), file: path.basename(logPath) });
        }
      }
    }
  }

  const rel = (p) => path.relative(workspaceDir, p);
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);

  const summaryParts = [];
  if (context.inProgressFeatures?.length) summaryParts.push(`⚡ ${context.inProgressFeatures.length} in progress`);
  if (context.backlogTasks?.length) summaryParts.push(`📋 ${context.backlogTasks.length} backlog`);
  if (context.inboxItems?.length) summaryParts.push(`📥 ${context.inboxItems.length} inbox`);
  const summaryLine = summaryParts.length ? summaryParts.join('  |  ') : 'Clean slate';

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Activate — Context Loaded                             │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  // Display handoff prominently if present
  if (handoffContent) {
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 📋 HANDOFF FROM LAST SESSION                                │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    const lines = handoffContent.split('\n').slice(0, 5); // Max 5 lines
    lines.forEach(line => {
      const padded = line.substring(0, 59).padEnd(59);
      console.log(`│ ${padded} │`);
    });
    console.log('└─────────────────────────────────────────────────────────────┘');
  }

  // Display recent completions if any
  if (recentCompletions.length > 0) {
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ ✅ RECENT COMPLETIONS                                       │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    recentCompletions.forEach(c => {
      const line = `${c.id}: ${c.desc}`;
      const padded = line.substring(0, 59).padEnd(59);
      console.log(`│ ${padded} │`);
    });
    console.log('└─────────────────────────────────────────────────────────────┘');
  }

  // Show learning count if learnings exist
  let learningLine = '';
  try {
    const learningsPath = path.join(targetDir, 'learnings.jsonl');
    if (fs.existsSync(learningsPath)) {
      const lines = fs.readFileSync(learningsPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        learningLine = `  •  🧠 ${lines.length} learnings`;
      }
    }
  } catch {}

  console.log('');
  console.log(`📅 ${dateFormatted}  •  State: ${state.state}${learningLine}`);
  console.log(`   ${summaryLine}`);
  if (wikiStatus) {
    const healthLine = wikiStatus.bullets.find((line) => line.startsWith('- Health:'));
    const wikiSummary = (healthLine || wikiStatus.bullets[0] || '- wiki scaffold ready').replace(/^- /, '');
    console.log(`   🧠 Wiki: ${wikiSummary}`);
  }
  console.log('');
  console.log('Core files:');
  console.log(`- ${fs.existsSync(personaFile) ? rel(personaFile) : 'atris/PERSONA.md (missing)'}`);
  console.log(`- ${fs.existsSync(mapFile) ? rel(mapFile) : 'atris/MAP.md (missing)'}`);
  console.log(`- ${taskFilePath ? rel(taskFilePath) : 'atris/TODO.md (missing)'}`);
  console.log(`- ${rel(logFile)}`);
  if (wikiStatus?.statusPath) {
    console.log(`- ${rel(wikiStatus.statusPath)}`);
  }
  if (wikiStatus?.bullets?.length) {
    console.log('');
    console.log('Wiki:');
    wikiStatus.bullets.forEach((line) => console.log(`- ${line.replace(/^- /, '')}`));
  }
  console.log('');
  try {
    const { gatherCandidates, pickNextMoves, readDecisions } = require('../lib/next-moves');
    const { readProfile, isEmptyProfile } = require('../lib/clarity');
    const root = process.cwd();
    const { killedIds } = readDecisions(root);
    const moves = pickNextMoves(gatherCandidates(root), { limit: 3, killedIds });
    console.log('Your next moves:');
    if (moves.length) {
      moves.forEach((m, i) => console.log(`  ${i + 1}. ${m.title}`));
      console.log('  steer them: atris moves');
    } else {
      console.log('  none queued. add to ROADMAP.md under "## Open loop items", or jot one with atris log');
    }
    if (isEmptyProfile(readProfile(root))) {
      console.log('');
      console.log('Tip: run atris clarity once so agents learn how you work.');
    }
    console.log('');
  } catch { /* alive onboarding is best-effort; never block activate */ }
  console.log('Next: atris plan → do → review (or atris log)');
  console.log('');
}

module.exports = { activateAtris };
