const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { detectWorkspaceState, loadContext } = require('../lib/state-detection');

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

  // Check for handoff from previous session
  let handoffContent = null;
  if (fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const handoffMatch = journalContent.match(/## Handoff\n([\s\S]*?)(?=\n---|\n## |$)/);
    if (handoffMatch && handoffMatch[1].trim() && handoffMatch[1].includes('**Context:**')) {
      handoffContent = handoffMatch[1].trim();
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

  console.log('');
  console.log(`📅 ${dateFormatted}  •  State: ${state.state}`);
  console.log(`   ${summaryLine}`);
  console.log('');
  console.log('Core files:');
  console.log(`- ${fs.existsSync(personaFile) ? rel(personaFile) : 'atris/PERSONA.md (missing)'}`);
  console.log(`- ${fs.existsSync(mapFile) ? rel(mapFile) : 'atris/MAP.md (missing)'}`);
  console.log(`- ${taskFilePath ? rel(taskFilePath) : 'atris/TODO.md (missing)'}`);
  console.log(`- ${rel(logFile)}`);
  console.log('');
  console.log('Next: atris plan → do → review (or atris log)');
  console.log('');
}

module.exports = { activateAtris };

