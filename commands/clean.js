const fs = require('fs');
const path = require('path');

/**
 * atris clean - Workspace housekeeping with auto-heal
 *
 * - Detect and FIX broken MAP.md refs (auto-heal)
 * - Detect stale tasks (claimed but never completed)
 * - Archive old journal files (>30 days)
 * - Clean empty sections
 */
function cleanAtris(options = {}) {
  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');

  if (!fs.existsSync(atrisDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Clean                                                 │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  const results = {
    staleTasks: [],
    brokenRefs: [],
    healedRefs: 0,
    unhealableRefs: [],
    archivedJournals: 0,
    cleanedSections: 0
  };

  // 1. Check for stale tasks in TODO.md
  const staleTasks = findStaleTasks(atrisDir);
  results.staleTasks = staleTasks;

  // 2. Find and HEAL broken MAP.md references
  const { healed, unhealable } = healBrokenMapRefs(cwd, atrisDir, options.dryRun);
  results.healedRefs = healed;
  results.unhealableRefs = unhealable;

  // 3. Archive old journals (>30 days)
  const archived = archiveOldJournals(atrisDir, options.dryRun);
  results.archivedJournals = archived;

  // 4. Clean empty sections in TODO.md
  const cleaned = cleanEmptySections(atrisDir, options.dryRun);
  results.cleanedSections = cleaned;

  // Report results
  console.log('Results:');
  console.log('');

  // Stale tasks
  if (staleTasks.length > 0) {
    console.log(`⚠ ${staleTasks.length} stale task(s) (claimed >3 days, not completed):`);
    staleTasks.forEach(task => {
      console.log(`   • ${task.title.substring(0, 50)}${task.title.length > 50 ? '...' : ''}`);
    });
    console.log('');
  } else {
    console.log('✓ No stale tasks');
  }

  // Healed refs
  if (healed > 0) {
    console.log(`✓ Healed ${healed} MAP.md reference(s)`);
  }

  // Unhealable refs
  if (unhealable.length > 0) {
    console.log(`⚠ ${unhealable.length} MAP.md ref(s) couldn't be healed:`);
    unhealable.slice(0, 3).forEach(ref => {
      console.log(`   • ${ref.file}:${ref.line} — ${ref.reason}`);
    });
    if (unhealable.length > 3) {
      console.log(`   ... and ${unhealable.length - 3} more`);
    }
    console.log('');
  } else if (healed === 0) {
    console.log('✓ All MAP.md refs valid');
  }

  // Archived journals
  if (archived > 0) {
    console.log(`✓ Archived ${archived} old journal(s)`);
  } else {
    console.log('✓ No journals need archiving');
  }

  // Cleaned sections
  if (cleaned > 0) {
    console.log(`✓ Cleaned ${cleaned} empty section(s)`);
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');

  const hasIssues = staleTasks.length > 0 || unhealable.length > 0;
  if (hasIssues) {
    console.log('Manual action needed:');
    if (staleTasks.length > 0) {
      console.log('  • Delete stale tasks or finish them');
    }
    if (unhealable.length > 0) {
      console.log('  • Manually fix unhealable MAP.md refs');
    }
  } else {
    console.log('Workspace is clean. Target state: 0 ✓');
  }
  console.log('');

  return results;
}

/**
 * Find tasks claimed but not completed after 3+ days
 */
function findStaleTasks(atrisDir) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile) ? todoFile :
                       fs.existsSync(legacyFile) ? legacyFile : null;

  if (!taskFilePath) return [];

  const content = fs.readFileSync(taskFilePath, 'utf8');
  const staleTasks = [];

  const inProgressMatch = content.match(/## In Progress\n([\s\S]*?)(?=\n##|$)/);
  if (!inProgressMatch || !inProgressMatch[1].trim()) return [];

  const inProgressSection = inProgressMatch[1];
  const taskBlocks = inProgressSection.split(/\n### /).filter(b => b.trim());

  for (const block of taskBlocks) {
    const titleMatch = block.match(/Task:\s*(.+)/);
    const claimMatch = block.match(/\*\*Claimed by:\*\*\s*(.+?)(?:\s+at\s+(.+))?$/m);

    if (titleMatch) {
      const title = titleMatch[1].trim();
      const claimed = claimMatch ? claimMatch[0] : null;

      if (claimMatch && claimMatch[2]) {
        const claimDate = new Date(claimMatch[2]);
        const now = new Date();
        const daysSinceClaim = (now - claimDate) / (1000 * 60 * 60 * 24);

        if (daysSinceClaim > 3) {
          staleTasks.push({ title, claimed, daysSinceClaim: Math.floor(daysSinceClaim) });
        }
      } else if (claimed) {
        staleTasks.push({ title, claimed, daysSinceClaim: '?' });
      }
    }
  }

  return staleTasks;
}

/**
 * Find and heal broken MAP.md references
 * Returns { healed: number, unhealable: array }
 */
function healBrokenMapRefs(cwd, atrisDir, dryRun = false) {
  const mapFile = path.join(atrisDir, 'MAP.md');
  if (!fs.existsSync(mapFile)) return { healed: 0, unhealable: [] };

  let mapContent = fs.readFileSync(mapFile, 'utf8');
  const unhealable = [];
  let healed = 0;

  // Match patterns like `file.js:123` with surrounding context
  // Capture: full match, file path, extension, line number, and context after
  const refPattern = /(`?)([a-zA-Z0-9_\-./\\]+\.(js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)(`?)(\s*[\(\[—\-]?\s*([^)\]\n]+))?/g;

  const replacements = [];
  let match;

  while ((match = refPattern.exec(mapContent)) !== null) {
    const fullMatch = match[0];
    const backtickBefore = match[1] || '';
    const filePath = match[2];
    const ext = match[3];
    const lineNum = parseInt(match[4], 10);
    const backtickAfter = match[5] || '';
    const contextPart = match[7] || '';

    const fullPath = path.join(cwd, filePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      unhealable.push({ file: filePath, line: lineNum, reason: 'File not found' });
      continue;
    }

    // Read file and check line number
    let fileContent;
    try {
      fileContent = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      unhealable.push({ file: filePath, line: lineNum, reason: `Cannot read: ${err.message}` });
      continue;
    }

    const lines = fileContent.split('\n');

    // If line number is valid, skip
    if (lineNum <= lines.length) {
      continue;
    }

    // Line number is broken - try to heal
    const symbol = extractSymbol(contextPart);

    if (!symbol) {
      unhealable.push({ file: filePath, line: lineNum, reason: 'No symbol to search for' });
      continue;
    }

    // Search for the symbol in the file
    const newLine = findSymbolLine(fileContent, symbol);

    if (!newLine) {
      unhealable.push({ file: filePath, line: lineNum, reason: `Symbol "${symbol}" not found` });
      continue;
    }

    // Record the replacement
    const oldRef = `${backtickBefore}${filePath}:${lineNum}${backtickAfter}`;
    const newRef = `${backtickBefore}${filePath}:${newLine}${backtickAfter}`;

    replacements.push({ old: oldRef, new: newRef, symbol });
    healed++;
  }

  // Apply replacements
  if (!dryRun && replacements.length > 0) {
    for (const r of replacements) {
      mapContent = mapContent.replace(r.old, r.new);
    }
    fs.writeFileSync(mapFile, mapContent);
  }

  return { healed, unhealable };
}

/**
 * Extract a symbol name from context like "(atrisDevEntry function)" or "— Main entry"
 */
function extractSymbol(context) {
  if (!context) return null;

  // Clean up the context
  const cleaned = context.trim()
    .replace(/^[\(\[—\-:]+\s*/, '')  // Remove leading punctuation
    .replace(/[\)\]]+$/, '')          // Remove trailing brackets
    .trim();

  if (!cleaned) return null;

  // Try to extract a function/class/variable name
  // Pattern: word that looks like an identifier
  const identifierMatch = cleaned.match(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:Atris|Entry|Handler|Cmd|Function|Class)?)\b/i);

  if (identifierMatch) {
    return identifierMatch[1];
  }

  // Fallback: first word
  const firstWord = cleaned.split(/\s+/)[0];
  if (firstWord && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(firstWord)) {
    return firstWord;
  }

  return null;
}

/**
 * Find the line number where a symbol is defined
 */
function findSymbolLine(fileContent, symbol) {
  const lines = fileContent.split('\n');

  // Patterns to match symbol definitions
  const patterns = [
    // function name(
    new RegExp(`^\\s*(async\\s+)?function\\s+${escapeRegExp(symbol)}\\s*\\(`),
    // const/let/var name =
    new RegExp(`^\\s*(const|let|var)\\s+${escapeRegExp(symbol)}\\s*=`),
    // class name
    new RegExp(`^\\s*class\\s+${escapeRegExp(symbol)}\\b`),
    // name: function or name() {
    new RegExp(`^\\s*${escapeRegExp(symbol)}\\s*[:(]`),
    // exports.name or module.exports.name
    new RegExp(`exports\\.${escapeRegExp(symbol)}\\s*=`),
    // def name( for Python
    new RegExp(`^\\s*def\\s+${escapeRegExp(symbol)}\\s*\\(`),
    // Just the symbol on a line (loose match)
    new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
  ];

  // Try strict patterns first
  for (let i = 0; i < patterns.length - 1; i++) {
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (patterns[i].test(lines[lineIdx])) {
        return lineIdx + 1; // 1-indexed
      }
    }
  }

  // Fallback: loose match (just contains the symbol)
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (patterns[patterns.length - 1].test(lines[lineIdx])) {
      return lineIdx + 1;
    }
  }

  return null;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Archive journals older than 30 days
 */
function archiveOldJournals(atrisDir, dryRun = false) {
  const logsDir = path.join(atrisDir, 'logs');
  if (!fs.existsSync(logsDir)) return 0;

  const archiveDir = path.join(logsDir, 'archive');
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let archived = 0;

  const yearFolders = fs.readdirSync(logsDir).filter(name => {
    const full = path.join(logsDir, name);
    return fs.statSync(full).isDirectory() && /^\d{4}$/.test(name) && name !== 'archive';
  });

  for (const year of yearFolders) {
    const yearDir = path.join(logsDir, year);
    const files = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]);
      if (fileDate < thirtyDaysAgo) {
        if (!dryRun) {
          const archiveYearDir = path.join(archiveDir, year);
          if (!fs.existsSync(archiveYearDir)) {
            fs.mkdirSync(archiveYearDir, { recursive: true });
          }
          const src = path.join(yearDir, file);
          const dest = path.join(archiveYearDir, file);
          fs.renameSync(src, dest);
        }
        archived++;
      }
    }
  }

  return archived;
}

/**
 * Clean empty sections from TODO.md
 */
function cleanEmptySections(atrisDir, dryRun = false) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  if (!fs.existsSync(todoFile)) return 0;

  let content = fs.readFileSync(todoFile, 'utf8');
  let cleaned = 0;

  const emptyPatterns = [
    /\n### [^\n]+\n+\(empty\)\n*/gi,
    /\n### [^\n]+\n+\(No [^\)]+\)\n*/gi,
    /\n### [^\n]+\n+\(See [^\)]+\)\n*/gi
  ];

  for (const pattern of emptyPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      cleaned += matches.length;
      if (!dryRun) {
        content = content.replace(pattern, '\n');
      }
    }
  }

  if (cleaned > 0 && !dryRun) {
    content = content.replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(todoFile, content);
  }

  return cleaned;
}

module.exports = {
  cleanAtris,
  findStaleTasks,
  healBrokenMapRefs,
  archiveOldJournals,
  cleanEmptySections
};
