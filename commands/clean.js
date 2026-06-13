const fs = require('fs');
const path = require('path');
const escapeRegExp = require('../lib/escape-regexp');

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

  // 5. Find stale wiki pages (source newer than last_compiled)
  const stalePages = findStalePages(cwd, atrisDir);
  results.stalePages = stalePages;

  // Report results
  console.log('Results:');
  console.log('');

  // Stale tasks
  if (staleTasks.length > 0) {
    console.log(`⚠ ${staleTasks.length} stale ${staleTasks.length === 1 ? 'task' : 'tasks'} (claimed >3 days, not completed):`);
    staleTasks.forEach(task => {
      console.log(`   • ${task.title.substring(0, 50)}${task.title.length > 50 ? '...' : ''}`);
    });
    console.log('');
  } else {
    console.log('✓ No stale tasks');
  }

  // Healed refs
  if (healed > 0) {
    const verb = options.dryRun ? 'Would heal' : 'Healed';
    console.log(`✓ ${verb} ${healed} MAP.md ${healed === 1 ? 'reference' : 'references'}`);
  }

  // Unhealable refs
  if (unhealable.length > 0) {
    console.log(`⚠ ${unhealable.length} MAP.md ${unhealable.length === 1 ? 'ref' : 'refs'} couldn't be healed:`);
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
    const verb = options.dryRun ? 'Would archive' : 'Archived';
    console.log(`✓ ${verb} ${archived} old journal(s)`);
  } else {
    console.log('✓ No journals need archiving');
  }

  // Cleaned sections
  if (cleaned > 0) {
    const verb = options.dryRun ? 'Would clean' : 'Cleaned';
    console.log(`✓ ${verb} ${cleaned} empty section(s)`);
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');

  // Stale pages
  if (stalePages.length > 0) {
    console.log(`⚠ ${stalePages.length} stale ${stalePages.length === 1 ? 'page' : 'pages'} (source changed since last compiled):`);
    stalePages.forEach(sp => {
      console.log(`   • ${path.relative(cwd, sp.page)} — stale source: ${sp.staleSource}`);
    });
    console.log('');
  } else {
    console.log('✓ No stale wiki pages');
  }

  const hasIssues = staleTasks.length > 0 || unhealable.length > 0 || stalePages.length > 0;
  if (hasIssues) {
    console.log('Manual action needed:');
    if (staleTasks.length > 0) {
      console.log('  • Delete stale tasks or finish them');
    }
    if (unhealable.length > 0) {
      console.log('  • Manually fix unhealable MAP.md refs');
    }
    if (stalePages.length > 0) {
      console.log('  • Re-compile stale pages (re-read sources, update content + last_compiled)');
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
 * Find and heal broken MAP.md references (single-line AND range refs)
 * Detects both out-of-bounds AND drift (symbol moved to different line)
 * Returns { healed: number, unhealable: array }
 */
function healBrokenMapRefs(cwd, atrisDir, dryRun = false) {
  const mapFile = path.join(atrisDir, 'MAP.md');
  if (!fs.existsSync(mapFile)) return { healed: 0, unhealable: [] };

  let mapContent = fs.readFileSync(mapFile, 'utf8');
  const unhealable = [];
  let healed = 0;

  // Match both `file.js:123` and `file.js:123-456` with surrounding context
  // [^\S\n] = horizontal whitespace only (no newlines)
  // Required delimiter [(,[,—,-] prevents bleeding into adjacent refs on same line
  const refPattern = /(`?)([a-zA-Z0-9_\-./\\]+\.(js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)(?:-(\d+))?(`?)([^\S\n]*[\(\[—\-][^\S\n]*([^)\]\n]+))?/g;

  // Function Inventory form: `symbolName()` → `file:line[-line]`
  // Pre-scan to build a (file:line) → symbol map so refs with the symbol BEFORE them still verify.
  const preRefSymbols = {};
  const preRefPattern = /`([a-zA-Z_][a-zA-Z0-9_]*)\s*\(?\s*\)?`\s*(?:→|->)\s*`([a-zA-Z0-9_\-./\\]+\.(?:js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)(?:-\d+)?`/g;
  let preMatch;
  while ((preMatch = preRefPattern.exec(mapContent)) !== null) {
    preRefSymbols[`${preMatch[2]}:${preMatch[3]}`] = preMatch[1];
  }

  // Cache file reads
  const fileCache = {};
  function readFileCached(filePath) {
    if (!fileCache[filePath]) {
      const fullPath = path.join(cwd, filePath);
      if (!fs.existsSync(fullPath)) return null;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        fileCache[filePath] = { content, lines: content.split('\n') };
      } catch { return null; }
    }
    return fileCache[filePath];
  }

  const replacements = [];
  let match;

  while ((match = refPattern.exec(mapContent)) !== null) {
    const backtickBefore = match[1] || '';
    const filePath = match[2];
    const startLine = parseInt(match[4], 10);
    const endLine = match[5] ? parseInt(match[5], 10) : null;
    const backtickAfter = match[6] || '';
    const contextPart = match[8] || '';

    const file = readFileCached(filePath);
    if (!file) {
      unhealable.push({ file: filePath, line: startLine, reason: 'File not found' });
      continue;
    }

    let symbol = extractSymbol(contextPart);
    if (!symbol) symbol = preRefSymbols[`${filePath}:${startLine}`] || null;

    // Check if reference is still accurate
    const outOfBounds = startLine > file.lines.length || (endLine && endLine > file.lines.length);
    const drifted = symbol && startLine <= file.lines.length && !symbolAtLine(file.content, symbol, startLine);

    if (!outOfBounds && !drifted) continue;

    if (!symbol) {
      unhealable.push({ file: filePath, line: startLine, reason: 'No symbol to search for' });
      continue;
    }

    // Find where the symbol actually is now
    const newStart = findSymbolLine(file.content, symbol);
    if (!newStart) {
      unhealable.push({ file: filePath, line: startLine, reason: `Symbol "${symbol}" not found` });
      continue;
    }

    if (endLine) {
      // Range ref: find new end by scanning for function end
      const originalSpan = endLine - startLine;
      const newEnd = findFunctionEnd(file.lines, newStart) || (newStart + originalSpan);
      const clampedEnd = Math.min(newEnd, file.lines.length);

      const oldRef = `${backtickBefore}${filePath}:${startLine}-${endLine}${backtickAfter}`;
      const newRef = `${backtickBefore}${filePath}:${newStart}-${clampedEnd}${backtickAfter}`;

      if (oldRef !== newRef) {
        replacements.push({ old: oldRef, new: newRef, symbol });
        healed++;
      }
    } else {
      // Single-line ref
      const oldRef = `${backtickBefore}${filePath}:${startLine}${backtickAfter}`;
      const newRef = `${backtickBefore}${filePath}:${newStart}${backtickAfter}`;

      if (oldRef !== newRef) {
        replacements.push({ old: oldRef, new: newRef, symbol });
        healed++;
      }
    }
  }

  // Apply replacements
  if (!dryRun && replacements.length > 0) {
    for (const r of replacements) {
      mapContent = mapContent.split(r.old).join(r.new);
    }
    fs.writeFileSync(mapFile, mapContent);
  }

  return { healed, unhealable, replacements: dryRun ? replacements : [] };
}

/**
 * Check if a symbol is actually defined at or near a given line
 */
function symbolAtLine(fileContent, symbol, lineNum) {
  const lines = fileContent.split('\n');
  // Check a 5-line window around the referenced line
  const start = Math.max(0, lineNum - 3);
  const end = Math.min(lines.length, lineNum + 2);
  const escaped = escapeRegExp(symbol);
  const re = new RegExp(`\\b${escaped}\\b`);
  for (let i = start; i < end; i++) {
    if (re.test(lines[i])) return true;
  }
  return false;
}

/**
 * Find the end line of a function starting at startLine (1-indexed)
 * Tracks brace depth to find the matching closing brace
 */
function findFunctionEnd(lines, startLine) {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; foundOpen = true; }
      if (ch === '}') { depth--; }
    }
    if (foundOpen && depth === 0) {
      return i + 1; // 1-indexed
    }
  }

  return null;
}

/**
 * Extract a symbol name from context like "(atrisDevEntry function)" or "— Main entry"
 */
function extractSymbol(context) {
  if (!context) return null;

  // Clean up the context
  const cleaned = context.trim()
    .replace(/`/g, '')                // Strip backticks
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
 * Find the line number where a symbol is defined (strict patterns only)
 * Returns null if only loose matches found — prevents healing to wrong locations
 */
function findSymbolLine(fileContent, symbol) {
  const lines = fileContent.split('\n');
  const esc = escapeRegExp(symbol);

  // Strict definition patterns only — no loose fallback
  const patterns = [
    new RegExp(`^\\s*(async\\s+)?function\\s+${esc}\\s*\\(`),  // function name(
    new RegExp(`^\\s*(const|let|var)\\s+${esc}\\s*=`),          // const/let/var name =
    new RegExp(`^\\s*class\\s+${esc}\\b`),                      // class name
    new RegExp(`^\\s*${esc}\\s*[:(]`),                           // name: or name(
    new RegExp(`exports\\.${esc}\\s*=`),                         // exports.name =
    new RegExp(`^\\s*def\\s+${esc}\\s*\\(`),                     // def name( (Python)
  ];

  for (const pattern of patterns) {
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (pattern.test(lines[lineIdx])) {
        return lineIdx + 1;
      }
    }
  }

  return null;
}

/**
 * Find wiki pages whose sources have been modified after last_compiled.
 * Scans all .md files under atris/ for frontmatter with last_compiled + sources.
 */
function findStalePages(cwd, atrisDir) {
  const stalePages = [];

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'archive' && entry.name !== 'node_modules') {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const result = checkPageStaleness(cwd, fullPath);
        if (result) stalePages.push(result);
      }
    }
  }

  scanDir(atrisDir);
  return stalePages;
}

/**
 * Parse frontmatter from a markdown file and check if any source is newer than last_compiled.
 * Returns { page, staleSource, compiledDate, sourceDate } or null if not stale.
 */
function checkPageStaleness(cwd, filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch { return null; }

  // Check for YAML frontmatter
  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return null;

  const frontmatter = content.substring(3, endIdx);

  // Parse last_compiled
  const compiledMatch = frontmatter.match(/last_compiled:\s*(\d{4}-\d{2}-\d{2})/);
  if (!compiledMatch) return null;

  const compiledDate = new Date(compiledMatch[1] + 'T23:59:59');

  // Parse sources list
  const sourcesMatch = frontmatter.match(/sources:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (!sourcesMatch) return null;

  const sources = sourcesMatch[1]
    .split('\n')
    .map(line => line.replace(/^\s+-\s+/, '').trim())
    .filter(Boolean);

  // Check each source's mtime against last_compiled.
  // Source entries can include a line range and/or a parenthesized annotation,
  // e.g. "bin/atris.js:199-340 (showHelp function)" — strip both before stat.
  for (const source of sources) {
    const filePart = source
      .replace(/\s*\([^)]*\)\s*$/, '')   // drop trailing "(annotation)"
      .replace(/:\d+(-\d+)?$/, '')        // drop trailing ":N" or ":N-M"
      .trim();
    const sourcePath = path.isAbsolute(filePart) ? filePart : path.join(cwd, filePart);
    try {
      const stat = fs.statSync(sourcePath);
      if (stat.mtime > compiledDate) {
        return {
          page: filePath,
          staleSource: source,
          compiledDate: compiledMatch[1],
          sourceDate: stat.mtime.toISOString().split('T')[0]
        };
      }
    } catch {
      // Source file doesn't exist — that's also a staleness signal
      return {
        page: filePath,
        staleSource: source + ' (missing)',
        compiledDate: compiledMatch[1],
        sourceDate: 'N/A'
      };
    }
  }

  return null;
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
  cleanEmptySections,
  findStalePages,
  checkPageStaleness
};
