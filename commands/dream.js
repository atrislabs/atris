'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  RUNNER_PROFILE_DEFS,
} = require('../lib/runner-command');

const DREAMS_FILE = ['.atris', 'state', 'dreams.jsonl'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DREAM_TIMEOUT_MS = 60 * 1000;
const MAX_CONTEXT_CHARS = 7000;
const MAX_SECTION_CHARS = 2400;

function dreamsPath(root) {
  return path.join(root, ...DREAMS_FILE);
}

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJsonLines(file) {
  const text = safeRead(file);
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendDreamRows(root, rows) {
  if (!rows.length) return [];
  const file = dreamsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return rows;
}

function rowTimestamp(row) {
  const keys = ['ts', 'at', 'created_at', 'updated_at', 'completed_at', 'finished_at', 'generated_at'];
  for (const key of keys) {
    const parsed = Date.parse(String(row && row[key] || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function isRecentTime(ms, nowMs, windowMs = DAY_MS) {
  return Number.isFinite(ms) && ms >= nowMs - windowMs && ms <= nowMs + 5 * 60 * 1000;
}

function latestJournalFiles(root, limit = 2) {
  const logsDir = path.join(root, 'atris', 'logs');
  let years;
  try { years = fs.readdirSync(logsDir).filter((name) => /^\d{4}$/.test(name)).sort(); } catch { return []; }
  const files = [];
  for (const year of years) {
    const dir = path.join(logsDir, year);
    let names;
    try { names = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)); } catch { names = []; }
    for (const name of names) files.push(path.join(dir, name));
  }
  return files.sort().slice(-limit);
}

function clipTail(text, maxChars) {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  return `[cut]\n${clean.slice(clean.length - maxChars + 6)}`;
}

function addSection(parts, budget, label, text, maxChars = MAX_SECTION_CHARS) {
  const clean = String(text || '').trim();
  if (!clean || budget.left <= 0) return;
  const header = `\n[${label}]\n`;
  const room = Math.min(maxChars, Math.max(0, budget.left - header.length));
  if (room <= 0) return;
  const body = clipTail(clean, room);
  parts.push(`${header}${body}`);
  budget.left -= header.length + body.length;
}

function recentJsonlRows(root, relativePath, nowMs, limit = 20) {
  const rows = readJsonLines(path.join(root, relativePath));
  return rows
    .filter((row) => isRecentTime(rowTimestamp(row), nowMs))
    .sort((a, b) => rowTimestamp(a) - rowTimestamp(b))
    .slice(-limit);
}

function relativeToRoot(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function recentMissionReceipts(root, nowMs, limit = 6) {
  const runsDir = path.join(root, 'atris', 'runs');
  let names;
  try { names = fs.readdirSync(runsDir).filter((name) => /^mission-.*\.json$/.test(name)); } catch { return []; }
  const receipts = [];
  for (const name of names) {
    const file = path.join(runsDir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    let parsed = null;
    try { parsed = JSON.parse(safeRead(file)); } catch { parsed = null; }
    const stamped = Number.isFinite(rowTimestamp(parsed)) ? rowTimestamp(parsed) : stat.mtimeMs;
    if (!isRecentTime(stamped, nowMs)) continue;
    receipts.push({ stamped, file: relativeToRoot(root, file), body: parsed || safeRead(file) });
  }
  return receipts.sort((a, b) => a.stamped - b.stamped).slice(-limit);
}

function collectDreamMaterial(root = process.cwd(), options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowMs = nowDate.getTime();
  const parts = [];
  const budget = { left: options.maxContextChars || MAX_CONTEXT_CHARS };

  for (const file of latestJournalFiles(root, 2)) {
    addSection(parts, budget, `journal ${path.basename(file, '.md')}`, safeRead(file));
  }

  const wishes = recentJsonlRows(root, path.join('.atris', 'state', 'wishes.jsonl'), nowMs);
  if (wishes.length) addSection(parts, budget, 'wishes from the last day', wishes.map((row) => JSON.stringify(row)).join('\n'));

  const missions = recentJsonlRows(root, path.join('.atris', 'state', 'missions.jsonl'), nowMs);
  if (missions.length) addSection(parts, budget, 'missions from the last day', missions.map((row) => JSON.stringify(row)).join('\n'));

  const receipts = recentMissionReceipts(root, nowMs);
  if (receipts.length) {
    addSection(parts, budget, 'mission receipts from the last day', receipts.map((receipt) => {
      const body = typeof receipt.body === 'string' ? receipt.body : JSON.stringify(receipt.body);
      return `${receipt.file}\n${body}`;
    }).join('\n\n'));
  }

  return {
    text: parts.join('\n').trim(),
    sectionCount: parts.length,
    now: nowDate.toISOString(),
  };
}

function buildDreamPrompt(material) {
  return [
    'You are atris dream.',
    'Read the day notes below.',
    'Return only JSON.',
    'Make 2 or 3 cards.',
    'Use this exact shape:',
    '[{"title":"three to five plain words","why":"one short line","move":"one concrete next action"}]',
    'Use plain words a child gets.',
    'Do not use em dashes.',
    '',
    material,
  ].join('\n');
}

function replaceLongDashes(value) {
  return String(value || '').replace(/[\u2012-\u2015]/g, '-');
}

function oneLine(value, max = 180) {
  return replaceLongDashes(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function findJsonArrayText(output) {
  const text = String(output || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const target = fenced ? fenced[1] : text;
  const start = target.indexOf('[');
  if (start === -1) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < target.length; index += 1) {
    const ch = target[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return target.slice(start, index + 1);
    }
  }
  return '';
}

function parseDreamCards(output) {
  const jsonText = findJsonArrayText(output);
  if (!jsonText) throw new Error('missing json');
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch (error) { throw new Error(`bad json: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 3) {
    throw new Error('expected 2 or 3 cards');
  }
  return parsed.map((card) => {
    const title = oneLine(card && card.title, 80);
    const why = oneLine(card && card.why);
    const move = oneLine(card && card.move);
    const wordCount = title ? title.split(/\s+/).length : 0;
    if (!title || !why || !move || wordCount < 3 || wordCount > 5) {
      throw new Error('bad card shape');
    }
    return { title, why, move };
  });
}

function dreamModels() {
  const models = [
    RUNNER_PROFILE_DEFS.haiku && RUNNER_PROFILE_DEFS.haiku.model,
    DEFAULT_CLAUDE_RUNNER_MODEL,
  ].filter(Boolean);
  return Array.from(new Set(models));
}

function defaultDreamRunner({ prompt, model, cwd, timeoutMs = DREAM_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const bin = (RUNNER_PROFILE_DEFS.haiku && RUNNER_PROFILE_DEFS.haiku.bin) || 'claude';
    const proc = spawn(bin, ['-p', prompt, '--model', model], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, exitCode: code, timedOut });
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr, timedOut });
    });
  });
}

function attemptFailureReason(result) {
  if (result && result.garbled) return 'could not read dream cards';
  if (result && result.timedOut) return 'model timed out';
  if (result && result.error) return 'model could not start';
  if (result && result.exitCode) return 'model stopped early';
  return 'model did not answer';
}

function writeDreamCards(root, cards, stamp) {
  const ts = stamp || new Date().toISOString();
  return appendDreamRows(root, cards.map((card) => ({
    ts,
    title: card.title,
    why: card.why,
    move: card.move,
    source: 'dream',
  })));
}

function writeDreamNoop(root, reason, stamp) {
  return appendDreamRows(root, [{
    ts: stamp || new Date().toISOString(),
    kind: 'dream_noop',
    reason,
  }])[0];
}

async function runDream(root = process.cwd(), options = {}) {
  const stamp = options.stamp || new Date().toISOString();
  try {
    const material = collectDreamMaterial(root, options);
    if (!material.text) return { ok: false, cards: [], reason: 'nothing to read' };

    const prompt = buildDreamPrompt(material.text);
    const runner = options.runner || defaultDreamRunner;
    let lastFailure = null;
    for (const model of dreamModels()) {
      const result = await runner({
        prompt,
        model,
        cwd: root,
        timeoutMs: options.timeoutMs || DREAM_TIMEOUT_MS,
      });
      if (!result || result.ok === false || result.timedOut) {
        lastFailure = result || { ok: false };
        continue;
      }
      const output = result.stdout != null ? result.stdout : (result.result || result.output || '');
      let cards;
      try {
        cards = parseDreamCards(output);
      } catch {
        lastFailure = { ok: false, garbled: true };
        continue;
      }
      return { ok: true, cards: writeDreamCards(root, cards, stamp), reason: null };
    }

    const reason = attemptFailureReason(lastFailure);
    writeDreamNoop(root, reason, stamp);
    return { ok: false, cards: [], reason, noop: true };
  } catch {
    const reason = 'could not finish dream';
    try { writeDreamNoop(root, reason, stamp); } catch {}
    return { ok: false, cards: [], reason, noop: true };
  }
}

function showHelp(log = console.log) {
  log('');
  log('Usage: atris dream');
  log('');
  log('Reads today and writes 2 or 3 cards for atris next.');
  log('');
  log('Run me nightly: atris dream');
  log('launchd line: run atris dream at 4:00 every morning');
  log('');
  return 0;
}

async function dreamCommand(args = [], root = process.cwd(), options = {}) {
  const log = options.log || console.log;
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') return showHelp(log);
  const result = await runDream(root, options);
  if (result.cards && result.cards.length) {
    const noun = result.cards.length === 1 ? 'card' : 'cards';
    log(`Dreamed ${result.cards.length} ${noun}.`);
  } else {
    log(`No dreams tonight: ${result.reason || 'nothing useful'}`);
  }
  log('Run me nightly: atris dream');
  return 0;
}

module.exports = {
  DREAM_TIMEOUT_MS,
  dreamsPath,
  collectDreamMaterial,
  buildDreamPrompt,
  parseDreamCards,
  dreamModels,
  defaultDreamRunner,
  runDream,
  dreamCommand,
};
