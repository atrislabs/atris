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

function printHumanSection(title, body) {
  console.log(`  ${title}`);
  const sourceLines = Array.isArray(body) ? body : String(body || '').split('\n');
  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      console.log('  ');
      continue;
    }
    for (const line of wrapText(sourceLine)) {
      console.log(`  ${line}`);
    }
  }
  console.log('');
}

function readEndgameMeta(todoFile) {
  if (!fs.existsSync(todoFile)) return { slug: null, horizon: null };
  const todoContent = fs.readFileSync(todoFile, 'utf8');
  const endgameMatch = todoContent.match(/##\s+Endgame\s*\n([\s\S]*?)(?=\n##|$)/);
  if (!endgameMatch) return { slug: null, horizon: null };

  const slug = endgameMatch[1].match(/\*\*Slug:\*\*\s*(.+)/)?.[1]?.trim() || null;
  const horizon = endgameMatch[1].match(/\*\*Horizon:\*\*\s*(.+)/)?.[1]?.trim() || null;
  return { slug, horizon };
}

function statusAtris(isQuick = false, jsonMode = false, verbose = false) {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'atris/ folder not found' }));
      process.exit(1);
    }
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

  // JSON mode — structured output for scripting
  if (jsonMode) {
    const output = {
      date: dateFormatted,
      backlog: todo.backlog,
      inProgress: todo.inProgress,
      completed: todo.completed,
      inbox: inboxItems,
      completions,
      lessons: lessonsCount,
      team: teamActivity,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Quick mode
  if (isQuick) {
    console.log(`📋 ${todo.backlog.length} | 🔨 ${todo.inProgress.length} | ✅ ${todo.completed.length} | 📥 ${inboxItems.length} | 📚 ${lessonsCount}`);
    return;
  }

  if (!verbose) {
    const endgame = readEndgameMeta(todoFile);
    const where = [];
    if (endgame.slug) {
      where.push(`The active horizon is ${endgame.slug}.`);
      if (endgame.horizon) {
        where.push(...compactWrappedText(endgame.horizon, 74, 2));
      }
    } else {
      where.push('No active endgame is set.');
    }
    const ipCount = todo.inProgress.length;
    const bkCount = todo.backlog.length;
    const cpCount = todo.completed.length;
    const ipWord = ipCount === 1 ? 'task' : 'tasks';
    const verb = ipCount === 1 ? 'is' : 'are';
    where.push(`There ${verb} ${ipCount} ${ipWord} in progress, ${bkCount} queued, and ${cpCount} completed items still sitting in TODO.`);

    const queueParts = [];
    if (todo.inProgress[0]) {
      queueParts.push(...compactWrappedText(`In progress: ${todo.inProgress[0].title}.`, 74, 2));
    } else {
      queueParts.push('In progress: none.');
    }
    if (todo.backlog[0]) {
      queueParts.push(...compactWrappedText(`Next backlog item: ${todo.backlog[0].title}.`, 74, 2));
    } else {
      queueParts.push('Next backlog item: none.');
    }
    queueParts.push(inboxItems.length > 0
      ? `Inbox has ${inboxItems.length} item${inboxItems.length === 1 ? '' : 's'}.`
      : 'Inbox is empty.');

    const blockingParts = [];
    if (todo.completed.length > 0) {
      blockingParts.push(`Main drag: ${todo.completed.length} completed item${todo.completed.length === 1 ? '' : 's'} should be cleared from TODO.`);
    } else {
      blockingParts.push('No cleanup debt is visible in TODO.');
    }
    if (todo.inProgress.length === 0 && todo.backlog.length === 0 && inboxItems.length === 0) {
      blockingParts.push('No active blocker is visible right now.');
    } else if (teamActivity.length === 0) {
      blockingParts.push('No team activity is logged yet today.');
    } else {
      blockingParts.push(`Team activity has ${teamActivity.length} recent signal${teamActivity.length === 1 ? '' : 's'}.`);
    }

    console.log('');
    printHumanSection('Where we are:', where);
    printHumanSection('What is queued:', queueParts);
    printHumanSection('What is blocking:', blockingParts);
    try {
      const { collectLaunchpad } = require('./launchpad');
      const { printOperatorNext } = require('../lib/operator-next');
      const launchpad = collectLaunchpad(process.cwd());
      const command = launchpad?.next_action?.command;
      if (command) {
        console.log('');
        printOperatorNext(command);
      }
    } catch {}
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
