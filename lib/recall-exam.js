'use strict';

// Recall exam: how fast can an agent find the right note by following links?
//
// The reader starts with the boot files, then keeps opening the linked
// markdown file whose link text and line best match the question, the way an
// agent scans an index and follows the line that says when to open it. It never
// greps the whole tree. A question is found when an opened file contains the
// question's needle, an exact answer phrase. Needles survive a file move, so the
// same exam scores a layout before and after notes are split or merged.

const fs = require('fs');
const path = require('path');

const STOP_WORDS = new Set(('the and for are was were where what which who how does did can could should would this that these those '
  + 'with from into about find have has had there here when why our you your its it is be do to of in on at or an a i im me my we us '
  + 'if not no any all one get got make need needs want am will just then than so but by as up out over use using used new before after '
  + 'first next way thing things something someone mid work working about while also only very much more most some same each every').split(' '));
const DEFAULT_MAX_OPENS = 6;
// A real file reader stops after this many lines unless asked for more.
const READ_LINE_CAP = 2000;

function stem(word) {
  return word.replace(/(?:ing|ed|es|s)$/u, '') || word;
}

function keywords(text) {
  return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word)).map(stem))];
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ');
}

function readCapped(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  return lines.length > READ_LINE_CAP ? lines.slice(0, READ_LINE_CAP).join('\n') : text;
}

// Every markdown file a line points at, with the words an agent sees beside it.
function linksIn(text, fromFile, root) {
  const links = [];
  const fromDir = path.dirname(fromFile);
  let heading = '';
  for (const line of text.split('\n')) {
    const head = line.match(/^#{1,6}\s+(.*)/);
    if (head) heading = head[1];
    const targets = [];
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) targets.push({ label: match[1], target: match[2] });
    for (const match of line.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) targets.push({ label: '', target: match[1] });
    for (const match of line.matchAll(/`([^`\s]+\.md)(?:#[^`]*)?`/g)) targets.push({ label: '', target: match[1] });
    for (const { label, target } of targets) {
      const clean = target.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
      if (!/\.md$/i.test(clean) || clean.includes('://')) continue;
      const candidates = [path.resolve(fromDir, clean), path.resolve(root, clean)];
      const resolved = candidates.find(file => file.startsWith(root + path.sep) && fs.existsSync(file));
      if (!resolved) continue;
      links.push({ file: resolved, context: `${label} ${line} ${heading} ${path.basename(clean, '.md')}` });
    }
  }
  return links;
}

function scoreContext(context, words) {
  const have = new Set(keywords(context));
  return words.filter(word => have.has(word)).length;
}

function examineQuestion(root, question, { bootFiles, maxOpens = DEFAULT_MAX_OPENS }) {
  const words = keywords(question.q);
  const needle = normalize(question.needle);
  const opened = [];
  let charsRead = 0;
  let foundIn = null;
  const seen = new Set();
  const frontier = new Map();
  const absorb = (file, text) => {
    seen.add(file);
    for (const link of linksIn(text, file, root)) {
      if (seen.has(link.file)) continue;
      const score = scoreContext(link.context, words);
      const prior = frontier.get(link.file);
      if (!prior || score > prior.score) frontier.set(link.file, { score, order: prior ? prior.order : frontier.size });
    }
    if (!foundIn && normalize(text).includes(needle)) foundIn = path.relative(root, file);
  };
  for (const rel of bootFiles) {
    const file = path.resolve(root, rel);
    const text = readCapped(file);
    if (text === null) continue;
    absorb(file, text);
  }
  while (!foundIn && opened.length < maxOpens) {
    let best = null;
    for (const [file, entry] of frontier) {
      if (seen.has(file) || entry.score === 0) continue;
      if (!best || entry.score > best.score || (entry.score === best.score && entry.order < best.order)) best = { file, ...entry };
    }
    if (!best) break;
    frontier.delete(best.file);
    const text = readCapped(best.file) || '';
    opened.push(path.relative(root, best.file));
    charsRead += text.length;
    absorb(best.file, text);
  }
  return {
    id: question.id, area: question.area || null, found: Boolean(foundIn), found_in: foundIn,
    files_opened: opened.length, opened, tokens_opened: Math.round(charsRead / 4),
    // Every opened file that did not hold the answer was a wasted or misleading read.
    wrong_opens: opened.filter(rel => rel !== foundIn).length,
  };
}

function readQuestions(file) {
  const questions = [];
  const invalid = [];
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { row = null; }
    if (!row || typeof row.q !== 'string' || typeof row.needle !== 'string' || !row.needle.trim()) invalid.push(index + 1);
    else questions.push(row);
  });
  return { questions, invalid };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runRecallExam(root, questionsFile, { bootFiles, maxOpens = DEFAULT_MAX_OPENS } = {}) {
  const { questions, invalid } = readQuestions(questionsFile);
  const bootChars = bootFiles.reduce((sum, rel) => sum + (readCapped(path.resolve(root, rel)) || '').length, 0);
  const results = questions.map(question => examineQuestion(root, question, { bootFiles, maxOpens }));
  const found = results.filter(result => result.found);
  const opens = results.map(result => result.files_opened);
  const tokens = results.map(result => result.tokens_opened);
  const wrong = results.map(result => result.wrong_opens);
  const byArea = {};
  for (const result of results) {
    const area = result.area || 'none';
    byArea[area] = byArea[area] || { total: 0, found: 0 };
    byArea[area].total++;
    if (result.found) byArea[area].found++;
  }
  return {
    questions: results.length, invalid_lines: invalid, max_opens: maxOpens,
    boot_tokens: Math.round(bootChars / 4),
    found: found.length, found_share: results.length ? found.length / results.length : null,
    files_opened: { total: opens.reduce((a, b) => a + b, 0), median: median(opens), mean: results.length ? opens.reduce((a, b) => a + b, 0) / results.length : null },
    wrong_opens: { total: wrong.reduce((a, b) => a + b, 0), median: median(wrong), mean: results.length ? wrong.reduce((a, b) => a + b, 0) / results.length : null },
    tokens_opened: { total: tokens.reduce((a, b) => a + b, 0), median: median(tokens), mean: results.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / results.length) : null },
    tokens_opened_when_found: { median: median(found.map(result => result.tokens_opened)) },
    by_area: byArea,
    results,
  };
}

module.exports = { runRecallExam, keywords };
