#!/usr/bin/env node
'use strict';

// Shows which real paragraphs a change to the slop fixer moves. Collects
// every unique paragraph with a dash from the markdown under the given
// folders, runs the fixer from a git ref (default HEAD) and the fixer in the
// working copy over them, and prints the ones where the two disagree. A
// fixer change that should move one line and moves forty shows up here
// before it lands. Whole paragraphs go in because the fixer reads the line
// above a wrapped line, as a real fix does. With --lines it feeds each
// dashed line alone; that mode reports moves on wrapped lines that a real
// fix never makes, so it is only for a quick look at one-line rules.
// A moved line whose new fix holds more doubled punctuation or a different
// parenthesis balance than the source gets an odd mark, so a rule change
// that writes awkward output says so without a hand-written scan.
//
//   node scripts/slop-fix-diff.js ~/notes ../other-repo
//   node scripts/slop-fix-diff.js --base master --limit 50 docs/
//   node scripts/slop-fix-diff.js --lines ~/notes

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

// Unique paragraphs that hold a dash: runs of lines with no blank line
// between them, outside fenced code, up to PARAGRAPH_LINES long. A fence
// marker ends a paragraph, so code never joins the prose around it.
const PARAGRAPH_LINES = 12;
function dashedParagraphs(files) {
  const { fencedLines } = require(path.join(ROOT, 'commands', 'slop.js'));
  const seen = new Set();
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const fenced = /\.mdx?$/i.test(file) ? fencedLines(lines) : new Set();
    let run = [];
    const close = () => {
      if (run.length && run.length <= PARAGRAPH_LINES && run.some((l) => l.includes(DASH))) seen.add(run.join('\n'));
      run = [];
    };
    lines.forEach((line, i) => {
      if (!line.trim() || fenced.has(i) || line.includes('```') || line.length >= 400) close();
      else run.push(line);
    });
    close();
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

// Marks a fix that the writer's own text did not have: two punctuation
// marks in a row (", ," or ":." or "(,"), parentheses that no longer
// balance the way the source did, or a comma splice. Code spans and link
// targets are left out. By default the whole paragraph is one unit, so an
// aside that wraps across lines balances the way it should.
// The period that closes a short form or an initial is part of the word,
// so a comma after it is plain English: "Cooling, Inc., Columbus", "(Alex
// T., via the site)".
const DOUBLED = /[,;:]\s*[,;:.!?]|\(\s*[,;:]|[,;:]\s*\)|\.\s*,|,\s*,/g;
const SHORT_FORM_STOP = /\b(?:etc|e\.g|i\.e|vs|cf|approx|incl|et al|Inc|Ltd|Corp|Co|Jr|Sr|[A-Z])\.(?=\s*,)/gi;
function oddMarks(source, fixed) {
  const plain = (text) => text.replace(/`[^`]*`/g, '``').replace(/\]\([^)]*\)/g, ']');
  const doubled = (text) => (plain(text).replace(SHORT_FORM_STOP, (word) => word.slice(0, -1)).match(DOUBLED) || []).length;
  const balance = (text) => (plain(text).match(/\(/g) || []).length - (plain(text).match(/\)/g) || []).length;
  const marks = [];
  if (doubled(fixed) > doubled(source)) marks.push('doubled punctuation');
  if (balance(fixed) !== balance(source)) marks.push('unbalanced parentheses');
  if (splices(plain(fixed)) > splices(plain(source))) marks.push('comma splice');
  return marks;
}

// A comma right before a pronoun and its verb joins two sentences: "etc.,
// these are category links", "the gate held, it ships". A sentence that
// opens with "if", "when" or their kin is only its first half before that
// comma, so "But when the gate holds, it ships" is no splice. Neither is a
// greeting or a lone answer word: "Hi Maya, this is", "No, this is".
const SPLICE = /,\s+(?:(?:it|we|they|he|she|I)(?:['\u2019](?:s|re|ll|ve|d|m))?\s+[a-z]|(?:this|that|these|those|there)(?:['\u2019]s|\s+(?:is|are|was|were|will|would|can|must|should|has|have)\b))/g;
const OPENS_FIRST_HALF = /^(?:(?:but|and|so|yet|or|then)\s+)?(?:if|when|whenever|once|because|since|although|though|while|unless|until|after|before|as)\b/i;
const NO_CLAUSE = /^(?:(?:hi|hello|hey|dear)\b.*|thanks|thank you|yes|no|ok|okay|sure|well|right)$/i;
function splices(text) {
  let count = 0;
  for (const m of text.matchAll(SPLICE)) {
    const sentence = text.slice(0, m.index).split(/[.!?;:|]\s/).pop().replace(/^(?:[-*+>#|]\s*|\d+[.)]\s*|\*\*|__)*/, '').trim();
    if (!OPENS_FIRST_HALF.test(sentence) && !NO_CLAUSE.test(sentence)) count += 1;
  }
  return count;
}

function main(argv) {
  let base = 'HEAD';
  let limit = 25;
  let paragraphs = true;
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--limit') limit = Number(argv[++i]) || 0;
    else if (argv[i] === '--paragraphs') paragraphs = true;
    else if (argv[i] === '--lines') paragraphs = false;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node scripts/slop-fix-diff.js [--base <ref>] [--limit <n>] [--lines] <folder or file>...');
      return 0;
    } else targets.push(argv[i]);
  }
  if (!targets.length) {
    console.error('usage: node scripts/slop-fix-diff.js [--base <ref>] [--limit <n>] [--lines] <folder or file>...');
    return 2;
  }
  const files = [];
  for (const t of targets) collectFiles(path.resolve(t), files);
  const lines = paragraphs ? dashedParagraphs(files) : dashedLines(files);
  const unit = paragraphs ? 'dashed paragraph' : 'dashed line';
  const show = (text) => text.split('\n').join(' / ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fix-diff-'));
  try {
    const before = fixAll(loadFixerAt(base), lines, dir);
    const after = fixAll(require(path.join(ROOT, 'commands', 'slop.js')), lines, dir);
    const moved = [];
    lines.forEach((line, i) => { if (before[i] !== after[i]) moved.push({ line, before: before[i], after: after[i] }); });
    for (const m of moved) m.odd = oddMarks(m.line, m.after);
    for (const m of moved.slice(0, limit)) {
      console.log(`  was  ${show(m.before)}`);
      console.log(`  now  ${show(m.after)}`);
      if (m.odd.length) console.log(`  odd  ${m.odd.join(', ')}`);
      console.log('');
    }
    console.log(`${lines.length} ${unit}${lines.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}; ${moved.length} moved against ${base}`);
    console.log(`${moved.filter((m) => m.odd.length).length} of the moved gained doubled punctuation, unbalanced parentheses, or a comma splice`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { oddMarks };
