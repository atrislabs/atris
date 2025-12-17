const fs = require('fs');
const path = require('path');

// Log file operations
function getLogPath(dateStr) {
  const targetDir = path.join(process.cwd(), 'atris');
  const date = dateStr ? new Date(dateStr) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`;

  const logsDir = path.join(targetDir, 'logs');
  const yearDir = path.join(logsDir, year.toString());
  const logFile = path.join(yearDir, `${dateFormatted}.md`);

  return { logsDir, yearDir, logFile, dateFormatted };
}

function ensureLogDirectory() {
  const { logsDir, yearDir } = getLogPath();

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }
}

function createLogFile(logFile, dateFormatted) {
  let carryInProgress = '';
  let carryBacklog = '';
  let carryInbox = '';

  try {
    const [y, m, d] = String(dateFormatted).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      const prev = new Date(y, m - 1, d);
      prev.setDate(prev.getDate() - 1);

      const prevYear = prev.getFullYear();
      const prevMonth = String(prev.getMonth() + 1).padStart(2, '0');
      const prevDay = String(prev.getDate()).padStart(2, '0');
      const prevDateFormatted = `${prevYear}-${prevMonth}-${prevDay}`;
      const prevLogFile = path.join(process.cwd(), 'atris', 'logs', prevYear.toString(), `${prevDateFormatted}.md`);

      if (fs.existsSync(prevLogFile)) {
        const prevContent = fs.readFileSync(prevLogFile, 'utf8');

        const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionBody = (headingLine) => {
          const regex = new RegExp(
            `## ${escapeRegExp(headingLine)}\\n([\\s\\S]*?)(?=\\n---|\\n## |$)`
          );
          const match = prevContent.match(regex);
          return match ? match[1].trim() : '';
        };

        carryInProgress = sectionBody('In Progress 🔄');
        carryBacklog = sectionBody('Backlog');
        carryInbox = sectionBody('Inbox');
      }
    }
  } catch {
    // Best-effort carry-forward; never block journal creation.
  }

  const inProgressBody = carryInProgress ? `${carryInProgress}\n\n` : '';
  const backlogBody = carryBacklog ? `${carryBacklog}\n\n` : '';
  const inboxBody = carryInbox ? `${carryInbox}\n\n` : '';

  const initialContent = `# Log — ${dateFormatted}\n\n## Completed ✅\n\n---\n\n## In Progress 🔄\n\n${inProgressBody}---\n\n## Backlog\n\n${backlogBody}---\n\n## Notes\n\n---\n\n## Inbox\n\n${inboxBody}\n`;
  fs.writeFileSync(logFile, initialContent);
}

function getTimeLabel() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Inbox operations
function parseInboxItems(content) {
  const match = content.match(/## Inbox\n([\s\S]*?)(?=\n##|\n---|$)/);
  if (!match) {
    return [];
  }
  const body = match[1];
  const lines = body.split('\n');
  const items = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('(Empty')) return;
    const parsed = trimmed.match(/^- \*\*I(\d+):\*\*\s*(.+)$|^- \*\*I(\d+):\s+(.+)$/);
    if (parsed) {
      const id = parseInt(parsed[1] || parsed[3], 10);
      const text = parsed[2] || parsed[4];
      items.push({ id, text, line: trimmed });
    }
  });
  return items;
}

function replaceInboxSection(content, items) {
  const regex = /(## Inbox\n)([\s\S]*?)(\n---|\n##|$)/;
  if (!regex.test(content)) {
    const lines = items.length ? items.map((item) => item.line).join('\n') : '(Empty - inbox zero achieved)';
    return `${content}\n\n## Inbox\n\n${lines}\n`;
  }

  return content.replace(regex, (match, header, body, suffix) => {
    const inner = items.length
      ? `\n${items.map((item) => item.line).join('\n')}\n`
      : '\n(Empty - inbox zero achieved)\n';
    return `${header}${inner}${suffix}`;
  });
}

function addInboxItemToContent(content, id, summary) {
  const items = parseInboxItems(content).filter((item) => item.id !== id);
  const newItem = { id, text: summary, line: `- **I${id}:** ${summary}` };
  const updatedItems = [newItem, ...items];
  return replaceInboxSection(content, updatedItems);
}

function removeInboxItemFromContent(content, id) {
  const items = parseInboxItems(content).filter((item) => item.id !== id);
  return replaceInboxSection(content, items);
}

function getNextInboxId(content) {
  const items = parseInboxItems(content);
  if (items.length === 0) return 1;
  return items.reduce((max, item) => (item.id > max ? item.id : max), 0) + 1;
}

function addInboxIdea(logFile, summary) {
  const content = fs.readFileSync(logFile, 'utf8');
  const nextId = getNextInboxId(content);
  const updated = addInboxItemToContent(content, nextId, summary);
  fs.writeFileSync(logFile, updated);
  return nextId;
}

// Completion operations
function parseCompletionItems(content) {
  const match = content.match(/## Completed ✅\n([\s\S]*?)(?=\n##|\n---|$)/);
  if (!match) {
    return [];
  }
  const body = match[1];
  const lines = body.split('\n');
  const items = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('(Empty')) return;
    const parsed = trimmed.match(/^- \*\*C(\d+):\*\*\s*(.+)$|^- \*\*C(\d+):\s+(.+)$/);
    if (parsed) {
      const id = parseInt(parsed[1] || parsed[3], 10);
      const text = parsed[2] || parsed[4];
      items.push({ id, text, line: trimmed });
    }
  });
  return items;
}

function replaceCompletedSection(content, items) {
  const regex = /(## Completed ✅\n)([\s\S]*?)(\n---|\n##|$)/;
  if (!regex.test(content)) {
    const lines = items.length ? items.map((item) => item.line).join('\n') : '';
    return `${content}\n\n## Completed ✅\n\n${lines}\n`;
  }

  return content.replace(regex, (match, header, body, suffix) => {
    const inner = items.length
      ? `\n${items.map((item) => item.line).join('\n')}\n`
      : '\n';
    return `${header}${inner}${suffix}`;
  });
}

function addCompletionItemToContent(content, id, summary) {
  const items = parseCompletionItems(content).filter((item) => item.id !== id);
  const newItem = { id, text: summary, line: `- **C${id}:** ${summary}` };
  const updatedItems = [...items, newItem];
  return replaceCompletedSection(content, updatedItems);
}

function getNextCompletionId(content) {
  const items = parseCompletionItems(content);
  if (items.length === 0) return 1;
  return items.reduce((max, item) => (item.id > max ? item.id : max), 0) + 1;
}

// Notes operations
function insertIntoNotesSection(content, block) {
  const regex = /(## Notes\n)([\s\S]*?)(\n---|\n##|$)/;
  const match = content.match(regex);
  if (!match) {
    return `${content}\n\n## Notes\n\n${block}\n`;
  }
  const header = match[1];
  const body = match[2];
  const suffix = match[3];
  const trimmedBody = body.replace(/\s*$/, '');
  const newBody = trimmedBody
    ? `${trimmedBody}\n\n${block}\n`
    : `\n${block}\n`;
  return content.replace(regex, `${header}${newBody}${suffix}`);
}

function recordBrainstormSession(
  logFile,
  sourceLabel,
  topic,
  desiredOutcome,
  keyQuestions,
  focusAreas,
  constraints,
  references,
  tonePreference,
  nextSteps,
  sessionSummary
) {
  let content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Brainstorm Session — ${getTimeLabel()}`,
    `**Source:** ${sourceLabel}`,
    `**Topic:** ${topic}`,
  ];
  if (desiredOutcome) {
    lines.push(`**User Story / Desired Outcome:** ${desiredOutcome}`);
  }
  if (tonePreference) {
    lines.push(`**Vibe / Feelings:** ${tonePreference}`);
  }
  if (keyQuestions && keyQuestions.length > 0) {
    lines.push('**Key Questions:**');
    keyQuestions.forEach((item) => lines.push(`- ${item}`));
  }
  if (focusAreas && focusAreas.length > 0) {
    lines.push('**Focus Areas:**');
    focusAreas.forEach((item) => lines.push(`- ${item}`));
  }
  if (constraints) {
    lines.push(`**Constraints:** ${constraints}`);
  }
  if (references) {
    lines.push(`**Context / References:** ${references}`);
  }
  if (sessionSummary) {
    lines.push(`**Session Summary:** ${sessionSummary}`);
  }
  if (nextSteps && nextSteps.length > 0) {
    lines.push('**Next Steps:**');
    nextSteps.forEach((item) => lines.push(`- ${item}`));
  }

  const block = lines.join('\n');
  content = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, content);
}

function recordAutopilotVision(logFile, sourceLabel, summary, successCriteria, riskNotes) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Autopilot Vision — ${getTimeLabel()}`,
    `**Source:** ${sourceLabel}`,
    `**Summary:** ${summary}`,
    '**Success Criteria:**',
    ...successCriteria.map((item) => `- ${item}`),
  ];
  if (riskNotes && riskNotes.trim()) {
    lines.push(`**Risks / Notes:** ${riskNotes}`);
  }
  const block = lines.join('\n');
  const updated = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, updated);
}

function recordAutopilotIteration(logFile, iteration, result, notes) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Autopilot Iteration ${iteration} — ${getTimeLabel()}`,
    `**Validator Result:** ${result}`,
  ];
  if (notes && notes.trim()) {
    lines.push(`**Notes:** ${notes}`);
  }
  const block = lines.join('\n');
  const updated = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, updated);
}

function recordAutopilotSuccess(logFile, inboxId, summary) {
  let content = fs.readFileSync(logFile, 'utf8');
  if (typeof inboxId === 'number' && !Number.isNaN(inboxId)) {
    content = removeInboxItemFromContent(content, inboxId);
  }
  const nextId = getNextCompletionId(content);
  content = addCompletionItemToContent(content, nextId, `Autopilot — ${summary}`);
  fs.writeFileSync(logFile, content);
}

module.exports = {
  getLogPath,
  ensureLogDirectory,
  createLogFile,
  getTimeLabel,
  parseInboxItems,
  replaceInboxSection,
  addInboxItemToContent,
  removeInboxItemFromContent,
  getNextInboxId,
  addInboxIdea,
  parseCompletionItems,
  replaceCompletedSection,
  addCompletionItemToContent,
  getNextCompletionId,
  insertIntoNotesSection,
  recordBrainstormSession,
  recordAutopilotVision,
  recordAutopilotIteration,
  recordAutopilotSuccess,
};
