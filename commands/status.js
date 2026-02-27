const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { parseTodo, getTeamActivity } = require('../lib/todo');

// Box drawing helpers
const W = 64; // inner width
const line = (char = '─') => char.repeat(W);
const pad = (str, w = W) => {
  const visible = str.replace(/[\u{1F4CB}\u{1F528}\u{2705}\u{1F4E5}\u{1F4DA}\u{26A1}\u{1F916}\u{1F4DD}]/gu, 'XX'); // emoji = ~2 chars
  const len = visible.length;
  return len >= w ? str : str + ' '.repeat(w - len);
};

function statusAtris(isQuick = false) {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // Parse TODO.md
  const todoFile = path.join(targetDir, 'TODO.md');
  const todo = parseTodo(todoFile);

  // Read journal for inbox and completions
  const { logFile, dateFormatted } = getLogPath();
  let inboxItems = [];
  let completions = [];

  ensureLogDirectory();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  if (fs.existsSync(logFile)) {
    const logContent = fs.readFileSync(logFile, 'utf8');

    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      inboxItems = inboxMatch[1].trim().split('\n')
        .filter(l => l.match(/^- \*\*I\d+:/))
        .map(l => {
          const match = l.match(/^- \*\*I(\d+):\s+(.+)$|^- \*\*I(\d+):\*\*\s*(.+)$/);
          return match ? { id: match[1] || match[3], title: match[2] || match[4] } : null;
        })
        .filter(Boolean);
    }

    const completedMatch = logContent.match(/## Completed ✅\n([\s\S]*?)(?=\n##|---|$)/);
    if (completedMatch && completedMatch[1].trim()) {
      completions = completedMatch[1].trim().split('\n')
        .filter(l => l.match(/^- \*\*C\d+:/))
        .slice(-3)
        .map(l => {
          const match = l.match(/^- \*\*C(\d+):\s+(.+)$|^- \*\*C(\d+):\*\*\s*(.+)$/);
          return match ? { id: match[1] || match[3], title: match[2] || match[4] } : null;
        })
        .filter(Boolean);
    }
  }

  // Fallback: check journal for backlog tasks if TODO.md has none
  if (todo.backlog.length === 0 && fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const backlogMatch = journalContent.match(/## Backlog\n([\s\S]*?)(?=\n##|---|$)/);
    if (backlogMatch && backlogMatch[1].trim()) {
      const journalTasks = backlogMatch[1].trim().split('\n')
        .filter(l => /^-\s+/.test(l) && !/\(empty|\(see /i.test(l));
      if (journalTasks.length > 0) {
        todo.backlog = journalTasks.map(l => ({
          id: (l.match(/\*\*([A-Z]\d+):/)?.[1]) || '?',
          title: l.replace(/^-\s*\*\*[A-Z]\d+:\*?\*?\s*/, '').trim(),
        }));
      }
    }
  }

  // Count lessons
  const lessonsFile = path.join(targetDir, 'lessons.md');
  let lessonsCount = 0;
  if (fs.existsSync(lessonsFile)) {
    const lessonsContent = fs.readFileSync(lessonsFile, 'utf8');
    lessonsCount = (lessonsContent.match(/^- \*\*/gm) || []).length;
  }

  // Get team activity
  const teamActivity = getTeamActivity(targetDir);

  // Quick mode
  if (isQuick) {
    console.log(`📋 ${todo.backlog.length} | 🔨 ${todo.inProgress.length} | ✅ ${todo.completed.length} | 📥 ${inboxItems.length} | 📚 ${lessonsCount}`);
    return;
  }

  // ─── FULL VISUAL STATUS ────────────────────────────────────
  const o = (s) => console.log(s);

  o('');
  o(`┌─${'─'.repeat(W)}─┐`);
  o(`│ ${pad(`TASK BOARD — ${dateFormatted}`)} │`);
  o(`├─${'─'.repeat(W)}─┤`);

  // Backlog
  o(`│ ${pad('')} │`);
  o(`│ ${pad(`  📋 Backlog (${todo.backlog.length})`)} │`);
  if (todo.backlog.length > 0) {
    todo.backlog.slice(0, 5).forEach((t, i) => {
      const id = t.id ? `${t.id}: ` : '';
      const tag = t.tag ? ` [${t.tag}]` : '';
      const full = `${id}${t.title}${tag}`;
      const maxLen = W - 8;
      const label = full.length > maxLen ? full.substring(0, maxLen - 3) + '...' : full;
      const branch = (i === todo.backlog.length - 1 || i === 4) ? '└─' : '├─';
      o(`│ ${pad(`  ${branch} ${label}`)} │`);
    });
    if (todo.backlog.length > 5) {
      o(`│ ${pad(`  └─ ... +${todo.backlog.length - 5} more`)} │`);
    }
  } else {
    o(`│ ${pad('  (none)')} │`);
  }

  // In Progress
  o(`│ ${pad('')} │`);
  o(`│ ${pad(`  🔨 In Progress (${todo.inProgress.length})`)} │`);
  if (todo.inProgress.length > 0) {
    todo.inProgress.forEach((t, i) => {
      const id = t.id ? `${t.id}: ` : '';
      const full = `${id}${t.title}`;
      const maxLen = W - 8;
      const label = full.length > maxLen ? full.substring(0, maxLen - 3) + '...' : full;
      const isLast = i === todo.inProgress.length - 1;
      o(`│ ${pad(`  ${isLast ? '└─' : '├─'} ${label}`)} │`);
      const agent = t.claimed || 'unclaimed';
      const stage = t.stage || '';
      const detail = stage ? `${agent} · ${stage}` : agent;
      o(`│ ${pad(`  ${isLast ? ' ' : '│'}  └─ ${detail}`)} │`);
    });
  } else {
    o(`│ ${pad('  (none)')} │`);
  }

  // Completed (target = 0)
  o(`│ ${pad('')} │`);
  const doneLabel = todo.completed.length === 0
    ? '  ✅ Done (0)  ← target state'
    : `  ✅ Done (${todo.completed.length})  ← clean these up`;
  o(`│ ${pad(doneLabel)} │`);

  // Inbox
  if (inboxItems.length > 0) {
    o(`│ ${pad('')} │`);
    o(`│ ${pad(`  📥 Inbox (${inboxItems.length})`)} │`);
    inboxItems.slice(0, 3).forEach(i => {
      o(`│ ${pad(`  ├─ I${i.id}: ${i.title.substring(0, W - 14)}`)} │`);
    });
    if (inboxItems.length > 3) {
      o(`│ ${pad(`  └─ ... +${inboxItems.length - 3} more`)} │`);
    }
  }

  // Lessons
  o(`│ ${pad('')} │`);
  o(`│ ${pad(`  📚 Lessons (${lessonsCount})`)} │`);

  // Team Activity
  o(`│ ${pad('')} │`);
  o(`├─${'─'.repeat(W)}─┤`);
  o(`│ ${pad('TEAM')} │`);
  o(`│ ${pad('')} │`);

  if (teamActivity.length > 0) {
    teamActivity.forEach(a => {
      const name = a.member.padEnd(12);
      const dateShort = formatDateShort(a.date);
      // Show the most interesting field: pattern > learned > delivered > task
      const insight = a.pattern || a.learned || a.delivered || a.task || '';
      const maxLen = W - 22;
      const truncated = insight.length > maxLen ? insight.substring(0, maxLen - 3) + '...' : insight;
      o(`│ ${pad(`  ${name} · ${dateShort}`)} │`);
      if (insight) {
        o(`│ ${pad(`  ${' '.repeat(12)}   "${truncated}"`)} │`);
      }
    });
  } else {
    o(`│ ${pad('  (no journal entries yet)')} │`);
  }

  o(`│ ${pad('')} │`);
  o(`└─${'─'.repeat(W)}─┘`);
  o('');
  o('  plan → do → review    (or: atris log to add ideas)');
  o('');
}

function formatDateShort(dateStr) {
  // "2026-02-25" → "Feb 25"
  try {
    const [, month, day] = dateStr.match(/(\d{2})-(\d{2})$/);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
  } catch {
    return dateStr;
  }
}

module.exports = {
  statusAtris
};
