const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function isSameTimestamp(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) < 5;
}

function computeContentHash(content) {
  if (typeof content !== 'string') {
    return null;
  }
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function parseJournalSections(content) {
  const sections = {};
  const lines = content.split('\n');
  let currentSection = '__header__';
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Save previous section
      if (currentContent.length > 0 || currentSection === '__header__') {
        sections[currentSection] = currentContent.join('\n');
      }
      // Start new section
      currentSection = line.substring(3).trim();
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentContent.length > 0) {
    sections[currentSection] = currentContent.join('\n');
  }

  return sections;
}

function mergeSections(localSections, remoteSections, knownRemoteHash) {
  const merged = {};
  const conflicts = [];

  // Get all unique section names
  const allSections = new Set([...Object.keys(localSections), ...Object.keys(remoteSections)]);

  for (const section of allSections) {
    const localContent = localSections[section] || '';
    const remoteContent = remoteSections[section] || '';

    if (localContent === remoteContent) {
      // Same content, use either
      merged[section] = localContent;
    } else if (!remoteContent) {
      // Only in local, keep local
      merged[section] = localContent;
    } else if (!localContent) {
      // Only in remote, keep remote
      merged[section] = remoteContent;
    } else {
      // Both exist but differ - check if remote matches known state
      const remoteHash = computeContentHash(remoteContent);
      if (knownRemoteHash && remoteHash === knownRemoteHash) {
        // Remote hasn't changed since last sync, prefer local
        merged[section] = localContent;
      } else {
        // Real conflict - mark for user review
        conflicts.push(section);
        merged[section] = localContent; // Default to local
      }
    }
  }

  return { merged, conflicts };
}

function reconstructJournal(sections) {
  const parts = [];

  // Header first
  if (sections['__header__']) {
    parts.push(sections['__header__']);
  }

  // Then all other sections in order (preserve original order where possible)
  const sectionOrder = ['Handoff', 'Completed ✅', 'In Progress 🔄', 'Backlog', 'Notes', 'Inbox', 'Timestamps', 'Lessons Learned'];

  for (const section of sectionOrder) {
    if (sections[section]) {
      parts.push(sections[section]);
    }
  }

  // Add any remaining sections not in the standard order
  for (const [section, content] of Object.entries(sections)) {
    if (section !== '__header__' && !sectionOrder.includes(section)) {
      parts.push(content);
    }
  }

  return parts.join('\n');
}

function showLogDiff(localPath, remoteContent) {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-diff-'));
    const remotePath = path.join(tmpDir, 'remote.md');
    fs.writeFileSync(remotePath, remoteContent, 'utf8');

    const diffCommands = [
      { cmd: 'git', args: ['--no-pager', 'diff', '--no-index', '--color=always', '--', localPath, remotePath] },
      { cmd: 'diff', args: ['-u', localPath, remotePath] },
    ];

    let shown = false;
    for (const { cmd, args } of diffCommands) {
      const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.error || result.status === 127) {
        continue;
      }

      const output = `${result.stdout || ''}${result.stderr || ''}`.trimEnd();
      if (output) {
        console.log('─────────────────────────────────────────────────────────────');
        console.log('Diff (web -> local):');
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
        console.log('─────────────────────────────────────────────────────────────');
        shown = true;
        break;
      }
    }

    if (!shown) {
      console.log('─────────────────────────────────────────────────────────────');
      console.log('Diff: (no textual diff available; files may be identical or differ only in whitespace)');
      console.log('─────────────────────────────────────────────────────────────');
    }
  } catch (error) {
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`Unable to show diff automatically (${error.message || error}).`);
    console.log('─────────────────────────────────────────────────────────────');
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {
        // ignore cleanup errors
      }
    }
  }
}

function getLogPath(dateStr) {
  const targetDir = path.join(process.cwd(), 'atris');
  const date = dateStr ? new Date(dateStr) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateFormatted = `${year}-${month}-${day}`; // YYYY-MM-DD in local time

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

  const initialContent = `# Log — ${dateFormatted}\n\n## Handoff\n\n---\n\n## Completed ✅\n\n---\n\n## In Progress 🔄\n\n${inProgressBody}---\n\n## Backlog\n\n${backlogBody}---\n\n## Notes\n\n---\n\n## Inbox\n\n${inboxBody}\n`;
  fs.writeFileSync(logFile, initialContent);
}

module.exports = {
  isSameTimestamp,
  computeContentHash,
  parseJournalSections,
  mergeSections,
  reconstructJournal,
  showLogDiff,
  getLogPath,
  ensureLogDirectory,
  createLogFile,
};
