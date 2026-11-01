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
const { SHOWN, buildOwnerBrief, cutAtSpace, ownerBlocks, printableLink, redacted, renderOwnerText } = require('../lib/owner-brief');
const { buildWeekReportData, renderWeekReport } = require('./report');

const DAY_MS = 24 * 60 * 60 * 1000;
// Titles on the owner's screen stay on one line.
const OWNER_TITLE_MAX = 90;
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

// A link or a path is one word. Any word with a / in it counts, and the brackets, quotes, and
// sentence marks around it are not part of it. The shortener keeps such a word whole or drops
// it whole and never leaves a piece of one: a title must not end in `feature/` or in
// `Review https`. `start` and `end` are the word itself, `from` and `to` the word with what
// is around it.
const WRAP_OPEN = '([{<"\'`';
const WRAP_CLOSE = ')]}>"\'`.,;:!?';

function slashWords(text) {
  const found = [];
  const word = /\S+/g;
  for (let match = word.exec(text); match; match = word.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    let start = from;
    let end = to;
    while (start < end && WRAP_OPEN.includes(text[start])) start += 1;
    while (end > start && WRAP_CLOSE.includes(text[end - 1])) end -= 1;
    if (text.slice(start, end).includes('/')) found.push({ start, end, from, to });
  }
  return found;
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
  let at = space > max * 0.55 ? space : max;
  // The cut fell inside a link or a path, so the line stops before that word and it goes whole.
  // When it is the first word there is nothing before it: it stays if it fits in twice the
  // room, and goes if it does not.
  const across = slashWords(clean).find((word) => word.from < at && at < word.to);
  if (across) at = across.from > 0 ? across.from : (across.to <= max * 2 ? across.to : 0);
  return clean.slice(0, at).trim();
}

// A file name is plumbing and goes whole: a known extension that ends where the word does
// (`.json` is not `.js` with `on` left over), then the line and column numbers if there are any.
// Any other link or path is kept whole. Both are set aside while the plumbing is taken out, so
// nothing in the shortener ever works on a piece of one.
const FILE_EXT = '\\.(?:json5?|jsonl|jsx?|mdx?|py[cw]?|sh|tsx?)(?![a-z0-9])(?::\\d+)*';
const FILE_NAME = new RegExp(`${FILE_EXT}$`, 'i');
const FILE_NAMES = new RegExp(`\\S+${FILE_EXT}`, 'gi');
const FILE_MARK = '\u0003';
const MARKED_FILES = new RegExp(`${FILE_MARK}(?::\\d+)*`, 'g');

function setAside(text) {
  const words = [];
  let masked = '';
  let last = 0;
  for (const { start, end } of slashWords(text)) {
    const word = text.slice(start, end);
    const file = word.includes('://') ? null : FILE_NAME.exec(word);
    masked += text.slice(last, start);
    if (file) {
      // The line numbers stay out of the mark: a colon after plumbing is where the detail starts.
      masked += FILE_MARK;
      last = end - /(?::\d+)*$/.exec(file[0])[0].length;
    } else {
      masked += `\u0001${words.length}\u0002`;
      words.push(word);
      last = end;
    }
  }
  return { masked: masked + text.slice(last), words };
}

function operatorTitle(value, max = 140) {
  const clean = inlineText(value, '').replace(/[\u0001-\u0003]/g, ' ');
  const { masked: raw, words } = setAside(clean);
  const plumbing = /`|(?:^|\s)(?:node|npm|git|rg|grep)\s+|\S+\.(?:js|md|json|ts|py|sh)(?::\d+)?|\b[A-Z]{2,5}-\d+\b|\bpr\s*#?\s*\d+\b/i;
  // Plumbing anywhere makes what follows a colon detail, in a link or a path too; but a colon
  // inside a link or a path is not that colon.
  const source = plumbing.test(clean) && raw.includes(':') ? raw.split(':')[0] : raw;
  const scrubbed = source
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(?:done|check|verify|proof):\s+.*$/i, ' ')
    .replace(/\b(?:node|npm|git|rg|grep)\s+(?:[^.;,]|\.(?=\S))+/gi, ' ')
    .replace(MARKED_FILES, ' ')
    .replace(FILE_NAMES, ' ')
    .replace(/\b[A-Z]{2,5}-\d+\b/g, ' ')
    .replace(/\bpr\s*#?\s*\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\([^a-z0-9]*\)/gi, ' ')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([:(])\s*([,.;:)]|$)/g, '')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s+/g, '(')
    .trim()
    .replace(/\u0001(\d+)\u0002/g, (_, index) => words[Number(index)]);
  const short = finishText(scrubbed || value, max);
  // A title that is one link too long to show whole leaves nothing: say so, do not print a blank.
  return short || (clean ? 'untitled' : '');
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

// A pointer is printed like any other link, so it is cleaned like one (see
// printableLink in lib/owner-brief.js): a link loses its login, query string, and
// fragment, and one that carries a secret is not a pointer at all, so the next kind
// is tried. A file path that the redactor would change is passed over the same way.
// A link that could not be printed is gone, all of it: the other kinds are read from the
// words around it, cleaned, and never from a piece of it (the pr123 in token=pr123 is
// part of the secret, not a pull request). A proof can be as long as someone makes it, so
// only the first part is read, cut at a space (cutAtSpace), and the patterns here take
// each character once: a run is looked at from its first character only, never again
// from every character inside it.
function extractPointer(text) {
  const value = inlineText(cutAtSpace(text), '');
  if (!value) return '';
  const url = value.match(/https?:\/\/[^\s<>"')]+/i);
  const link = url ? printableLink(url[0].replace(/(?<![.,;])[.,;]+$/, '')) : null;
  if (link) return link;
  const around = value.replace(/(?<![a-z0-9+.-])[a-z0-9+.-]*:\/\/\S*/gi, ' ');
  const pathMatch = around.match(/(?:^|\s)((?:\.atris|atris)\/[^\s,;:)]+)/i);
  const file = pathMatch ? pathMatch[1].replace(/(?<![.,;])[.,;]+$/, '') : '';
  if (file && redacted(file) === file) return file;
  const words = redacted(around);
  const pr = words.match(/\bpr\s*#?\s*\d+\b/i);
  if (pr) return pr[0].replace(/\s+/g, ' ');
  return /\b(pass(?:ed)?|verified|green|merged|ok)\b/i.test(words) ? 'proof on file' : '';
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

// Why a job is on the waiting list: someone marked its review, it sits in a
// protected lane, it is tagged for a person, or it is plain review.
function waitingKind(task) {
  const approval = String(task.review?.approval_status || task.metadata?.approval_status || '').toLowerCase();
  if (approval && approval !== 'pending') return { kind: 'approval', approval };
  const denied = deniedTagForTask(task);
  if (denied) return { kind: 'protected', lane: denied };
  if (needsHumanTag(task)) return { kind: 'human' };
  return { kind: 'review' };
}

function waitingReason(task) {
  const why = waitingKind(task);
  if (why.kind === 'approval') return `review lane is ${why.approval}`;
  if (why.kind === 'protected') return `protected ${why.lane} lane`;
  if (why.kind === 'human') return 'needs human lane';
  return 'review lane';
}

// The same reasons, said the way the owner's screen says them.
function plainWaitingWhy(task) {
  const why = waitingKind(task);
  if (why.kind === 'approval') return `Waiting in review, marked ${why.approval}.`;
  if (why.kind === 'protected') return `Protected ${why.lane} work, so only you can approve it.`;
  if (why.kind === 'human') return 'Marked as needing a person.';
  return 'Finished and waiting for your review.';
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
      title: inlineText(redacted(task.title), 'done task'),
      proof: proofPointer(task),
      age: formatAge(doneMs, nowMs),
    }));
}

// Waiting jobs, longest waiting first, each with its task and when it started
// waiting so the owner's screen can order them its own way.
function waitingEntries(tasks, nowMs) {
  return tasks
    .filter(isWaitingTask)
    .map((task) => {
      const startMs = taskTime(task, ['metadata.agent_certified_at', 'updated_at', 'created_at']);
      return {
        task,
        since: startMs || 0,
        item: {
          id: taskId(task),
          title: inlineText(redacted(task.title), 'review task'),
          why: waitingReason(task),
          age: formatAge(startMs, nowMs),
        },
      };
    })
    .sort((a, b) => a.since - b.since);
}

// What brief has always shown as waiting on you, as items on the owner's screen.
// A closed (archived) job keeps its place in the older list but nobody waits on it.
function decisionItems(entries) {
  return entries
    .filter(({ task }) => String(task.status || '').toLowerCase() !== 'archived')
    .map(({ task, since, item }) => ({
      task_id: typeof task.id === 'string' && task.id ? task.id : null,
      accept_id: item.id,
      title: task.title,
      why: plainWaitingWhy(task),
      since,
    }));
}

// A move names a job in flight and whoever holds it, so its words are cleaned like any
// other title or name (see redacted in lib/owner-brief.js).
function buildMoves(root) {
  return nextMoves(root, 3).map((move) => ({
    id: move.id,
    title: inlineText(redacted(move.title), 'next move'),
    why: inlineText(redacted(move.why || move.source), 'workspace signal'),
    source: move.source || null,
    owner: redacted(move.owner || move.member) || null,
  }));
}

function buildWeekLine(root, nowMs) {
  const data = buildWeekReportData(root, { days: 7, now: nowMs });
  return renderWeekReport(data).split(/\r?\n/)[0] || 'week in review: 0 landed, 0 completions, 0 xp';
}

// `owner` adds the owner's screen: needs_you, done_this_week, and team, read from the
// task store (see lib/owner-brief.js). The command asks for it; a caller that only
// wants the older lists (atris activate) gets exactly those and never opens the store.
function buildBriefData(root = process.cwd(), { days = 1, now = Date.now(), owner = false } = {}) {
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 1;
  const nowMs = normalizeNow(now);
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const tasks = readProjection(root);
  const entries = waitingEntries(tasks, nowMs);
  const data = {
    schema: 'atris.brief.v1',
    days: windowDays,
    landed: buildLanded(tasks, cutoffMs, nowMs),
    waiting: entries.map((entry) => entry.item),
    moves: buildMoves(root),
    week: buildWeekLine(root, nowMs),
  };
  if (!owner) return data;
  const { error, ...screen } = buildOwnerBrief(root, { now: nowMs, decisions: decisionItems(entries) });
  return { ...data, ...screen, ...(error ? { owner_error: error } : {}) };
}

function plural(count, word, pluralWord = `${word}s`) {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

// The json carries each title as the cleaner leaves it: up to 300 characters, cut at a whole word. A
// person reads it short, on one line, with the plumbing left out (operatorTitle), so the screen, the
// page, and the text sent are made from this copy.
function withShortTitles(data) {
  const short = (item) => ({ ...item, title: operatorTitle(item && item.title, OWNER_TITLE_MAX) || 'untitled' });
  return {
    ...data,
    needs_you: data.needs_you.map(short),
    done_this_week: Array.isArray(data.done_this_week) ? data.done_this_week.map(short) : data.done_this_week,
  };
}

function renderBrief(data) {
  // The owner's screen when the data has it, the older one-line-per-thing brief otherwise.
  if (Array.isArray(data?.needs_you)) return renderOwnerText(withShortTitles(data));
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

function renderOwnerHtml(data) {
  const needs = data.needs_you.length;
  const done = Array.isArray(data.done_this_week) ? data.done_this_week.length : 0;
  const shown = withShortTitles(data);
  return renderHtml({
    theme: 'atris',
    brand: { name: 'atris', accent: ' brief' },
    blocks: [
      { type: 'title', headline: 'atris brief', sub: `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you, ${done} landed this week` },
      ...ownerBlocks(shown),
      { type: 'close', tagline: 'This screen only reads your jobs.' },
    ],
  }, { title: 'atris brief' });
}

function renderBriefHtml(data) {
  if (Array.isArray(data?.needs_you)) return renderOwnerHtml(data);
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
  console.log('One screen: what needs you, what got done this week, and how the team is doing.');
  console.log('It reads your jobs. Before the screen it may quietly check GitHub and credit or release held jobs');
  console.log('whose pull request merged or closed. A merge is usually credited within the hour, by a command that');
  console.log('reaches GitHub; atris task sweep --held does it right away.');
  console.log('ATRIS_HELD_SWEEP=off turns that off.');
  console.log('--days N sets the older landed list in --json.');
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

// On the owner's screen only an item with an accept id can be accepted from the
// prompt. Pull requests are merged on GitHub, so a screen of those has nothing to ask.
function shouldPromptBrief({ flags, stdin = process.stdin, stdout = process.stdout, data }) {
  if (flags?.noInput) return false;
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  if (Array.isArray(data?.needs_you)) return data.needs_you.slice(0, SHOWN).some((item) => item.accept_id);
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

// "a 2" on the owner's screen means the second item printed there, which is not
// the second item of the older waiting list.
function acceptFromScreen(data, index, acceptTask) {
  const item = index >= 0 && index < SHOWN ? data.needs_you[index] : null;
  if (!item) return { ok: false, message: 'no item with that number on this screen' };
  if (!item.accept_id) {
    return { ok: false, message: `item ${index + 1} cannot be accepted from here. if it has a pull request, merge that on GitHub. otherwise look at the job yourself.` };
  }
  const result = acceptTask(item.accept_id);
  return { ok: result.ok, message: result.output || (result.ok ? `accepted ${item.accept_id}` : `could not accept ${item.accept_id}`) };
}

function handleBriefAnswer(root, data, answer, deps = {}) {
  const parsed = parsePromptAnswer(answer);
  const acceptTask = deps.acceptTask || ((id) => runTaskAccept(root, id));
  const moveApproval = deps.approveMove || ((move) => approveMove(root, move, deps.stamp));
  const owner = Array.isArray(data?.needs_you);
  if (parsed.action === 'skip') return { ok: true, skipped: true, message: 'skipped' };
  if (parsed.action === 'accept' && owner) return acceptFromScreen(data, parsed.index, acceptTask);
  if (parsed.action === 'move' && owner) return { ok: false, message: 'next moves are not on this screen' };
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
    const question = Array.isArray(data?.needs_you)
      ? 'a N accept an item, or enter to skip: '
      : 'a N accept waiting, m N approve move, or enter to skip: ';
    rl.question(question, (value) => {
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
  // A person's merge pays the builder with no command: the held-job check runs here.
  require('../lib/held-autosweep').autoSweepHeld({ root });

  const data = buildBriefData(root, { days: flags.days, owner: true });
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
  renderBrief,
  renderBriefHtml,
  run: briefCommand,
  shouldPromptBrief,
};
