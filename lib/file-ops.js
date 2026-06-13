const fs = require('fs');
const path = require('path');
const escapeRegExp = require('./escape-regexp');

/**
 * Get the path components for a journal log file.
 * @param {string} [dateStr] - Optional date string (defaults to today)
 * @returns {Object} Object with logsDir, yearDir, logFile, dateFormatted
 */
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

/**
 * Ensure the logs directory structure exists.
 */
function ensureLogDirectory() {
  const { logsDir, yearDir } = getLogPath();

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }
}

/**
 * Create a new daily log file, carrying forward unfinished items from yesterday.
 * @param {string} logFile - Path to the log file to create
 * @param {string} dateFormatted - Date string in YYYY-MM-DD format
 */
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

  const initialContent = `# Log — ${dateFormatted}\n\n## Handoff\n\n---\n\n## Completed ✅\n\n---\n\n## In Progress 🔄\n\n${inProgressBody}---\n\n## Backlog\n\n${backlogBody}---\n\n## Notes\n\n---\n\n## Inbox\n\n${inboxBody}\n`;
  fs.writeFileSync(logFile, initialContent);
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

module.exports = {
  getLogPath,
  ensureLogDirectory,
  createLogFile,
  parseInboxItems,
  replaceInboxSection,
  addInboxItemToContent,
  getNextInboxId,
  addInboxIdea,
};
