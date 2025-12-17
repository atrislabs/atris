const fs = require('fs');
const path = require('path');
const { getLogPath } = require('../lib/journal');

function visualizeAtris() {
  const { logFile, dateFormatted } = getLogPath();

  // Check if log exists
  if (!fs.existsSync(logFile)) {
    console.log('✗ No journal entry for today. Run "atris log" to create one.');
    process.exit(1);
  }

  // Read the log file
  const logContent = fs.readFileSync(logFile, 'utf8');

  // Extract Inbox section
  const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
  if (!inboxMatch || !inboxMatch[1].trim()) {
    console.log('✗ No items in Inbox. Add ideas to your journal first.');
    process.exit(1);
  }

  const inboxItems = inboxMatch[1]
    .trim()
    .split('\n')
    .filter(line => line.match(/^- \*\*I\d+:/))
    .map(line => {
      const match = line.match(/^- \*\*I\d+:\s+(.+)$|^- \*\*I\d+:\*\*\s*(.+)$/);
      return match ? (match[1] || match[2]) : line;
    });

  if (inboxItems.length === 0) {
    console.log('✗ No formatted inbox items. Use format: - **I#: Description**');
    process.exit(1);
  }

  // Display visualization template
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Visualize — Break Down & Approval Gate                │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  inboxItems.forEach((item, idx) => {
    console.log(`\n📌 Idea ${idx + 1}: ${item}`);
    console.log('─────────────────────────────────────────');
    console.log('AGENT PROMPT TEMPLATE:\n');
    console.log('1. Break this idea into 3-4 concrete steps.');
    console.log('2. Create ASCII diagram showing flow/structure.');
    console.log('3. Get user approval before creating task.\n');
    console.log('EXAMPLE ASCII (for UI ideas):');
    console.log('```');
    console.log('  Journal Entry');
    console.log('       ↓');
    console.log('  Extract Ideas');
    console.log('       ↓');
    console.log('  Visualize Plan');
    console.log('       ↓');
    console.log('  User Approval');
    console.log('       ↓');
    console.log('  Create Task');
    console.log('```\n');
  });

  console.log('─────────────────────────────────────────');
  console.log('✓ Ready to pass to agents with approval gate enabled.');
  console.log('');
}


module.exports = {
  visualizeAtris
};
