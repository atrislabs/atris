const fs = require('fs');
const path = require('path');
const { getLogPath } = require('../lib/journal');

function statusAtris(isQuick = false) {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Read TODO.md (or legacy TASK_CONTEXTS.md) for backlog and in-progress tasks
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  let backlogTasks = [];
  let inProgressTasks = [];
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);

  if (taskFilePath && fs.existsSync(taskFilePath)) {
    const taskContent = fs.readFileSync(taskFilePath, 'utf8');

    // Extract Backlog
    const backlogMatch = taskContent.match(/## Backlog\n([\s\S]*?)(?=\n##|$)/);
    if (backlogMatch && backlogMatch[1].trim() && !backlogMatch[1].includes('(No active tasks)')) {
      const tasks = backlogMatch[1].trim().split('\n### ').filter(t => t.trim());
      backlogTasks = tasks.map(t => {
        const match = t.match(/Task:\s*(.+)/);
        return match ? match[1].substring(0, 60) : null;
      }).filter(Boolean);
    }

    // Extract In Progress
    const inProgressMatch = taskContent.match(/## In Progress\n([\s\S]*?)(?=\n##|$)/);
    if (inProgressMatch && inProgressMatch[1].trim() && !inProgressMatch[1].includes('Format:')) {
      const tasks = inProgressMatch[1].trim().split('\n### ').filter(t => t.trim() && !t.startsWith('(Tasks') && !t.startsWith('Format:'));
      inProgressTasks = tasks.map(t => {
        const titleMatch = t.match(/Task:\s*(.+)/);
        const claimMatch = t.match(/\*\*Claimed by:\*\*\s*(.+)/);
        if (titleMatch) {
          const title = titleMatch[1].substring(0, 40);
          const claimed = claimMatch ? claimMatch[1].substring(0, 20) : 'Unknown';
          return { title, claimed };
        }
        return null;
      }).filter(Boolean);
    }
  }

  // Read journal for inbox and completions
  const { logFile, dateFormatted } = getLogPath();
  let inboxItems = [];
  let completions = [];

  if (fs.existsSync(logFile)) {
    const logContent = fs.readFileSync(logFile, 'utf8');

    // Extract inbox
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      inboxItems = inboxMatch[1]
        .trim()
        .split('\n')
        .filter(l => l.match(/^- \*\*I\d+:/))
        .map(l => {
          const match = l.match(/^- \*\*I(\d+):\s+(.+)$|^- \*\*I(\d+):\*\*\s*(.+)$/);
          return match ? { id: match[1] || match[3], title: match[2] || match[4] } : null;
        })
        .filter(Boolean);
    }

    // Extract recent completions
    const completedMatch = logContent.match(/## Completed ✅\n([\s\S]*?)(?=\n##|---)/);
    if (completedMatch && completedMatch[1].trim()) {
      completions = completedMatch[1]
        .trim()
        .split('\n')
        .filter(l => l.match(/^- \*\*C\d+:/))
        .slice(-3)
        .map(l => {
          const match = l.match(/^- \*\*C(\d+):\s+(.+)$|^- \*\*C(\d+):\*\*\s*(.+)$/);
          return match ? { id: match[1] || match[3], title: match[2] || match[4] } : null;
        })
        .filter(Boolean);
    }
  }

  // Quick mode: one-line summary
  if (isQuick) {
    console.log(`📥 ${inboxItems.length} | 📋 ${backlogTasks.length} | 🔨 ${inProgressTasks.length} | ✅ ${completions.length}`);
    return;
  }

  // Full display status
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Atris Status — ${dateFormatted}${' '.repeat(40 - dateFormatted.length)}│`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Backlog tasks
  console.log(`📋 Backlog (unclaimed): ${backlogTasks.length}`);
  if (backlogTasks.length > 0) {
    backlogTasks.forEach(t => {
      console.log(`   • ${t}${t.length > 60 ? '...' : ''}`);
    });
  } else {
    console.log('   (No backlog tasks)');
  }
  console.log('');

  // In Progress tasks
  console.log(`🔨 In Progress (claimed): ${inProgressTasks.length}`);
  if (inProgressTasks.length > 0) {
    inProgressTasks.forEach(t => {
      console.log(`   • ${t.title}${t.title.length > 40 ? '...' : ''}`);
      console.log(`     Claimed by: ${t.claimed}`);
    });
  } else {
    console.log('   (No tasks being worked on)');
  }
  console.log('');

  // Inbox
  console.log(`📥 Inbox Items: ${inboxItems.length}`);
  if (inboxItems.length > 0) {
    inboxItems.slice(0, 3).forEach(i => {
      console.log(`   • I${i.id}: ${i.title.substring(0, 50)}${i.title.length > 50 ? '...' : ''}`);
    });
    if (inboxItems.length > 3) {
      console.log(`   ... and ${inboxItems.length - 3} more`);
    }
  } else {
    console.log('   (No items in inbox)');
  }
  console.log('');

  // Recent completions
  console.log(`✅ Recent Completions: ${completions.length}`);
  if (completions.length > 0) {
    completions.forEach(c => {
      console.log(`   • C${c.id}: ${c.title.substring(0, 50)}${c.title.length > 50 ? '...' : ''}`);
    });
  } else {
    console.log('   (No completions yet)');
  }
  console.log('');

  console.log('─────────────────────────────────────────────────────────────');
  console.log('Next: atris plan → do → review (or atris log to add ideas)');
  console.log('');
}


module.exports = {
  statusAtris
};
