const fs = require('fs');
const path = require('path');
const { parseTodo } = require('./todo');

const PRIVATE_MEMORY_ROOT = '.atris/presidio';

function ensurePrivateMemoryDir(atrisDir) {
  const privateDir = path.join(path.dirname(atrisDir), PRIVATE_MEMORY_ROOT);
  fs.mkdirSync(privateDir, { recursive: true });
  return privateDir;
}

function getScorecardsPath(atrisDir) {
  return path.join(ensurePrivateMemoryDir(atrisDir), 'scorecards.md');
}

function parsePickedAt(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
  if (!match) return null;

  const [, datePart, timePart = '00:00'] = match;
  const parsed = new Date(`${datePart}T${timePart}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTickDate(dateStr, timeLabel) {
  const match = String(timeLabel || '').trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3] || null;

  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const parsed = new Date(`${dateStr}T00:00:00`);
  parsed.setHours(hours, minutes, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function listLogFiles(atrisDir, startDate, endDate = new Date()) {
  const logsDir = path.join(atrisDir, 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const startKey = startDate.toISOString().slice(0, 10);
  const endKey = endDate.toISOString().slice(0, 10);
  const files = [];

  for (const year of fs.readdirSync(logsDir)) {
    const yearDir = path.join(logsDir, year);
    let stat;
    try {
      stat = fs.statSync(yearDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const entry of fs.readdirSync(yearDir)) {
      if (!entry.endsWith('.md')) continue;
      const dateKey = entry.replace(/\.md$/, '');
      if (dateKey < startKey || dateKey > endKey) continue;
      files.push({ dateKey, file: path.join(yearDir, entry) });
    }
  }

  files.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  return files;
}

function readNotesSection(content) {
  const match = String(content || '').match(/## Notes\n([\s\S]*?)(?=\n##\s|$)/);
  return match ? match[1] : '';
}

function collectRewardStats(atrisDir, pickedAt) {
  const startAt = parsePickedAt(pickedAt);
  if (!startAt) {
    return { totalReward: 0, totalTicks: 0, haltedTicks: 0 };
  }

  let totalReward = 0;
  let totalTicks = 0;
  let haltedTicks = 0;

  for (const { dateKey, file } of listLogFiles(atrisDir, startAt)) {
    const notes = readNotesSection(fs.readFileSync(file, 'utf8'));
    if (!notes) continue;

    const lines = notes.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const headerMatch = lines[i].match(/^- (\d{1,2}:\d{2}(?:\s*[ap]m)?)$/i);
      if (!headerMatch) continue;

      const tickAt = parseTickDate(dateKey, headerMatch[1]);
      if (!tickAt || tickAt < startAt) continue;

      let reward = null;
      let halted = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const current = lines[j];
        if (j > i + 1 && /^- (\d{1,2}:\d{2}(?:\s*[ap]m)?)$/i.test(current)) break;
        if (current && !current.startsWith('  ')) break;

        const trimmed = current.trim();
        if (!trimmed) continue;
        if (/^Reward:\s*-?\d+$/i.test(trimmed)) {
          reward = parseInt(trimmed.replace(/^Reward:\s*/i, ''), 10);
        }
        if (/review flagged issues|verify failed|hit an error|stopped for a manual check/i.test(trimmed)) {
          halted = true;
        }
      }

      if (reward !== null) {
        totalReward += reward;
        totalTicks += 1;
        if (halted) haltedTicks += 1;
      }

      i = j - 1;
    }
  }

  return { totalReward, totalTicks, haltedTicks };
}

function countLessonsGenerated(atrisDir, pickedAt) {
  const startAt = parsePickedAt(pickedAt);
  if (!startAt) return 0;

  const lessonsPath = path.join(atrisDir, 'lessons.md');
  if (!fs.existsSync(lessonsPath)) return 0;

  const startDateKey = startAt.toISOString().slice(0, 10);
  return fs.readFileSync(lessonsPath, 'utf8')
    .split('\n')
    .reduce((count, line) => {
      const match = line.match(/^- \*\*\[(\d{4}-\d{2}-\d{2})\]/);
      return match && match[1] >= startDateKey ? count + 1 : count;
    }, 0);
}

function buildScorecardData(atrisDir, { slug, pickedAt } = {}) {
  if (!slug) {
    throw new Error('Scorecard: slug is required');
  }

  const todoPath = path.join(atrisDir, 'TODO.md');
  const todo = parseTodo(todoPath);
  const startAt = parsePickedAt(pickedAt) || new Date();
  const rewardStats = collectRewardStats(atrisDir, pickedAt);
  // Count shipped tasks from journal completions (tasks get deleted from TODO.md after completion)
  const completedFromTodo = todo.completed.filter(t => t.tag === 'endgame').length;
  const activeEndgame = todo.backlog.filter(t => t.tag === 'endgame').length
    + todo.inProgress.filter(t => t.tag === 'endgame').length;
  // Fall back to reward tick count if TODO completions were already pruned
  const shipped = completedFromTodo > 0 ? completedFromTodo : rewardStats.totalTicks - rewardStats.haltedTicks;
  const attempted = shipped + activeEndgame + rewardStats.haltedTicks;

  return {
    slug,
    startDate: startAt.toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    tasksShipped: Math.max(shipped, 0),
    tasksAttempted: Math.max(attempted, shipped),
    wallClockHours: Math.max(0, (Date.now() - startAt.getTime()) / (1000 * 60 * 60)),
    haltRatio: rewardStats.totalTicks > 0 ? rewardStats.haltedTicks / rewardStats.totalTicks : 0,
    totalReward: rewardStats.totalReward,
    lessonsGenerated: countLessonsGenerated(atrisDir, pickedAt),
  };
}

/**
 * Write a scorecard when an endgame closes.
 *
 * @param {string} atrisDir - Path to atris/ directory
 * @param {object} data - Scorecard data
 *   - slug: endgame slug (e.g., "loop-self-seeds-horizons")
 *   - startDate: ISO date when endgame started
 *   - endDate: ISO date when endgame ended (default: today)
 *   - tasksShipped: number of tasks completed
 *   - tasksAttempted: number of tasks started
 *   - wallClockHours: total hours (float)
 *   - haltRatio: fraction of ticks that halted (e.g., 0.1)
 *   - totalReward: sum of per-tick reward scores
 *   - lessonsGenerated: number of lessons appended to lessons.md
 */
function writeScorecard(atrisDir, data) {
  const {
    slug,
    startDate,
    endDate = new Date().toISOString().split('T')[0],
    tasksShipped = 0,
    tasksAttempted = 0,
    wallClockHours = 0,
    haltRatio = 0,
    totalReward = 0,
    lessonsGenerated = 0,
  } = data;

  // Validate required fields
  if (!slug) {
    throw new Error('Scorecard: slug is required');
  }

  const scorecardsPath = getScorecardsPath(atrisDir);

  // Dedupe guard: don't write the same slug twice
  const existing = readScorecards(atrisDir);
  if (existing.some(sc => sc.slug === slug)) {
    return; // already written
  }

  // Ensure scorecards.md exists
  if (!fs.existsSync(scorecardsPath)) {
    const template = `# scorecards.md — Endgame Results\n\n> Append-only. One line per closed endgame. Records outcome metrics from the horizon.\n\n---\n\n`;
    fs.writeFileSync(scorecardsPath, template, 'utf8');
  }

  // Format: - **[date] slug** — shipped: X/Y — wall-clock: Nh — halt: Z% — reward: total — lessons: N
  const haltPercent = Math.round(haltRatio * 100);
  const wallClockStr = wallClockHours < 1 ? `${Math.round(wallClockHours * 60)}m` : `${wallClockHours.toFixed(1)}h`;
  const line = `- **[${endDate}] ${slug}** — shipped: ${tasksShipped}/${tasksAttempted} — wall-clock: ${wallClockStr} — halt: ${haltPercent}% — reward: ${totalReward} — lessons: ${lessonsGenerated}\n`;

  // Append to file
  fs.appendFileSync(scorecardsPath, line, 'utf8');
}

/**
 * Detect if the current endgame in TODO.md is complete (all endgame tasks in Completed).
 * Returns { complete: boolean, endgameSlug: string | null }
 */
function detectEndgameCompletion(atrisDir) {
  const todoPath = path.join(atrisDir, 'TODO.md');
  if (!fs.existsSync(todoPath)) {
    return { complete: false, endgameSlug: null };
  }

  const todo = parseTodo(todoPath);

  // Find the current endgame section
  const endgameSectionMatch = fs.readFileSync(todoPath, 'utf8')
    .match(/## Endgame\n\n\*\*Slug:\*\*\s*(\S+)/);

  if (!endgameSectionMatch) {
    return { complete: false, endgameSlug: null };
  }

  const slug = endgameSectionMatch[1];

  // Check if there are any endgame-tagged tasks in backlog or in-progress
  const hasActiveEndgame = todo.backlog.some(t => t.tag === 'endgame')
    || todo.inProgress.some(t => t.tag === 'endgame');

  return {
    complete: !hasActiveEndgame,
    endgameSlug: slug,
  };
}

/**
 * Parse scorecards.md and return array of scorecard objects.
 */
function readScorecards(atrisDir) {
  const scorecardsPath = getScorecardsPath(atrisDir);
  if (!fs.existsSync(scorecardsPath)) return [];

  const content = fs.readFileSync(scorecardsPath, 'utf8');
  const scorecards = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^- \*\*\[(.+?)\]\s+(.+?)\*\*\s*—\s*shipped:\s*(\d+)\/(\d+)\s*—\s*wall-clock:\s*(.+?)\s*—\s*halt:\s*(\d+)%\s*—\s*reward:\s*(-?\d+)\s*—\s*lessons:\s*(\d+)$/);
    if (!match) continue;

    const [, endDate, slug, shipped, attempted, wallClockStr, haltPercent, reward, lessons] = match;

    // Parse wall-clock back to hours
    let wallClockHours = 0;
    if (wallClockStr.endsWith('h')) {
      wallClockHours = parseFloat(wallClockStr);
    } else if (wallClockStr.endsWith('m')) {
      wallClockHours = parseInt(wallClockStr) / 60;
    }

    scorecards.push({
      endDate,
      slug,
      tasksShipped: parseInt(shipped),
      tasksAttempted: parseInt(attempted),
      wallClockHours,
      haltRatio: parseInt(haltPercent) / 100,
      totalReward: parseInt(reward),
      lessonsGenerated: parseInt(lessons),
    });
  }

  return scorecards;
}

module.exports = {
  PRIVATE_MEMORY_ROOT,
  getScorecardsPath,
  buildScorecardData,
  writeScorecard,
  readScorecards,
  detectEndgameCompletion,
};
