#!/usr/bin/env node
'use strict';

// Shows which real lines a change to the slop fixer moves. Collects every
// unique line with a dash from the markdown under the given folders, runs the
// fixer from a git ref (default HEAD) and the fixer in the working copy over
// them, and prints the lines where the two disagree. A fixer change that
// should move one line and moves forty shows up here before it lands.
//
//   node scripts/slop-fix-diff.js ~/notes ../other-repo
//   node scripts/slop-fix-diff.js --base master --limit 50 docs/

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.agent-worktrees']);
const PROSE_EXT = /\.(?:md|mdx|txt)$/i;
const DASH = '\u2014';
const CHUNK = 500;

function collectFiles(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) { if (PROSE_EXT.test(target)) out.push(target); return out; }
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) collectFiles(full, out); }
    else if (entry.isFile() && PROSE_EXT.test(entry.name) && fs.statSync(full).size < 400 * 1024) out.push(full);
  }
  return out;
}

// Unique dashed lines, short enough to be prose and outside fence markers.
// A line inside a fenced block in markdown is code the real fix never
// touches, so it is left out, found by the fixer's own fence reader.
function dashedLines(files) {
  const { fencedLines } = require(path.join(ROOT, 'commands', 'slop.js'));
  const seen = new Set();
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const fenced = /\.mdx?$/i.test(file) ? fencedLines(lines) : new Set();
    lines.forEach((line, i) => {
      if (line.includes(DASH) && line.length < 400 && !line.includes('```') && !fenced.has(i)) seen.add(line);
    });
  }
  return [...seen];
}

// Load commands/slop.js as it was at a git ref, compiled in memory under the
// real path so its relative requires still resolve.
function loadFixerAt(ref) {
  const source = execFileSync('git', ['show', `${ref}:commands/slop.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const filename = path.join(ROOT, 'commands', 'slop.js');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  return mod.exports;
}

// Fix lines in chunks, one paragraph each, so a dash at a line end reads as
// the end of its paragraph the same way under both fixers.
function fixAll(fixer, lines, dir) {
  const file = path.join(dir, 'chunk.md');
  const fixed = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    const part = lines.slice(i, i + CHUNK);
    fs.writeFileSync(file, part.join('\n\n'));
    fixer.applyFixes([file], fixer.RULES);
    fixed.push(...fs.readFileSync(file, 'utf8').split('\n\n'));
  }
  return fixed;
}

function main(argv) {
  let base = 'HEAD';
  let limit = 25;
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--limit') limit = Number(argv[++i]) || 0;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node scripts/slop-fix-diff.js [--base <ref>] [--limit <n>] <folder or file>...');
      return 0;
    } else targets.push(argv[i]);
  }
  if (!targets.length) {
    console.error('usage: node scripts/slop-fix-diff.js [--base <ref>] [--limit <n>] <folder or file>...');
    return 2;
  }
  const files = [];
  for (const t of targets) collectFiles(path.resolve(t), files);
  const lines = dashedLines(files);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fix-diff-'));
  try {
    const before = fixAll(loadFixerAt(base), lines, dir);
    const after = fixAll(require(path.join(ROOT, 'commands', 'slop.js')), lines, dir);
    const moved = [];
    lines.forEach((line, i) => { if (before[i] !== after[i]) moved.push({ line, before: before[i], after: after[i] }); });
    for (const m of moved.slice(0, limit)) {
      console.log(`  was  ${m.before}`);
      console.log(`  now  ${m.after}\n`);
    }
    console.log(`${lines.length} dashed line${lines.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}; ${moved.length} moved against ${base}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
