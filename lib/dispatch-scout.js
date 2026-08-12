'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildReadOnlyEngineInvocation,
  runAskProcess,
  runEngineAskJobs,
} = require('./engine-ask');

const SCOUT_PACK_SCHEMA = 'atris.dispatch_scout_pack.v1';
const SCOUT_ENGINE = 'haiku';
const SCOUT_TIMEOUT_MS = 45000;
const SCOUT_MAX_HITS = 8;
const SCOUT_MAX_MAP_GOTCHAS = 4;
const SCOUT_MAX_EXCERPT_LINES = 12;
const SCOUT_MAX_PACK_BYTES = 4096;
const SCOUT_MAX_ALLOWED_FILES = 48;
const SCOUT_BLOCK_HEADING = '## verified starting points for this commit';

const TITLE_STOP_WORDS = new Set([
  'after', 'against', 'before', 'brief', 'build', 'builder', 'builders', 'building',
  'check', 'done', 'exactly', 'first', 'from', 'have', 'instead', 'into', 'minutes',
  'only', 'should', 'stop', 'task', 'that', 'their', 'then', 'this', 'through',
  'verified', 'with', 'without', 'work', 'working',
]);

function git(root, args, options = {}) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5000,
    ...options,
  });
}

function checkoutCommit(root) {
  const result = git(root, ['rev-parse', 'HEAD']);
  if (result.status !== 0) return '';
  const commit = String(result.stdout || '').trim();
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : '';
}

function trackedFiles(root) {
  const result = git(root, ['ls-files', '-z']);
  if (result.status !== 0) return [];
  return String(result.stdout || '').split('\0').map((entry) => entry.trim()).filter(Boolean);
}

function taskRef(task) {
  return String(task && (task.display_id || task.task_id || task.id) || '').trim();
}

function titleKeywords(title) {
  const seen = new Set();
  const out = [];
  for (const token of String(title || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || []) {
    if (token.length < 4 || TITLE_STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length === 12) break;
  }
  return out;
}

function mapPathRefs(line, tracked) {
  const refs = [];
  const tokens = String(line || '').match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_.-]+/g) || [];
  for (const token of tokens) {
    const normalized = token.replace(/^\.\//, '');
    if (tracked.has(normalized) && !refs.includes(normalized)) refs.push(normalized);
  }
  return refs;
}

function keywordFileMatches(root, keywords) {
  if (!keywords.length) return [];
  const args = ['grep', '-I', '-l', '-F', '-i'];
  for (const keyword of keywords) args.push('-e', keyword);
  args.push('--');
  const result = git(root, args);
  if (result.status !== 0 && result.status !== 1) return [];
  return String(result.stdout || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function seedScoutContext({ task, worktreePath }) {
  const trackedList = trackedFiles(worktreePath);
  const tracked = new Set(trackedList);
  const keywords = titleKeywords(task && task.title);
  const mapPath = 'atris/MAP.md';
  let mapText = '';
  try { mapText = fs.readFileSync(path.join(worktreePath, mapPath), 'utf8'); } catch {}

  const scores = new Map();
  const gotchaCandidates = [];
  const addScore = (file, score) => {
    if (!tracked.has(file)) return;
    scores.set(file, Math.max(scores.get(file) || 0, score));
  };
  if (tracked.has(mapPath)) addScore(mapPath, 1);

  const mapLines = mapText.split(/\r?\n/);
  for (let index = 0; index < mapLines.length; index += 1) {
    const line = mapLines[index];
    const lower = line.toLowerCase();
    const matches = keywords.filter((keyword) => lower.includes(keyword));
    const refs = mapPathRefs(line, tracked);
    for (const ref of refs) {
      const pathMatches = keywords.filter((keyword) => ref.toLowerCase().includes(keyword)).length;
      if (matches.length || pathMatches) addScore(ref, 80 + (matches.length * 5) + (pathMatches * 8));
    }
    if (matches.length && line.trim() && line.trim().length <= 300 && gotchaCandidates.length < 16) {
      gotchaCandidates.push({ line: index + 1, text: line.trim() });
    }
  }

  for (const file of trackedList) {
    const pathMatches = keywords.filter((keyword) => file.toLowerCase().includes(keyword)).length;
    if (pathMatches) addScore(file, 60 + (pathMatches * 8));
  }
  for (const file of keywordFileMatches(worktreePath, keywords)) addScore(file, 50);

  const allowedFiles = [...scores]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, SCOUT_MAX_ALLOWED_FILES)
    .map(([file]) => file);
  return { allowedFiles, gotchaCandidates, keywords };
}

function scoutPrompt({ task, commit, seed }) {
  return [
    `Rank verified starting points for task ${taskRef(task)} at checkout commit ${commit}.`,
    `Task title: ${String(task && task.title || '').trim().slice(0, 800)}`,
    'Read atris/MAP.md first. Inspect only the allowed tracked files below. Do not cite or mention any other file.',
    'Return one JSON object and no prose. Use this exact shape:',
    JSON.stringify({
      schema: SCOUT_PACK_SCHEMA,
      task_id: taskRef(task),
      checkout_commit: commit,
      hits: [{ path: 'lib/example.js', line: 12, excerpt: 'verbatim source, at most 12 lines', why: 'One sentence.' }],
      map_gotchas: [{ line: 1, text: 'verbatim MAP line from the candidate list' }],
      not_checked: ['short gap'],
    }),
    `Return at most ${SCOUT_MAX_HITS} hits and ${SCOUT_MAX_MAP_GOTCHAS} MAP gotchas. Every excerpt must be verbatim source and at most ${SCOUT_MAX_EXCERPT_LINES} lines.`,
    'Allowed tracked files:',
    ...seed.allowedFiles.map((file) => `- ${file}`),
    'MAP gotcha candidates, choose only exact objects from this list:',
    JSON.stringify(seed.gotchaCandidates),
  ].join('\n');
}

function buildScoutInvocation(job) {
  const invocation = buildReadOnlyEngineInvocation(job.engine, job.prompt, job.model);
  const args = [...invocation.args];
  const toolsIndex = args.indexOf('--tools');
  if (toolsIndex !== -1) args[toolsIndex + 1] = 'Read,Glob,Grep';
  return { ...invocation, args };
}

async function defaultScoutAsk({ job, root, timeoutMs }) {
  const answers = await runEngineAskJobs([job], {
    root,
    concurrency: 1,
    timeoutMs,
    executeAskJob: async (askJob) => {
      const invocation = buildScoutInvocation(askJob);
      return runAskProcess(invocation, {
        cwd: invocation.cwd || root,
        timeoutMs,
      });
    },
  });
  return answers[0] || null;
}

function firstJsonObject(text) {
  const source = String(text || '').trim();
  try { return JSON.parse(source); } catch {}
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start !== -1) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { start = -1; }
    }
  }
  return null;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function excerptLocations(source, excerpt) {
  const locations = [];
  let offset = source.indexOf(excerpt);
  while (offset !== -1) {
    locations.push({ offset, line: lineNumberAt(source, offset) });
    offset = source.indexOf(excerpt, offset + 1);
  }
  return locations;
}

function excerptSymbol(excerpt) {
  const source = String(excerpt || '');
  const declared = source.match(/\b(?:async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (declared) return declared[1];
  const called = source.match(/\b([A-Za-z_$][\w$]*)\s*\(/);
  return called ? called[1] : '';
}

function normalizeWhy(value) {
  const why = String(value || '').trim();
  if (!why || why.length > 240 || /[\r\n]/.test(why)) return '';
  return why;
}

function verifyHit(hit, { worktreePath, tracked, allowed }) {
  if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return null;
  const citedPath = String(hit.path || '').trim().replace(/^\.\//, '');
  if (!citedPath || path.isAbsolute(citedPath) || citedPath.split('/').includes('..')) return null;
  if (!tracked.has(citedPath) || !allowed.has(citedPath)) return null;
  const absolutePath = path.join(worktreePath, citedPath);
  let stat;
  let source;
  try {
    stat = fs.lstatSync(absolutePath);
    source = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
  if (!stat.isFile() || source.includes('\0')) return null;
  const excerpt = String(hit.excerpt || '');
  const excerptLines = excerpt.split('\n');
  const citedLine = Number(hit.line);
  const why = normalizeWhy(hit.why);
  if (!excerpt || excerptLines.length > SCOUT_MAX_EXCERPT_LINES || !Number.isInteger(citedLine) || citedLine < 1 || !why) return null;
  const locations = excerptLocations(source, excerpt);
  if (!locations.length) return null;
  locations.sort((left, right) => Math.abs(left.line - citedLine) - Math.abs(right.line - citedLine));
  const nearest = locations[0];
  if (Math.abs(nearest.line - citedLine) > SCOUT_MAX_EXCERPT_LINES) {
    const symbol = excerptSymbol(excerpt);
    if (!symbol || !source.slice(nearest.offset, nearest.offset + excerpt.length).includes(symbol)) return null;
  }
  return { path: citedPath, line: nearest.line, excerpt, why };
}

function verifyMapGotcha(gotcha, mapText) {
  if (!gotcha || typeof gotcha !== 'object' || Array.isArray(gotcha)) return null;
  const text = String(gotcha.text || '').trim();
  const citedLine = Number(gotcha.line);
  if (!text || text.length > 300 || !Number.isInteger(citedLine) || citedLine < 1) return null;
  const lines = mapText.split(/\r?\n/);
  const actualLine = lines.findIndex((line) => line.trim() === text) + 1;
  if (!actualLine) return null;
  return { line: actualLine, text };
}

function verifyScoutPack(rawPack, { task, worktreePath, allowedFiles, expectedCommit = '' }) {
  if (!rawPack || typeof rawPack !== 'object' || Array.isArray(rawPack)) return null;
  const currentCommit = checkoutCommit(worktreePath);
  const commit = String(rawPack.checkout_commit || '').trim();
  if (!currentCommit || !commit || commit !== currentCommit || (expectedCommit && commit !== expectedCommit)) return null;
  if (rawPack.schema !== SCOUT_PACK_SCHEMA || String(rawPack.task_id || '') !== taskRef(task)) return null;

  const tracked = new Set(trackedFiles(worktreePath));
  const allowed = new Set((allowedFiles || []).filter((file) => tracked.has(file)));
  const verifiedHits = (Array.isArray(rawPack.hits) ? rawPack.hits : [])
    .slice(0, SCOUT_MAX_HITS)
    .map((hit) => verifyHit(hit, { worktreePath, tracked, allowed }))
    .filter(Boolean);
  const seenHits = new Set();
  const hits = verifiedHits.filter((hit) => {
    const key = `${hit.path}\0${hit.line}\0${hit.excerpt}`;
    if (seenHits.has(key)) return false;
    seenHits.add(key);
    return true;
  });
  if (hits.length < 2) return null;

  let mapText = '';
  try { mapText = fs.readFileSync(path.join(worktreePath, 'atris', 'MAP.md'), 'utf8'); } catch {}
  const mapGotchas = (Array.isArray(rawPack.map_gotchas) ? rawPack.map_gotchas : [])
    .slice(0, SCOUT_MAX_MAP_GOTCHAS)
    .map((gotcha) => verifyMapGotcha(gotcha, mapText))
    .filter(Boolean);
  const notChecked = (Array.isArray(rawPack.not_checked) ? rawPack.not_checked : [])
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry && entry.length <= 160 && !/[\r\n]/.test(entry))
    .slice(0, 4);
  const pack = {
    schema: SCOUT_PACK_SCHEMA,
    task_id: taskRef(task),
    checkout_commit: commit,
    hits,
    map_gotchas: mapGotchas,
    not_checked: notChecked,
  };
  return Buffer.byteLength(JSON.stringify(pack)) <= SCOUT_MAX_PACK_BYTES ? pack : null;
}

async function buildVerifiedScoutPack({ task, worktreePath, ask = defaultScoutAsk }) {
  try {
    const commit = checkoutCommit(worktreePath);
    if (!commit) return null;
    const seed = seedScoutContext({ task, worktreePath });
    if (seed.allowedFiles.length < 2) return null;
    const job = {
      engine: SCOUT_ENGINE,
      model: '',
      label: 'dispatch-scout',
      prompt: scoutPrompt({ task, commit, seed }),
    };
    const answer = await ask({ job, root: worktreePath, timeoutMs: SCOUT_TIMEOUT_MS });
    if (!answer || answer.ok !== true || answer.timed_out || answer.cancelled) return null;
    const rawPack = firstJsonObject(answer.stdout);
    return verifyScoutPack(rawPack, {
      task,
      worktreePath,
      allowedFiles: seed.allowedFiles,
      expectedCommit: commit,
    });
  } catch {
    return null;
  }
}

function renderVerifiedScoutBlock(pack, { worktreePath }) {
  if (!pack || checkoutCommit(worktreePath) !== pack.checkout_commit) return '';
  const lines = [
    SCOUT_BLOCK_HEADING,
    `These starting points were verified against commit ${pack.checkout_commit}. Open atris/MAP.md first. If a named symbol is missing, ignore this block and read MAP.`,
  ];
  for (const hit of pack.hits) {
    lines.push(`- ${hit.path}:${hit.line} ${hit.why}`);
    lines.push(...hit.excerpt.split('\n').map((line) => `    ${line}`));
  }
  if (pack.map_gotchas.length) {
    lines.push('MAP gotchas:');
    lines.push(...pack.map_gotchas.map((gotcha) => `- MAP line ${gotcha.line}: ${gotcha.text}`));
  }
  if (pack.not_checked.length) lines.push(`Not checked: ${pack.not_checked.join('; ')}`);
  return lines.join('\n');
}

function appendVerifiedScoutPack(brief, pack, { worktreePath }) {
  const source = String(brief || '');
  if (!pack || source.includes(SCOUT_BLOCK_HEADING)) return source;
  const block = renderVerifiedScoutBlock(pack, { worktreePath });
  return block ? `${source}\n\n${block}` : source;
}

module.exports = {
  SCOUT_PACK_SCHEMA,
  SCOUT_TIMEOUT_MS,
  SCOUT_BLOCK_HEADING,
  checkoutCommit,
  seedScoutContext,
  buildScoutInvocation,
  verifyScoutPack,
  buildVerifiedScoutPack,
  appendVerifiedScoutPack,
};
