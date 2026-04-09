const fs = require('fs');
const path = require('path');
const { parseTodo } = require('./todo');

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

  const scorecardsPath = path.join(atrisDir, 'scorecards.md');

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
  const scorecardsPath = path.join(atrisDir, 'scorecards.md');
  if (!fs.existsSync(scorecardsPath)) return [];

  const content = fs.readFileSync(scorecardsPath, 'utf8');
  const scorecards = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^- \*\*\[(.+?)\]\s+(.+?)\*\*\s*—\s*shipped:\s*(\d+)\/(\d+)\s*—\s*wall-clock:\s*(.+?)\s*—\s*halt:\s*(\d+)%\s*—\s*reward:\s*(\d+)\s*—\s*lessons:\s*(\d+)$/);
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
  writeScorecard,
  readScorecards,
  detectEndgameCompletion,
};
