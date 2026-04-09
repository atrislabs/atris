const fs = require('fs');
const path = require('path');

/**
 * Parse TODO.md into structured task objects.
 * Supports format: - **T1:** Description
 *   with optional **Claimed by:** and **Stage:** lines
 */
function parseTodo(todoPath) {
  if (!fs.existsSync(todoPath)) return { backlog: [], inProgress: [], completed: [] };

  const content = fs.readFileSync(todoPath, 'utf8');
  return {
    backlog: parseSection(content, 'Backlog'),
    inProgress: parseSection(content, 'In Progress'),
    completed: parseSection(content, 'Completed'),
  };
}

function parseSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`##\\s+${escaped}\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
  if (!match) return [];

  const body = (match[1] || '').trim();
  if (!body || /^\(clean\)/i.test(body) || /^\(empty/i.test(body) || /^\(see /i.test(body)) return [];

  const tasks = [];
  const lines = body.split('\n');
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // New task line: - **T1:** Description or - **T1a:** Description [tag] [tag]
    // Accepts task IDs like T1, W3b, M12c, R1, T#1 — letter(s), optional symbols, digits, optional trailing letter.
    const taskMatch = line.match(/^- \*\*([A-Za-z][A-Za-z0-9#]*\d[a-z]?):\*\*\s*(.+)$/);
    if (taskMatch) {
      if (current) tasks.push(current);
      // Capture ALL bracketed tags in the line, not just the last one. Endgame is priority.
      const allTags = [...taskMatch[2].matchAll(/\[(\w+)\]/g)].map(m => m[1]);
      const tag = allTags.includes('endgame') ? 'endgame' : (allTags[0] || null);
      current = {
        id: taskMatch[1],
        title: taskMatch[2].replace(/\s*\[\w+\]/g, '').trim(),
        tag,
        tags: allTags,
        claimed: null,
        stage: null,
        verify: null,
      };
      continue;
    }

    // Also support checkbox format: - [x] Description
    const checkMatch = line.match(/^- \[[ x]\]\s+(.+)$/);
    if (checkMatch && !current) {
      tasks.push({
        id: null,
        title: checkMatch[1].trim(),
        tag: null,
        claimed: null,
        stage: null,
        verify: null,
      });
      continue;
    }

    // Plain bullet without ID: - Description
    const plainMatch = line.match(/^- (.+)$/);
    if (plainMatch && !current && !plainMatch[1].startsWith('**')) {
      tasks.push({
        id: null,
        title: plainMatch[1].trim(),
        tag: null,
        claimed: null,
        stage: null,
        verify: null,
      });
      continue;
    }

    if (!current) continue;

    // Claimed by line
    const claimMatch = line.match(/\*\*Claimed by:\*\*\s*(.+)$/) || line.match(/Claimed by:\s*(.+)$/);
    if (claimMatch) {
      current.claimed = claimMatch[1].trim();
      continue;
    }

    // Stage line
    const stageMatch = line.match(/\*\*Stage:\*\*\s*(.+)$/) || line.match(/Stage:\s*(.+)$/);
    if (stageMatch) {
      current.stage = stageMatch[1].trim();
      continue;
    }

    // Verify line
    const verifyMatch = line.match(/\*\*Verify:\*\*\s*(.+)$/) || line.match(/Verify:\s*(.+)$/);
    if (verifyMatch) {
      current.verify = verifyMatch[1].trim();
      continue;
    }
  }

  if (current) tasks.push(current);
  return tasks;
}

/**
 * Get latest journal entry for a team member.
 * Reads the most recent file in atris/team/[member]/journal/
 * Returns { date, entries[] } or null
 */
function getTeamMemberJournal(atrisDir, memberName) {
  const journalDir = path.join(atrisDir, 'team', memberName, 'journal');
  if (!fs.existsSync(journalDir)) return null;

  let files;
  try {
    files = fs.readdirSync(journalDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const latestFile = files[0];
  let content;
  try {
    content = fs.readFileSync(path.join(journalDir, latestFile), 'utf8');
  } catch {
    return null;
  }
  const date = latestFile.replace('.md', '');

  // Extract key fields from journal entry
  const taskMatch = content.match(/\*\*Task:\*\*\s*(.+)/);
  const deliveredMatch = content.match(/\*\*Delivered:\*\*\s*(.+)/);
  const patternMatch = content.match(/\*\*Pattern:\*\*\s*(.+)/);
  const learnedMatch = content.match(/\*\*Learned:\*\*\s*(.+)/);

  return {
    date,
    file: path.join(journalDir, latestFile),
    task: taskMatch ? taskMatch[1].trim() : null,
    delivered: deliveredMatch ? deliveredMatch[1].trim() : null,
    pattern: patternMatch ? patternMatch[1].trim() : null,
    learned: learnedMatch ? learnedMatch[1].trim() : null,
    raw: content,
  };
}

/**
 * Get all team members that have directories in atris/team/
 */
function listTeamMembers(atrisDir) {
  const teamDir = path.join(atrisDir, 'team');
  if (!fs.existsSync(teamDir)) return [];

  return fs.readdirSync(teamDir)
    .filter(name => {
      if (name.startsWith('_') || name.startsWith('.')) return false;
      const full = path.join(teamDir, name);
      try { return fs.statSync(full).isDirectory(); } catch { return false; }
    });
}

/**
 * Get team activity: latest journal entry per member
 */
function getTeamActivity(atrisDir) {
  const members = listTeamMembers(atrisDir);
  const activity = [];

  for (const member of members) {
    const journal = getTeamMemberJournal(atrisDir, member);
    if (journal) {
      activity.push({ member, ...journal });
    }
  }

  // Sort by date descending (most recent first)
  activity.sort((a, b) => b.date.localeCompare(a.date));
  return activity;
}

module.exports = {
  parseTodo,
  parseSection,
  getTeamMemberJournal,
  listTeamMembers,
  getTeamActivity,
};
