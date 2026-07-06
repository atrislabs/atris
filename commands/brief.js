'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const autoland = require('../lib/autoland');
const { DENIED_TAGS } = require('../lib/auto-accept-certified');
const {
  appendBriefRecord,
  buildBriefReview,
  renderBriefReview,
  stampBriefOutcome,
} = require('../lib/brief-ledger');
const { renderHtml } = require('../lib/html-render');
const { nextMoves, recordDecision, seedInboxFromMove } = require('../lib/next-moves');
const { buildWeekReportData, renderWeekReport } = require('./report');

const DAY_MS = 24 * 60 * 60 * 1000;
const TASK_PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');
const NEEDS_HUMAN_TAGS = new Set(['needs-human', 'human-review', 'human', 'manual', 'protected', 'denied']);

function readProjection(root) {
  const projectionPath = path.join(root, TASK_PROJECTION_FILE);
  if (!fs.existsSync(projectionPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNow(now) {
  return timestampMs(now) || Date.now();
}

function inlineText(value, fallback = 'untitled') {
  const text = String(value || '')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function outputText(value, fallback = '') {
  return inlineText(value, fallback).toLowerCase();
}

function finishText(value, max = 150) {
  const clean = inlineText(value, '');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentence > max * 0.35) return cut.slice(0, sentence + 1).trim();
  const clause = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(': '));
  if (clause > max * 0.45) return cut.slice(0, clause).trim();
  const space = cut.lastIndexOf(' ');
  return cut.slice(0, space > max * 0.55 ? space : max).trim();
}

function operatorTitle(value, max = 140) {
  const raw = inlineText(value, '');
  const plumbing = /`|(?:^|\s)(?:node|npm|git|rg|grep)\s+|\S+\.(?:js|md|json|ts|py|sh)(?::\d+)?|\b[A-Z]{2,5}-\d+\b|\bpr\s*#?\s*\d+\b/i;
  const source = plumbing.test(raw) && raw.includes(':') ? raw.split(':')[0] : raw;
  const scrubbed = source
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(?:done|check|verify|proof):\s+.*$/i, ' ')
    .replace(/\b(?:node|npm|git|rg|grep)\s+[^\.;,]+/gi, ' ')
    .replace(/\S+\.(?:js|md|json|ts|py|sh)(?::\d+)?/gi, ' ')
    .replace(/\b[A-Z]{2,5}-\d+\b/g, ' ')
    .replace(/\bpr\s*#?\s*\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\([^a-z0-9]*\)/gi, ' ')
    .replace(/,\s*,+/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([:(])\s*([,.;:)]|$)/g, '')
    .replace(/\s+\)/g, ')')
    .trim();
  return finishText(scrubbed || value, max);
}

function taskId(task) {
  return inlineText(task.display_id || task.legacy_ref || task.task_ref || task.id, 'task');
}

function taskTime(task, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((obj, part) => (obj && obj[part] !== undefined ? obj[part] : undefined), task);
    const ms = timestampMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

function taskTags(task) {
  const values = [
    task.tag,
    task.metadata && task.metadata.tag,
    ...(Array.isArray(task.tags) ? task.tags : []),
    ...(Array.isArray(task.metadata && task.metadata.tags) ? task.metadata.tags : []),
  ];
  return values
    .filter(Boolean)
    .flatMap((tag) => String(tag).toLowerCase().split(/[^a-z0-9-]+/))
    .filter(Boolean);
}

function deniedTagForTask(task) {
  const tags = taskTags(task);
  for (const tag of tags) {
    for (const denied of DENIED_TAGS) {
      if (tag === denied || tag.replace(/s$/, '') === denied) return denied;
    }
  }
  return null;
}

function needsHumanTag(task) {
  return taskTags(task).find((tag) => NEEDS_HUMAN_TAGS.has(tag)) || null;
}

function extractPointer(text) {
  const value = inlineText(text, '');
  if (!value) return '';
  const url = value.match(/https?:\/\/[^\s<>"')]+/i);
  if (url) return url[0].replace(/[.,;]+$/, '');
  const pathMatch = value.match(/(?:^|\s)((?:\.atris|atris)\/[^\s,;:)]+)/i);
  if (pathMatch) return pathMatch[1].replace(/[.,;]+$/, '');
  const pr = value.match(/\bpr\s*#?\s*\d+\b/i);
  if (pr) return pr[0].replace(/\s+/g, ' ');
  return /\b(pass(?:ed)?|verified|green|merged|ok)\b/i.test(value) ? 'proof on file' : '';
}

function proofPointer(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  const landing = review.landing || {};
  const candidates = [
    metadata.receipt_path,
    metadata.receipt,
    metadata.receipt_file,
    metadata.landing_receipt,
    metadata.landing_url,
    metadata.landing_pr,
    landing.receipt,
    landing.proof,
    metadata.latest_agent_proof,
    metadata.proof,
    metadata.verify,
  ];
  for (const candidate of candidates) {
    const pointer = extractPointer(candidate);
    if (pointer) return pointer;
  }
  return 'task projection';
}

function formatAge(start, nowMs) {
  const ms = timestampMs(start);
  if (ms === null) return 'age unknown';
  const delta = Math.max(0, nowMs - ms);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function waitingReason(task) {
  const approval = String(task.review?.approval_status || task.metadata?.approval_status || '').toLowerCase();
  if (approval && approval !== 'pending') return `review lane is ${approval}`;
  const denied = deniedTagForTask(task);
  if (denied) return `protected ${denied} lane`;
  if (needsHumanTag(task)) return 'needs human lane';
  return 'review lane';
}

function isWaitingTask(task) {
  const status = String(task.status || '').toLowerCase();
  if (status === 'done' || status === 'failed' || status === 'cancelled') return false;
  return status === 'review' || Boolean(deniedTagForTask(task) || needsHumanTag(task));
}

function buildLanded(tasks, cutoffMs, nowMs) {
  return tasks
    .filter((task) => String(task.status || '').toLowerCase() === 'done')
    .map((task) => {
      const doneMs = taskTime(task, ['done_at', 'metadata.accepted_at', 'updated_at', 'created_at']);
      return { task, doneMs };
    })
    .filter(({ doneMs }) => doneMs !== null && doneMs >= cutoffMs)
    .sort((a, b) => b.doneMs - a.doneMs)
    .map(({ task, doneMs }) => ({
      id: taskId(task),
      title: inlineText(task.title, 'done task'),
      proof: proofPointer(task),
      age: formatAge(doneMs, nowMs),
    }));
}

function buildWaiting(tasks, nowMs) {
  return tasks
    .filter(isWaitingTask)
    .map((task) => {
      const startMs = taskTime(task, ['metadata.agent_certified_at', 'updated_at', 'created_at']);
      return {
        id: taskId(task),
        title: inlineText(task.title, 'review task'),
        why: waitingReason(task),
        age: formatAge(startMs, nowMs),
        _sort: startMs || 0,
      };
    })
    .sort((a, b) => a._sort - b._sort)
    .map(({ _sort, ...item }) => item);
}

function buildMoves(root) {
  return nextMoves(root, 3).map((move) => ({
    id: move.id,
    title: inlineText(move.title, 'next move'),
    why: inlineText(move.why || move.source || 'workspace signal', 'workspace signal'),
    source: move.source || null,
    owner: move.owner || move.member || null,
  }));
}

function buildWeekLine(root, nowMs) {
  const data = buildWeekReportData(root, { days: 7, now: nowMs });
  return renderWeekReport(data).split(/\r?\n/)[0] || 'week in review: 0 landed, 0 completions, 0 xp';
}

function buildBriefData(root = process.cwd(), { days = 1, now = Date.now() } = {}) {
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 1;
  const nowMs = normalizeNow(now);
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const tasks = readProjection(root);
  return {
    schema: 'atris.brief.v1',
    days: windowDays,
    landed: buildLanded(tasks, cutoffMs, nowMs),
    waiting: buildWaiting(tasks, nowMs),
    moves: buildMoves(root),
    week: buildWeekLine(root, nowMs),
  };
}

function plural(count, word, pluralWord = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

function renderBrief(data) {
  const landed = Array.isArray(data?.landed) ? data.landed : [];
  const waiting = Array.isArray(data?.waiting) ? data.waiting : [];
  const moves = Array.isArray(data?.moves) ? data.moves : [];
  const days = Number(data?.days) || 1;
  const window = days === 1 ? 'last 24h' : `last ${days} days`;
  const lines = [];

  lines.push(outputText(`atris brief: ${landed.length} landed, ${waiting.length} waiting, ${moves.length} next moves | size: ${window} | know: local atris state`));
  lines.push('');

  lines.push(outputText(`landed: ${landed.length ? 'finished work' : 'nothing finished yet'} | size: ${plural(landed.length, 'task')} | know: task projection`));
  for (const item of landed.slice(0, 5)) {
    lines.push(outputText(`- ${operatorTitle(item.title)} | size: 1 task | know: ${item.proof || 'proof on file'} (${item.age})`));
  }
  const held = Math.max(0, landed.length - 5);
  if (held > 0) lines.push(outputText(`- held: ${held} more landed | size: ${plural(held, 'task')} | know: task projection`));
  if (!landed.length) lines.push(outputText('- clear: no done tasks landed in this window | size: 0 tasks | know: task projection'));
  lines.push('');

  lines.push(outputText(`waiting on you: ${waiting.length ? 'review work needs a decision' : 'nothing waiting'} | size: ${plural(waiting.length, 'task')} | know: review lane`));
  if (waiting.length) {
    waiting.forEach((item, index) => {
      lines.push(outputText(`${index + 1}. ${operatorTitle(item.title)} | size: 1 task | know: ${item.why}, ${item.age} old`));
    });
  } else {
    lines.push(outputText('1. clear | size: 0 tasks | know: review lane'));
  }
  lines.push('');

  lines.push(outputText(`next moves: ${moves.length ? 'ranked work is ready' : 'nothing ranked'} | size: ${plural(moves.length, 'move')} | know: next-moves scan`));
  if (moves.length) {
    moves.forEach((move, index) => {
      const owner = move.owner ? `; best fit ${move.owner}` : '';
      lines.push(outputText(`${index + 1}. ${operatorTitle(move.title)} | size: 1 move | know: ${move.why}${owner}`));
    });
  } else {
    lines.push(outputText('1. clear | size: 0 moves | know: next-moves scan'));
  }
  lines.push('');

  lines.push(outputText(`${data?.week || 'week in review: 0 landed, 0 completions, 0 xp'} | size: 7 days | know: report data`));
  return lines.join('\n');
}

function panelRows(items, emptyTitle, emptySub, valueLabel) {
  if (!items.length) {
    return [{ title: emptyTitle, sub: emptySub, value: '0', valueSub: valueLabel, sev: 2 }];
  }
  return items.map((item, index) => ({
    title: `${index + 1}. ${item.title}`,
    sub: item.why ? `${item.why}, ${item.age || ''}` : item.proof || item.source || '',
    value: '1',
    valueSub: valueLabel,
    sev: index % 3,
  }));
}

function renderBriefHtml(data) {
  const landed = Array.isArray(data?.landed) ? data.landed : [];
  const waiting = Array.isArray(data?.waiting) ? data.waiting : [];
  const moves = Array.isArray(data?.moves) ? data.moves : [];
  const spec = {
    theme: 'atris',
    brand: { name: 'atris', accent: ' brief' },
    blocks: [
      {
        type: 'title',
        headline: 'atris brief',
        sub: `${landed.length} landed, ${waiting.length} waiting, ${moves.length} next moves`,
      },
      {
        type: 'bignumber',
        number: String(landed.length),
        label: 'landed in the current window',
        sub: 'known from task projection and proof pointers',
      },
      {
        type: 'panel',
        heading: 'waiting on you',
        sub: waiting.length ? 'approve or send back' : 'clear',
        panel: {
          header: { title: 'waiting on you', meta: 'review lane' },
          rows: panelRows(waiting, 'nothing waiting', 'review lane is clear', 'task'),
        },
      },
      {
        type: 'panel',
        heading: 'next moves',
        sub: moves.length ? 'ranked from current workspace state' : 'nothing ranked',
        panel: {
          header: { title: 'next moves', meta: 'top 3' },
          rows: panelRows(moves, 'nothing ranked', 'next-moves scan is clear', 'move'),
        },
      },
      {
        type: 'close',
        tagline: `${data?.week || 'week in review: 0 landed, 0 completions, 0 xp'} | size: 7 days | know: report data`,
      },
    ],
  };
  return renderHtml(spec, { title: 'atris brief' });
}

function readFlagValue(args, name, fallback = null) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1] || fallback;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length) || fallback;
  }
  return fallback;
}

function parseArgs(args = []) {
  return {
    days: readFlagValue(args, '--days', 1),
    out: readFlagValue(args, '--out', null),
    help: args.includes('--help') || args.includes('-h') || args[0] === 'help',
    html: args.includes('--html'),
    json: args.includes('--json'),
    send: args.includes('--send'),
    noInput: args.includes('--no-input'),
  };
}

function showHelp() {
  console.log('Usage: atris brief [--json] [--html [--out FILE]] [--send] [--no-input] [--days N]');
  console.log('       atris brief log --engine <engine> --prompt-file <file> [--json|--raw]');
  console.log('       atris brief outcome <brief_id> --result pass|fail|partial --note <text> [--json|--raw]');
  console.log('       atris brief review [--lessons] [--json] [--limit N]');
  console.log('Shows what landed, what waits on you, and what the loop should do next.');
}

function isBriefLedgerSubcommand(value) {
  return ['log', 'outcome', 'review'].includes(String(value || '').trim());
}

function flagPresent(args, name) {
  return args.includes(name);
}

function ledgerFlagValue(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === name) return args[index + 1] || fallback;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length) || fallback;
  }
  return fallback;
}

function positionalArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && args[index + 1] && !String(args[index + 1]).startsWith('--')) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function runBriefLog(args, root) {
  const json = flagPresent(args, '--json');
  const raw = flagPresent(args, '--raw');
  const engine = ledgerFlagValue(args, '--engine');
  const promptFile = ledgerFlagValue(args, '--prompt-file');
  if (!engine || !promptFile) {
    const message = 'usage: atris brief log --engine <engine> --prompt-file <file>';
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return 2;
  }
  let promptText;
  try {
    promptText = fs.readFileSync(path.resolve(root, promptFile), 'utf8');
  } catch (err) {
    const message = `brief log: could not read prompt file: ${err.message}`;
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return 2;
  }
  const worktree = ledgerFlagValue(args, '--worktree', root);
  const record = appendBriefRecord(root, {
    author: ledgerFlagValue(args, '--author', 'external'),
    engine,
    task_id: ledgerFlagValue(args, '--task-id'),
    mission_id: ledgerFlagValue(args, '--mission-id'),
    prompt_text: promptText,
    context: {
      worktree: path.resolve(root, worktree),
      base_ref: ledgerFlagValue(args, '--base-ref'),
    },
  });
  if (json) console.log(JSON.stringify({ ok: true, record }, null, 2));
  else if (raw) console.log(record.brief_id);
  else console.log(`brief logged for ${record.engine}; outcome can be attached after the flight`);
  return 0;
}

function runBriefOutcome(args, root) {
  const json = flagPresent(args, '--json');
  const raw = flagPresent(args, '--raw');
  const id = positionalArgs(args)[0] || '';
  const result = ledgerFlagValue(args, '--result');
  const note = ledgerFlagValue(args, '--note');
  if (!id || !result) {
    const message = 'usage: atris brief outcome <brief_id> --result pass|fail|partial --note <text>';
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    return 2;
  }
  let stamped;
  try {
    stamped = stampBriefOutcome(root, id, { result, note });
  } catch (err) {
    if (json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.error(`brief outcome: ${err.message}`);
    return 2;
  }
  if (!stamped.ok) {
    if (json) console.log(JSON.stringify(stamped, null, 2));
    else console.error('brief outcome: brief not found');
    return 1;
  }
  if (json) console.log(JSON.stringify({ ok: true, record: stamped.record }, null, 2));
  else if (raw) console.log(`${stamped.record.brief_id} ${stamped.record.outcome.result}`);
  else console.log(`brief outcome recorded: ${stamped.record.outcome.result}`);
  return 0;
}

function runBriefReview(args, root) {
  const json = flagPresent(args, '--json');
  const lessons = flagPresent(args, '--lessons');
  const limit = Number(ledgerFlagValue(args, '--limit', '20')) || 20;
  const review = buildBriefReview(root, { limit, lessons });
  if (json) console.log(JSON.stringify(review, null, 2));
  else console.log(renderBriefReview(review, { lessons }));
  return 0;
}

function runBriefLedgerCommand(args, root) {
  const subcommand = String(args[0] || '').trim();
  const rest = args.slice(1);
  if (subcommand === 'log') return runBriefLog(rest, root);
  if (subcommand === 'outcome') return runBriefOutcome(rest, root);
  if (subcommand === 'review') return runBriefReview(rest, root);
  return 2;
}

function shouldPromptBrief({ flags, stdin = process.stdin, stdout = process.stdout, data }) {
  if (flags?.noInput) return false;
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  return Boolean((data?.waiting || []).length || (data?.moves || []).length);
}

function runTaskAccept(root, id) {
  const bin = path.join(root, 'bin', 'atris.js');
  const argv = fs.existsSync(bin)
    ? [process.execPath, [bin, 'task', 'accept', id]]
    : ['atris', ['task', 'accept', id]];
  const result = spawnSync(argv[0], argv[1], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return {
    ok: result.status === 0,
    output: inlineText(result.stdout || result.stderr || ''),
  };
}

function approveMove(root, move, stamp = new Date().toISOString()) {
  recordDecision(root, move, 'approve', stamp);
  return seedInboxFromMove(root, move);
}

function parsePromptAnswer(answer) {
  const text = String(answer || '').trim().toLowerCase();
  if (!text) return { action: 'skip' };
  const accept = text.match(/^a\s+?(\d+)$/);
  if (accept) return { action: 'accept', index: Number(accept[1]) - 1 };
  const move = text.match(/^m\s+?(\d+)$/);
  if (move) return { action: 'move', index: Number(move[1]) - 1 };
  return { action: 'invalid' };
}

function handleBriefAnswer(root, data, answer, deps = {}) {
  const parsed = parsePromptAnswer(answer);
  const acceptTask = deps.acceptTask || ((id) => runTaskAccept(root, id));
  const moveApproval = deps.approveMove || ((move) => approveMove(root, move, deps.stamp));
  if (parsed.action === 'skip') return { ok: true, skipped: true, message: 'skipped' };
  if (parsed.action === 'accept') {
    const item = (data.waiting || [])[parsed.index];
    if (!item) return { ok: false, message: 'no waiting item for that number' };
    const result = acceptTask(item.id);
    return { ok: result.ok, message: result.output || (result.ok ? `accepted ${item.id}` : `could not accept ${item.id}`) };
  }
  if (parsed.action === 'move') {
    const move = (data.moves || [])[parsed.index];
    if (!move) return { ok: false, message: 'no move for that number' };
    const seeded = moveApproval(move);
    const note = seeded && seeded.alreadyPresent ? 'already in the inbox' : 'seeded into the loop';
    return { ok: true, message: `approved move ${parsed.index + 1}: ${note}` };
  }
  return { ok: false, message: 'no matching brief action' };
}

async function promptBrief(root, data, io = {}) {
  const input = io.stdin || process.stdin;
  const output = io.stdout || process.stdout;
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question('a N accept waiting, m N approve move, or enter to skip: ', (value) => {
      rl.close();
      resolve(value);
    });
  });
  const result = handleBriefAnswer(root, data, answer);
  if (result.message && !result.skipped) console.log(result.message);
  return result.ok ? 0 : 1;
}

function sendBrief(root, text) {
  const policy = autoland.readPolicy(root) || {};
  const to = String(policy.imessage_to || '').trim();
  if (!to) {
    console.error('no iMessage recipient configured. set one with: atris autoland on --to <your number>');
    return 1;
  }
  const sent = autoland.sendImessage(root, to, text);
  if (!sent.ok) {
    console.error(sent.output || `could not send brief to ${to}`);
    return 1;
  }
  console.log(`sent brief to ${to}`);
  return 0;
}

async function briefCommand(args = [], root = process.cwd(), io = {}) {
  const argv = Array.isArray(args) ? args : Array.from(arguments);
  if (isBriefLedgerSubcommand(argv[0])) return runBriefLedgerCommand(argv, root);
  const flags = parseArgs(argv);
  if (flags.help) {
    showHelp();
    return 0;
  }

  const data = buildBriefData(root, { days: flags.days });
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  if (flags.html) {
    const html = renderBriefHtml(data);
    if (flags.out) {
      const outPath = path.resolve(root, flags.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, 'utf8');
      console.log(`wrote ${outPath}`);
      return 0;
    }
    console.log(html);
    return 0;
  }

  const text = renderBrief(data);
  if (flags.send) return sendBrief(root, text);
  console.log(text);
  if (!shouldPromptBrief({ flags, stdin: io.stdin || process.stdin, stdout: io.stdout || process.stdout, data })) return 0;
  return promptBrief(root, data, io);
}

module.exports = {
  buildBriefData,
  briefCommand,
  handleBriefAnswer,
  parsePromptAnswer,
  renderBrief,
  renderBriefHtml,
  run: briefCommand,
  runBriefLedgerCommand,
  shouldPromptBrief,
};
