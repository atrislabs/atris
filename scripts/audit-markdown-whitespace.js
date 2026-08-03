'use strict';

// Lists markdown files with trailing whitespace; --fix strips it in place.
// Exists because the diff cleanliness verifier (git diff --check) fails tasks
// over trailing whitespace in .md files, which is auto-fixable, not a defect.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.agent-worktrees']);

function collectMarkdownFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function trailingWhitespaceLines(content) {
  const lines = String(content).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/[ \t]+$/.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

function stripTrailingWhitespace(content) {
  return String(content).replace(/[ \t]+$/gm, '');
}

function run(argv) {
  const fix = argv.includes('--fix');
  const root = process.cwd();
  const files = collectMarkdownFiles(root);
  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const hits = trailingWhitespaceLines(content);
    if (!hits.length) continue;
    const rel = path.relative(root, file) || file;
    offenders.push({ rel, hits });
    if (fix) fs.writeFileSync(file, stripTrailingWhitespace(content));
  }

  if (!offenders.length) {
    console.log(`clean: no trailing whitespace in ${files.length} markdown files`);
    return 0;
  }

  for (const { rel, hits } of offenders) {
    const preview = hits.slice(0, 5).join(', ');
    const more = hits.length > 5 ? `, +${hits.length - 5} more` : '';
    console.log(`${fix ? 'fixed' : 'offending'}: ${rel} (lines ${preview}${more})`);
  }
  const total = offenders.reduce((sum, o) => sum + o.hits.length, 0);
  if (fix) {
    console.log(`stripped trailing whitespace from ${offenders.length} file(s), ${total} line(s)`);
    return 0;
  }
  console.log(`${offenders.length} markdown file(s) have trailing whitespace; run: npm run audit:markdown-whitespace -- --fix`);
  return 1;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, collectMarkdownFiles, trailingWhitespaceLines, stripTrailingWhitespace };
