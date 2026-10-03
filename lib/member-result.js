'use strict';

// atris member result <member> [--since <iso-time>] [--json]
//
// Reads back the newest real result of a member run as one object: the run
// line from the roster's run record, the newest receipt in the member's
// logs/, the files it made under work/, and one result number when the
// receipt states one plainly. Read only.
//
// A member run usually works in its own git worktree, so its receipt and
// files land there, not in the main checkout. The run's mission id leads to
// that worktree; both places are read, newest file wins.

const fs = require('fs');
const path = require('path');

const { readRosterRuns } = require('./roster-runs');

const MEMBER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const RUN_DAYS = 90;
const RECEIPT_LINES = 40;
const ARTIFACT_LINES = 20;
const MAX_ARTIFACTS = 50;
const MAX_WALK_FILES = 2000;
const HEAD_READ_BYTES = 64 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);

function usage() {
  return [
    'usage:',
    '  atris member result <member> [--since <iso-time>] [--json]',
    '',
    'newest result of a member run: run record, receipt, artifacts, and one result number.',
    '',
    'options:',
    '  --since <iso-time>  only files changed after this time (default: start of the newest run)',
    '  --json              print the result as json',
  ].join('\n');
}

function parseResultArgs(args = []) {
  let member = '';
  let since = '';
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--since') {
      if (index + 1 >= args.length) throw new Error('--since needs an iso time');
      since = String(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--since=')) { since = arg.slice('--since='.length); continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    if (member) throw new Error(usage());
    member = arg.trim();
  }
  if (help) return { help: true, json };
  if (!member) throw new Error(usage());
  if (!MEMBER_NAME_RE.test(member)) throw new Error(`"${member}" is not a member name`);
  if (since && !Number.isFinite(Date.parse(since))) throw new Error(`--since "${since}" is not a time; use an iso time like 2026-10-02T18:00:00Z`);
  return { help: false, member, since, json };
}

// The member's newest run line. `id` is the mission id the run worked on.
function newestMemberRun(root, member, { now } = {}) {
  const runs = readRosterRuns(root, { now, days: RUN_DAYS })
    .filter((run) => run.member === member && Number.isFinite(Date.parse(run.at)));
  if (!runs.length) return null;
  runs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const run = runs[runs.length - 1];
  const startedMs = Date.parse(run.at);
  const seconds = Number.isFinite(Number(run.seconds)) ? Number(run.seconds) : null;
  return {
    id: run.task || null,
    started: new Date(startedMs).toISOString(),
    ended: seconds === null ? null : new Date(startedMs + seconds * 1000).toISOString(),
    status: run.outcome,
    engine: run.engine,
    model: run.model || null,
    seconds,
    ...(run.detail ? { detail: run.detail } : {}),
  };
}

// Where the run's mission lives when that is a sibling worktree, else null.
function runWorktreeRoot(root, missionId, deps = {}) {
  if (!missionId) return null;
  try {
    const listRolled = deps.listWorktreeRollupMissions
      || require('../commands/mission').listWorktreeRollupMissions;
    const found = listRolled(root).find((mission) => mission && mission.id === missionId);
    if (!found || !found.worktree_root || !fs.existsSync(found.worktree_root)) return null;
    return path.resolve(found.worktree_root);
  } catch {
    return null;
  }
}

// Files under dir changed after sinceMs, newest first. Bounded walk.
function changedFiles(dir, sinceMs) {
  const out = [];
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < MAX_WALK_FILES) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      seen += 1;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (sinceMs !== null && stat.mtimeMs <= sinceMs) continue;
      out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// First n lines when the file reads as text, else null.
function headLines(file, count) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_READ_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEAD_READ_BYTES, 0);
    const chunk = buffer.subarray(0, bytes);
    if (chunk.includes(0)) return null;
    return chunk.toString('utf8').split(/\r?\n/).slice(0, count).join('\n').replace(/\s+$/, '');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const COUNT_WORDS = [
  'tests?', 'passed', 'checks?', 'files?', 'items?', 'rows?', 'leads?', 'replies', 'emails?', 'messages?',
  'users?', 'customers?', 'signups?', 'clips?', 'shots?', 'scenes?', 'bugs?', 'errors?', 'issues?', 'tasks?',
  'wins?', 'deals?', 'meetings?', 'calls?', 'views?', 'sales', 'orders?', 'bets?', 'pages?', 'questions?', 'answers?',
].join('|');

// One result number when the receipt states one plainly: a single distinct
// percent, else a single dollar amount, else a single count of things. Two
// different values of the same kind means none is the obvious one.
function obviousNumber(text) {
  const body = String(text || '');
  const kinds = [
    {
      kind: 'percent',
      re: /(?<![\w.$])(\d+(?:\.\d+)?)\s?(%|percent\b)/gi,
      value: (match) => Number(match[1]),
    },
    {
      kind: 'dollars',
      re: /\$\s?(\d[\d,]*(?:\.\d+)?)(\s?[kKmM]\b)?/g,
      value: (match) => {
        const base = Number(match[1].replace(/,/g, ''));
        const unit = String(match[2] || '').trim().toLowerCase();
        return unit === 'k' ? base * 1000 : unit === 'm' ? base * 1000000 : base;
      },
    },
    {
      kind: 'count',
      re: new RegExp(`(?<![\\w.:/#-])(\\d[\\d,]*)\\s+(?:of\\s+\\d[\\d,]*\\s+)?(?:${COUNT_WORDS})\\b`, 'gi'),
      value: (match) => Number(match[1].replace(/,/g, '')),
    },
  ];
  for (const { kind, re, value } of kinds) {
    const found = new Map();
    for (const match of body.matchAll(re)) {
      const number = value(match);
      if (!Number.isFinite(number)) continue;
      if (!found.has(number)) found.set(number, match[0].trim());
    }
    if (found.size === 1) {
      const [[number, textValue]] = [...found.entries()];
      return { value: number, text: textValue, kind };
    }
    if (found.size > 1) return null;
  }
  return null;
}

function memberResult(root, member, { since = '', now, deps = {} } = {}) {
  const run = newestMemberRun(root, member, { now });
  const worktree = run ? runWorktreeRoot(root, run.id, deps) : null;
  const roots = [...new Set([worktree, path.resolve(root)].filter(Boolean))];
  const memberHere = roots.some((dir) => fs.existsSync(path.join(dir, 'atris', 'team', member)));
  if (!run && !memberHere) return { ok: false, error: `no member named ${member} here, and no run of one on record` };

  const sinceIso = since ? new Date(Date.parse(since)).toISOString() : (run ? run.started : null);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;

  const logs = roots.flatMap((dir) => changedFiles(path.join(dir, 'atris', 'team', member, 'logs'), sinceMs));
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newestLog = logs[0] || null;
  const receipt = newestLog ? {
    path: newestLog.path,
    modified: new Date(newestLog.mtimeMs).toISOString(),
    head: headLines(newestLog.path, RECEIPT_LINES),
  } : null;

  // The member's work/ in every root; a run's own worktree also counts its
  // top-level work/, since nothing else writes into that checkout.
  const workDirs = roots.map((dir) => path.join(dir, 'atris', 'team', member, 'work'));
  if (worktree) workDirs.push(path.join(worktree, 'work'));
  const files = workDirs.flatMap((dir) => changedFiles(dir, sinceMs));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const artifacts = files.slice(0, MAX_ARTIFACTS).map((file) => ({
    path: file.path,
    size: file.size,
    modified: new Date(file.mtimeMs).toISOString(),
    head: headLines(file.path, ARTIFACT_LINES),
  }));

  const number = receipt ? obviousNumber(receipt.head) : null;
  return {
    ok: true,
    value: {
      member,
      since: sinceIso,
      run,
      worktree,
      receipt,
      artifacts,
      artifacts_more: Math.max(0, files.length - MAX_ARTIFACTS),
      number: number ? number.value : null,
      number_text: number ? number.text : null,
    },
  };
}

function printHuman(value) {
  const { run } = value;
  console.log('');
  if (run) {
    const model = run.model ? ` (${run.model})` : '';
    const took = run.seconds === null ? '' : `, ${Math.round(run.seconds)}s`;
    console.log(`${value.member}: last run ${run.status}, started ${run.started}${took}, on ${run.engine}${model}`);
    if (run.id) console.log(`  run: ${run.id}`);
  } else {
    console.log(`${value.member}: no run on record in the last ${RUN_DAYS} days`);
  }
  if (value.worktree) console.log(`  worked in: ${value.worktree}`);
  console.log(`  since: ${value.since || 'any time'}`);
  if (value.receipt) {
    console.log(`\nreceipt: ${value.receipt.path}`);
    const lines = String(value.receipt.head || '').split('\n').slice(0, 12);
    for (const line of lines) console.log(`  ${line}`);
  } else {
    console.log('\nreceipt: none written since then');
  }
  console.log(`\nartifacts: ${value.artifacts.length}${value.artifacts_more ? ` (+${value.artifacts_more} more)` : ''}`);
  for (const file of value.artifacts) console.log(`  ${file.path} (${file.size} bytes)`);
  console.log(`\nnumber: ${value.number_text || 'none stated plainly'}\n`);
}

function memberResultCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  let parsed;
  try {
    parsed = parseResultArgs(args);
  } catch (error) {
    console.error(`member result: ${error.message}`);
    return 2;
  }
  if (parsed.help) {
    console.log(usage());
    return 0;
  }
  const result = memberResult(root, parsed.member, { since: parsed.since, now: deps.now, deps });
  if (!result.ok) {
    if (parsed.json) console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    else console.error(`member result: ${result.error}`);
    return 1;
  }
  if (parsed.json) console.log(JSON.stringify(result.value, null, 2));
  else printHuman(result.value);
  return 0;
}

module.exports = {
  memberResult,
  memberResultCommand,
  obviousNumber,
  parseResultArgs,
};
