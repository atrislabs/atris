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
// With --audit no base fixer runs: every fix the working fixer makes is
// checked against the writer's own text, so the odd marks it still writes
// anywhere come out as one count to drive to zero.
// With --splices no base fixer runs either: every place the working fixer
// turns a dash into a comma right before "the", "its", "our", "their" or
// "your" and what reads like a subject and a verb is listed, each fix once,
// so the splices still left are one count to drive down.
// With --which each probe also lists the dash rules that match at each of
// its dashes, in the order the fix tries them, and the checks their
// callbacks run that match there, some to allow a join and some to block
// it, so a wrong join starts from the rule that made it, not a guess.
// With --probe the text given is the corpus: each probe is fixed by the
// base fixer and the working one and printed in full, moved or not, so a
// rule change can be checked on one line without a throwaway script.
// A typed \u2014 in a probe becomes a dash and a typed \n a line break, so
// the shell never has to carry either. With --probe-file the probes come
// from a file, each line followed by "=> " and the fix it must give; a fix
// that differs prints its "want" line and the run exits 1, so a file of
// known edges is one command to check after any rule change. A "~> " line
// names a known gap instead: it prints and counts, but never fails.
//
//   node scripts/slop-fix-diff.js ~/notes ../other-repo
//   node scripts/slop-fix-diff.js --base master --limit 50 docs/
//   node scripts/slop-fix-diff.js --lines ~/notes
//   node scripts/slop-fix-diff.js --audit ~/notes
//   node scripts/slop-fix-diff.js --splices ~/notes
//   node scripts/slop-fix-diff.js --probe 'We fixed it \u2014 the loop kicks work.'
//   node scripts/slop-fix-diff.js --probe-file test/fixtures/slop-fix-edges.txt
//   node scripts/slop-fix-diff.js --which --probe 'One place \u2014 the team calls schedule.'

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
// T., via the site)". A dot that opens a file name or an extension is part
// of the name, so a colon before it is plain: "**local**: .claude/".
const DOUBLED = /[,;:]\s*(?:[,;:!?]|\.(?![\w/]))|\(\s*[,;:]|[,;:]\s*\)|\.\s*,|,\s*,/g;
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
// An opener covers only its own first half: once a comma has led to a
// subject ("If it holds, you ship the plan"), a later splice still counts.
// A dash, a comma before a joining word ("helps, and when it doesn't,
// we tell you"), a new list item, or a stop inside a closing bold mark or quote
// ("**Body:**") ends the sentence, so a splice the writer put after a dash
// is theirs in the source too, and a leading quote hides no opener.
// A part that ends on a bare "when" or "if" still waits for its clause, so
// "even when, especially when, it has" is no splice.
const SPLICE = /,\s+(?:(?:it|we|they|he|she|I)(?:['\u2019](?:s|re|ll|ve|d|m))?\s+[a-z]|(?:this|that|these|those|there)(?:['\u2019]s|\s+(?:is|are|was|were|will|would|can|must|should|has|have)\b))/g;
const OPENS_FIRST_HALF = /^(?:(?:but|and|so|yet|or|then)\s+)?(?:if|when|whenever|once|because|since|although|though|while|unless|until|after|before|as|(?:each|every|any)\s+time)\b/i;
const SECOND_HALF = /,\s+(?:you|it|we|they|he|she|I)(?:['\u2019](?:s|re|ll|ve|d|m))?\s+[a-z]/;
const SENTENCE_STOP = /[.!?;:|][*_"'\u201d\u2019)]*\s|\s*\u2014\s*|,\s+(?=(?:and|but|so|yet|or)\s)|\n(?=\s*(?:[-*+]|\d+[.)])\s)/;
const WAITS_FOR_CLAUSE = /\b(?:if|when|whenever|once|because|since|although|though|while|unless|until)$/i;
const NO_CLAUSE = /^(?:(?:hi|hello|hey|dear)\b.*|thanks|thank you|yes|no|ok|okay|sure|well|right)$/i;
function splices(text) {
  let count = 0;
  for (const m of text.matchAll(SPLICE)) {
    const sentence = text.slice(0, m.index).split(SENTENCE_STOP).pop().replace(/^(?:[-*+>#|]\s*|\d+[.)]\s*|\*\*|__|["\u201c'(]\s*)*/, '').trim();
    if (!(OPENS_FIRST_HALF.test(sentence) && !SECOND_HALF.test(sentence)) && !NO_CLAUSE.test(sentence) && !WAITS_FOR_CLAUSE.test(sentence)) count += 1;
  }
  return count;
}

// A comma the fix wrote before "the", "its" and kin where the source had a
// dash, followed by one or two words, a word in "s" and a lowercase word,
// a number or a quote: "the RL policy learns this", "the server returns
// the payload". The fixer's own phrase reads are left out: a word in "s"
// before "that", "which" or "who", or a "that" inside the subject ("the
// API that turns"), is a noun with a clause on it, and a number word or
// "same" after "the" makes a plural ("the three ways a run fails").
// A word in "s" right after "in" or "of" is a noun ("the stubs in tests"),
// and so is a word in "s" with a clause on it that ends on its own verb:
// "the live markdown docs the editor renders" names docs. A "the" inside
// that stretch means an object, so "the learner watches the model do the
// reps" stays a splice. The list reads this on its own, not through the
// fixer's phrase checks, since it is there to show what the fixer misreads.
// A possessive in that stretch opens a new noun, as the fixer reads it, so
// "the way her eyes moved" names the way.
// Code spans count as one name, so a template line repeated once per app
// is one fix, not thirty. A lone answer word or greeting before the comma
// takes it rightly, the same as in the odd count: "YES, the test was
// tolerating a fallback" is no splice.
const SPLICE_SHAPE = /^(?:the|its|our|their|your) (?!(?:one|two|three|four|five|six|seven|eight|nine|ten|few|many|several|same|other|first|last|next|main|key|core|new|old|real|whole|exact|only)\b)(?:(?!(?:that|which|who|your|our|their|its|his|her|my)\b)[\w`-]+ ){1,2}(?<!\b(?:in|of) )(?!(?:this|his|its|thus|plus|always|perhaps|unless|whereas|across)\b)[a-z]+[^su\s']s (?!(?:that|which|who)\b)(?:[a-z`"]|\d)/;
const RELATIVE_SHAPE = /^(?:the|its|our|their|your) (?:[\w`-]+ ){0,2}[a-z]+s the (?:(?!(?:the|a|an)\b)\S+ ){1,3}[a-z]+s$/;
function spliceShapes(sources, fixes) {
  const found = new Map();
  sources.forEach((source, i) => {
    const fixed = fixes[i];
    if (fixed === source) return;
    for (const m of fixed.matchAll(/, ((?:the|its|our|their|your) [^,;.!?\n]*)/g)) {
      const rest = m[1];
      if (!source.includes(`${DASH} ${rest}`) || !SPLICE_SHAPE.test(rest) || RELATIVE_SHAPE.test(rest)) continue;
      const sentence = fixed.slice(0, m.index).split(SENTENCE_STOP).pop().replace(/^(?:[-*+>#|]\s*|\d+[.)]\s*|\*\*|__|["\u201c'(]\s*)*/, '').trim();
      if (NO_CLAUSE.test(sentence)) continue;
      const key = rest.replace(/`[^`]*`/g, '``');
      if (!found.has(key)) found.set(key, { text: rest, count: 0 });
      found.get(key).count += 1;
    }
  });
  return [...found.values()];
}

// Loads the working fixer with every pattern that reads a dash exported:
// the ones the dash fix runs as a replace, in its order, and the ones its
// callbacks test as a check. A replace rule matches where one of its
// matches starts at the space before the dash; a check is tested on the
// text from there, the way the callbacks call it.
function dashRules() {
  const file = path.join(ROOT, 'commands', 'slop.js');
  const source = fs.readFileSync(file, 'utf8');
  const names = [...source.matchAll(/^const ([A-Z][A-Z0-9_]*) = (?:new RegExp\(|\/)/gm)].map((m) => m[1]);
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(`${source}\nmodule.exports.__dashRules = { ${names.join(', ')} };`, file);
  const body = source.slice(source.indexOf('function fixEmDash('));
  const order = (name) => body.indexOf(`.replace(${name},`);
  const all = Object.entries(mod.exports.__dashRules).filter(([, re]) => re instanceof RegExp && re.source.includes('\\u2014'));
  return {
    rules: all.filter(([name]) => order(name) >= 0).sort((a, b) => order(a[0]) - order(b[0])),
    checks: all.filter(([name]) => order(name) < 0 && name !== 'DASH'),
  };
}

function whichLines(text, { rules, checks }) {
  const out = [];
  for (const m of text.matchAll(/\s*\u2014/g)) {
    const at = m.index;
    const tries = rules.filter(([, re]) => [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))].some((hit) => hit.index === at)).map(([name]) => name);
    const held = checks.filter(([, re]) => new RegExp(re.source, re.flags.replace('g', '')).test(text.slice(at))).map(([name]) => name);
    out.push(`  tries ${tries.join(', ') || '(none)'}${held.length ? `; checks ${held.join(', ')}` : ''}`);
  }
  return out;
}

const USAGE = 'usage: node scripts/slop-fix-diff.js [--base <ref>] [--limit <n>] [--lines] [--audit] [--splices] <folder or file>...\n' +
  '       node scripts/slop-fix-diff.js [--base <ref>] --probe "<text>" [--probe "<text>"]... [--probe-file <file>] [--which]';

// Fixes each probe with the base fixer and the working one and prints every
// probe, so the answer to "what does the fixer do to this line" is one run.
// A typed \u2014 in a probe is a dash and a typed \n a line break.
function expandTyped(text) {
  return text.replace(/\\u2014/g, DASH).replace(/\\n/g, '\n');
}

// Reads a file of probes: a line is a probe, a "=> " line under it is the
// fix it must give, a "~> " line is the fix it should give but does not
// yet (a known gap), and "#" lines and blank lines are notes.
function readProbeFile(file, probes, wants, gaps) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (line.startsWith('=> ')) wants[probes.length - 1] = expandTyped(line.slice(3));
    else if (line.startsWith('~> ')) gaps[probes.length - 1] = expandTyped(line.slice(3));
    else probes.push(expandTyped(line));
  }
}

// A gap never fails the run: it counts as open until the fixer gives the
// fix it names, so closing gaps is a number that moves.
function probe(probes, base, wants = [], gaps = [], which = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fix-diff-'));
  const show = (text) => text.split('\n').join(' / ');
  try {
    const before = fixAll(loadFixerAt(base), probes, dir);
    const after = fixAll(require(path.join(ROOT, 'commands', 'slop.js')), probes, dir);
    let moved = 0;
    let missed = 0;
    let open = 0;
    probes.forEach((text, i) => {
      const gap = gaps[i] !== undefined && gaps[i] !== after[i] ? gaps[i] : null;
      if (gap !== null) open += 1;
      if (before[i] !== after[i]) moved += 1;
      const want = wants[i] !== undefined && wants[i] !== after[i] ? wants[i] : null;
      if (want !== null) missed += 1;
      const odd = oddMarks(text, after[i]);
      console.log(`  was   ${show(text)}`);
      console.log(`  ${base === 'HEAD' ? 'head' : 'base'}  ${show(before[i])}`);
      console.log(`  now   ${show(after[i])}${before[i] === after[i] ? '' : '  (moved)'}`);
      if (want !== null) console.log(`  want  ${show(want)}`);
      if (gap !== null) console.log(`  gap   ${show(gap)}`);
      if (odd.length) console.log(`  odd   ${odd.join(', ')}`);
      if (which) for (const line of whichLines(text, which)) console.log(line);
      console.log('');
    });
    console.log(`${probes.length} probe${probes.length === 1 ? '' : 's'}; ${moved} moved against ${base}`);
    const checked = wants.filter((w) => w !== undefined).length;
    if (checked) console.log(`${checked - missed} of ${checked} match the fix they must give`);
    const known = gaps.filter((g) => g !== undefined).length;
    if (known) console.log(`${open} of ${known} known gap${known === 1 ? '' : 's'} still open`);
    return missed ? 1 : 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  let base = 'HEAD';
  let limit = 25;
  let paragraphs = true;
  let audit = false;
  let spliceList = false;
  let which = false;
  const probes = [];
  const wants = [];
  const gaps = [];
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--limit') limit = Number(argv[++i]) || 0;
    else if (argv[i] === '--paragraphs') paragraphs = true;
    else if (argv[i] === '--lines') paragraphs = false;
    else if (argv[i] === '--audit') audit = true;
    else if (argv[i] === '--splices') spliceList = true;
    else if (argv[i] === '--which') which = true;
    else if (argv[i] === '--probe') probes.push(expandTyped(argv[++i] || ''));
    else if (argv[i] === '--probe-file') readProbeFile(path.resolve(argv[++i] || ''), probes, wants, gaps);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      return 0;
    } else targets.push(argv[i]);
  }
  if (probes.length) return probe(probes, base, wants, gaps, which ? dashRules() : null);
  if (!targets.length) {
    console.error(USAGE);
    return 2;
  }
  const files = [];
  for (const t of targets) collectFiles(path.resolve(t), files);
  const lines = paragraphs ? dashedParagraphs(files) : dashedLines(files);
  const unit = paragraphs ? 'dashed paragraph' : 'dashed line';
  const show = (text) => text.split('\n').join(' / ');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fix-diff-'));
  const counted = `${lines.length} ${unit}${lines.length === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}`;
  try {
    if (spliceList) {
      const fixed = fixAll(require(path.join(ROOT, 'commands', 'slop.js')), lines, dir);
      const shapes = spliceShapes(lines, fixed);
      for (const shape of shapes.slice(0, limit)) console.log(`  , ${shape.text}${shape.count > 1 ? `  (x${shape.count})` : ''}`);
      console.log(`${counted}; ${shapes.length} fix${shapes.length === 1 ? '' : 'es'} put a comma before "the", "its" or kin and what reads like a subject and a verb`);
      return 0;
    }
    if (audit) {
      const fixed = fixAll(require(path.join(ROOT, 'commands', 'slop.js')), lines, dir);
      const changed = [];
      lines.forEach((line, i) => { if (fixed[i] !== line) changed.push({ line, after: fixed[i], odd: oddMarks(line, fixed[i]) }); });
      const odd = changed.filter((c) => c.odd.length);
      for (const c of odd.slice(0, limit)) {
        console.log(`  was  ${show(c.line)}`);
        console.log(`  now  ${show(c.after)}`);
        console.log(`  odd  ${c.odd.join(', ')}\n`);
      }
      console.log(`${counted}; ${changed.length} fixed`);
      console.log(`${odd.length} of the fixed gained doubled punctuation, unbalanced parentheses, or a comma splice`);
      return 0;
    }
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
    console.log(`${counted}; ${moved.length} moved against ${base}`);
    console.log(`${moved.filter((m) => m.odd.length).length} of the moved gained doubled punctuation, unbalanced parentheses, or a comma splice`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { oddMarks, spliceShapes };
