// Pure TODO.md markdown parser. The original lib/todo.js logic, extracted so
// the shim in lib/todo.js can fall back to it when the SQLite store is empty
// (or when ATRIS_TASK_DB is not enabled).
//
// Do not add new callers. Use lib/todo.js (the shim) — it merges DB + markdown.

'use strict';

const fs = require('fs');
const path = require('path');

function parseTodoFile(todoPath) {
  if (!fs.existsSync(todoPath)) return { backlog: [], inProgress: [], review: [], completed: [] };
  const content = fs.readFileSync(todoPath, 'utf8');
  return {
    backlog: parseSection(content, 'Backlog'),
    inProgress: parseSection(content, 'In Progress'),
    review: parseSection(content, 'Review'),
    completed: parseSection(content, 'Completed'),
  };
}

function tagsFromText(text) {
  const allTags = [...String(text || '').matchAll(/\[(\w+)\]/g)].map(m => m[1]);
  return {
    allTags,
    tag: allTags.includes('endgame') ? 'endgame' : (allTags[0] || null),
  };
}

function cleanTaskTitle(text) {
  const raw = String(text || '').trim();
  const withoutTags = raw.replace(/\s*\[\w+\]/g, '').trim();
  const bold = withoutTags.match(/^\*\*(.+?)\*\*\s*(?:[—-]\s*)?(.*)$/);
  if (!bold) return withoutTags;
  return [bold[1], bold[2]].filter(Boolean).join(' — ').trim();
}

function parseSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`(?:^|\\n)##\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n##(?!#)\\s+|$)`, 'i'));
  if (!match) return [];

  const body = (match[1] || '').trim();
  if (!body || /^\(clean\)/i.test(body) || /^\(empty/i.test(body) || /^\(see /i.test(body)) return [];

  const tasks = [];
  const lines = body.split('\n');
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Strikethrough = done. `- ~~**id:** ...~~ DONE ...` lines are kept in
    // Backlog for rollback context but must not be picked as live work.
    // Otherwise the autopilot picker re-selects them every tick and halts on
    // "no Verify: field" (lessons.md: no-verify-field, 8 occurrences 2026-05-08..10).
    if (/^- ~~/.test(line)) {
      if (current) { tasks.push(current); current = null; }
      continue;
    }

    const taskMatch = line.match(/^- \*\*([^*:\n]+):\*\*\s*(.+)$/);
    if (taskMatch) {
      if (current) tasks.push(current);
      const { allTags, tag } = tagsFromText(taskMatch[2]);
      current = {
        id: taskMatch[1],
        title: cleanTaskTitle(taskMatch[2]),
        tag,
        tags: allTags,
        claimed: null,
        stage: null,
        verify: null,
      };
      continue;
    }

    const bracketTaskMatch = line.match(/^- \*\*\[([^\]\n]+)\]\*\*\s+(.+)$/);
    if (bracketTaskMatch) {
      if (current) tasks.push(current);
      const { allTags, tag } = tagsFromText(bracketTaskMatch[2]);
      current = {
        id: bracketTaskMatch[1],
        title: cleanTaskTitle(bracketTaskMatch[2]),
        tag,
        tags: allTags,
        claimed: null,
        stage: null,
        verify: null,
      };
      continue;
    }

    const checkMatch = line.match(/^- \[[ x]\]\s+(.+)$/);
    if (checkMatch) {
      if (current) {
        tasks.push(current);
        current = null;
      }
      const { allTags, tag } = tagsFromText(checkMatch[1]);
      tasks.push({ id: null, title: cleanTaskTitle(checkMatch[1]), tag, tags: allTags, claimed: null, stage: null, verify: null });
      continue;
    }

    const plainMatch = line.match(/^- (.+)$/);
    if (plainMatch && !plainMatch[1].startsWith('**')) {
      if (current) {
        tasks.push(current);
        current = null;
      }
      const { allTags, tag } = tagsFromText(plainMatch[1]);
      tasks.push({ id: null, title: cleanTaskTitle(plainMatch[1]), tag, tags: allTags, claimed: null, stage: null, verify: null });
      continue;
    }

    if (!current) continue;

    const claimMatch = line.match(/\*\*Claimed by:\*\*\s*(.+)$/) || line.match(/Claimed by:\s*(.+)$/);
    if (claimMatch) { current.claimed = claimMatch[1].trim(); continue; }

    const stageMatch = line.match(/\*\*Stage:\*\*\s*(.+)$/) || line.match(/Stage:\s*(.+)$/);
    if (stageMatch) { current.stage = stageMatch[1].trim(); continue; }

    const verifyMatch = line.match(/\*\*Verify:\*\*\s*(.+)$/) || line.match(/Verify:\s*(.+)$/);
    if (verifyMatch) { current.verify = verifyMatch[1].trim(); continue; }
  }

  if (current) tasks.push(current);
  return tasks;
}

function getTeamMemberJournal(atrisDir, memberName) {
  const journalDir = path.join(atrisDir, 'team', memberName, 'journal');
  if (!fs.existsSync(journalDir)) return null;

  let files;
  try {
    files = fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).sort().reverse();
  } catch { return null; }

  if (files.length === 0) return null;

  const latestFile = files[0];
  let content;
  try { content = fs.readFileSync(path.join(journalDir, latestFile), 'utf8'); }
  catch { return null; }

  const date = latestFile.replace('.md', '');
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

function listTeamMembers(atrisDir) {
  const teamDir = path.join(atrisDir, 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir).filter(name => {
    if (name.startsWith('_') || name.startsWith('.')) return false;
    const full = path.join(teamDir, name);
    try { return fs.statSync(full).isDirectory(); } catch { return false; }
  });
}

function getTeamActivity(atrisDir) {
  const members = listTeamMembers(atrisDir);
  const activity = [];
  for (const member of members) {
    const journal = getTeamMemberJournal(atrisDir, member);
    if (journal) activity.push({ member, ...journal });
  }
  activity.sort((a, b) => b.date.localeCompare(a.date));
  return activity;
}

module.exports = {
  parseTodoFile,
  parseSection,
  getTeamMemberJournal,
  listTeamMembers,
  getTeamActivity,
};
