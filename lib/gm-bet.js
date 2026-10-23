'use strict';

// gm bet: one new, specific business move nobody wrote down yet, with a
// prediction, a check date, and exact steps. The owner taps "think" on the
// phone page; this module reads real local sources (each read is a progress
// event with one real fact), asks a smart model for one bet as strict JSON,
// checks it with plain rules, and keeps every bet in a ledger. "do it" turns
// the bet into a real atris mission.
//
// Everything that touches the outside world is passed in (the model command,
// the mission runner, the clock, the file paths), so tests stub it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = 'opus';
// the skeptic is a separate call with its own prompt; it never sees the
// writer's reasoning, only the bet and the same facts
const SKEPTIC_MODEL = 'opus';
const MODEL_TIMEOUT_MS = 120000;
// the number is read over the 7 days that end on the check date, so the
// check is at least a week out and every day read is after the start
const MIN_CHECK_DAYS = 7;
const CHECK_WINDOW_DAYS = 14;
// an installs goal must beat the best week of this many past weeks
const BEST_WEEKS = 8;
// a bet whose number cannot be read yet (npm lags a few days) is tried again
// for this many days past its check date, then marked unreadable
const SCORE_GRACE_DAYS = 7;
// the task events that count as a job landing, the same ones the season board counts
const LANDED_ACTIONS = new Set(['accepted', 'merged']);
// the writer gets this many tries in all; each retry carries the reasons
const WRITER_ATTEMPTS = 3;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const BRIEF_COUNT = 3;
const BRIEF_LINES = 40;
const NOW_LINES = 60;
const OUTPUT_MAX = 2 * 1024 * 1024;
const MIN_STEPS = 2;
const MAX_STEPS = 5;
// the card has to fit one phone screen with do it visible
const WHY_MAX = 160;
const EXPECT_MAX = 160;
const STEP_MAX = 70;
const DETAIL_MAX = 240;

// A title whose whole action is one of these says nothing.
const VAGUE_VERBS = ['ship', 'improve', 'optimize', 'optimise', 'leverage', 'enhance', 'boost', 'streamline', 'explore', 'consider', 'grow', 'scale', 'focus', 'drive', 'unlock', 'maximize', 'empower', 'revamp', 'iterate', 'double'];
// Words that sound like a deliverable but are not one.
const VAGUE_NOUNS = new Set(['it', 'things', 'stuff', 'everything', 'growth', 'engagement', 'performance', 'experience', 'value', 'synergy', 'impact', 'momentum', 'better', 'more', 'improvements', 'efficiency', 'quality', 'results', 'business', 'product', 'strategy']);
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'by', 'from', 'that', 'this', 'our', 'your', 'its', 'into', 'at', 'as', 'so', 'it', 'is', 'are', 'be', 'we', 'up', 'out', 'new', 'one', 'all', 'can', 'will']);
// A step that does any of these reaches the outside world or cannot be taken
// back, so only the owner can say yes to it.
// The action of a step is its first word and any verb joined to it with
// "and" or "then": "draft the launch post" is team work, "draft and post the
// thread" is not.
const OWNER_ONLY_WORDS = new Set(['publish', 'post', 'release', 'send', 'email', 'tweet', 'announce', 'spend', 'pay', 'buy', 'purchase', 'charge', 'deploy', 'delete', 'launch', 'submit', 'invoice', 'refund', 'dm', 'merge']);
// Words that name a source we can actually read the result from.
const METRIC_SOURCES = ['npm', 'install', 'download', 'git', 'master', 'landed', 'commit', 'task', 'review', 'queue', 'waiting', 'target', 'season', 'gm', 'ledger', 'bet', 'now.md', 'brief', 'mission'];
// The numbers a bet's target can name: each one we can read again on the
// check date, from the same place, the same way. Installs should go up past
// our best recent week; at least half of the jobs waiting on review today
// should land. Changes merged and the size of the queue are left out on
// purpose: filler jobs inflate one, and closing jobs empties the other.
const METRICS = {
  installs: { what: 'npm installs in the 7 days that end on the check date', now: 'installs last week', up: true },
  queue_landed: { what: 'jobs waiting on review today with real work behind them (a commit on a branch or on master that touches their own check) that land, accepted or merged, by the check date; placeholders do not count, and closing, dropping, or parking one counts zero', now: 'jobs landed from today\'s review queue', up: true },
};

// ---- small helpers -------------------------------------------------------------

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function commas(n) {
  return Number(n).toLocaleString('en-US');
}

function dayKey(at) {
  const d = new Date(at);
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function defaultStateDir() {
  return path.join(require('./state-home').atrisHome(), 'state');
}

// ---- the ledger ------------------------------------------------------------------

function ledgerPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'gm-bets.jsonl');
}

// Every row is one change to one bet; the newest row for an id wins.
function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function readLedger(file, workspaceRoot) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || !row.id || row.workspace !== workspaceRoot) continue;
    byId.set(row.id, { ...(byId.get(row.id) || {}), ...row });
  }
  return [...byId.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// ---- the owner's focus: answers to the question cards ----------------------------

// Lives beside the ledger, one row per answer; the newest answer per question wins.
function focusPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'gm-focus.jsonl');
}

function readFocus(file, workspaceRoot) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.key && row.workspace === workspaceRoot) out[row.key] = row;
    } catch {
      // a torn line is skipped
    }
  }
  return out;
}

// An answer newer than this is still fresh, so its question is not asked again.
const FOCUS_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

// Our own words, which the owner never reads: on a card, a button, the
// footer, a question, or in what the writer model says. A binary tell, so a
// word list is the right tool.
const OWNER_BANNED_WORDS = ['bet', 'bets', 'check date', 'started so far', 'the team takes on', 'mission', 'queue', 'landed', 'review', 'reviewed', 'receipt', 'skeptic', 'verify', 'target number'];
const OWNER_BANNED = /\b(bets?|check dates?|started so far|the team takes on|missions?|queues?|landed|review(?:ed|s)?|receipts?|skeptics?|verify|target numbers?)\b/i;

// When no idea is ready the desk asks the owner a question about his
// project. The questions are written ahead, in the background, from that
// project's own files and every earlier answer, like an interview. Until one
// is written, this one works for any project.
const FALLBACK_QUESTION = {
  key: 'focus',
  ask: 'what matters most for this project this month?',
  choices: [
    { id: 'using', label: 'more people using it' },
    { id: 'money', label: 'making money from it' },
    { id: 'better', label: 'making it better' },
  ],
};
// questions kept written ahead, so a tap never waits on one
const QUESTIONS_READY = 2;
const QUESTION_ASK_MAX = 90;
const QUESTION_FACT_MAX = 160;
const QUESTION_CHOICE_MAX = 50;

function questionsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'gm-questions.jsonl');
}

// installs said the way the owner would say them, when this project has npm numbers
function installsLine(bundle) {
  const inst = bundle && bundle.sources && bundle.sources.installs;
  const d = inst && inst.data;
  if (!d || d.week_before == null) return null;
  if (d.last_week === d.week_before) return `installs held at ${commas(d.last_week)} last week.`;
  return d.last_week < d.week_before
    ? `installs dropped to ${commas(d.last_week)} last week, down from ${commas(d.week_before)}.`
    : `installs rose to ${commas(d.last_week)} last week, up from ${commas(d.week_before)}.`;
}

// What this project is, in its own words: the readme, the goals, the
// persona, and the top of the map and the wiki. Read-only; a missing file is
// left out.
const CONTEXT_FILES = [['README.md', 60], ['atris/goals.md', 40], ['atris/PERSONA.md', 30], ['atris/MAP.md', 30], ['atris/wiki/index.md', 30]];
function readProjectContext(workspaceRoot) {
  const parts = [];
  for (const [rel, lines] of CONTEXT_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(workspaceRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const body = text.split(/\r?\n/).slice(0, lines).join('\n').trim();
    if (body) parts.push(`## ${rel}\n${body}`);
  }
  return parts.join('\n\n');
}

// A fact line is drawn from the project's files: it has a number from them,
// or four words in a row copied from them.
function citesText(fact, source) {
  const nums = t => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => n.replace(/,/g, ''));
  const have = new Set(nums(source));
  if (nums(fact).some(n => have.has(n))) return true;
  const src = ` ${words(source).join(' ')} `;
  const w = words(fact);
  for (let i = 0; i + 4 <= w.length; i += 1) {
    const gram = w.slice(i, i + 4);
    if (gram.every(x => STOP_WORDS.has(x))) continue;
    if (src.includes(` ${gram.join(' ')} `)) return true;
  }
  return false;
}

// a question about our own pipeline, not his product
const PROCESS_TALK = /\b(ideas?|the team)\b/i;

// The code checks on a written question. Our own words and lengths can be
// fixed by one rewrite; anything else drops the question.
function validateQuestion(q, { source = '', avoid = [] } = {}) {
  const reasons = [];
  const format = new Set();
  const fmt = (r) => { reasons.push(r); format.add(r); };
  if (!q || typeof q !== 'object' || Array.isArray(q)) return { ok: false, reasons: ['the answer was not one JSON object'], formatOnly: false };
  const ask = typeof q.ask === 'string' ? q.ask.trim() : '';
  const fact = typeof q.fact === 'string' ? q.fact.trim() : '';
  const choices = Array.isArray(q.choices) ? q.choices.map(c => (typeof c === 'string' ? c.trim() : '')) : null;
  if (!ask || !ask.endsWith('?')) reasons.push('ask must be one question ending with "?"');
  else if (ask.length > QUESTION_ASK_MAX) fmt(`ask is ${ask.length} characters, over ${QUESTION_ASK_MAX}`);
  if (ask && avoid.some(a => nearDuplicate(ask, a))) reasons.push('the ask was already asked');
  // the fact is optional: a question with no fitting fact stands on its own
  if (!fact) { /* no fact */ } else if (fact.length > QUESTION_FACT_MAX) fmt(`fact is ${fact.length} characters, over ${QUESTION_FACT_MAX}`);
  else if (!citesText(fact, source)) reasons.push("the fact is not in this project's files");
  if (!choices || choices.length < 2 || choices.length > 3 || choices.some(c => !c)) reasons.push('choices must be 2 or 3 short answers');
  else {
    choices.forEach((c, i) => { if (c.length > QUESTION_CHOICE_MAX) fmt(`choice ${i + 1} is ${c.length} characters, over ${QUESTION_CHOICE_MAX}`); });
    if (new Set(choices.map(c => c.toLowerCase())).size !== choices.length) reasons.push('the choices must differ');
  }
  for (const [k, text] of [['ask', ask], ['fact', fact]]) {
    if (PROCESS_TALK.test(text)) fmt(`${k} talks about our ideas or the team; ask about the product and its people`);
  }
  const said = [['ask', ask], ['fact', fact], ...(choices || []).map((c, i) => [`choice ${i + 1}`, c])];
  for (const [k, text] of said) {
    const word = ownerWord(text);
    if (word) fmt(`${k} uses "${word}", a word the owner never reads; say it plainly`);
  }
  return { ok: reasons.length === 0, reasons, formatOnly: reasons.length > 0 && reasons.every(r => format.has(r)) };
}

function buildQuestionPrompt(bundle, context, { answers = [], avoid = [] } = {}) {
  return [
    'You are interviewing the owner of this project to learn what matters to him. Below is what this project\'s own files say.',
    'Write exactly ONE question for the owner about the product or the business of this project: its people, money, what is working, what annoys him, or what he wants this month. Never ask about how the team works, its tools, or its process.',
    'It is an interview: build on his earlier answers, go one step deeper, and never repeat a question already asked.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"ask": "...", "fact": "...", "choices": ["...", "...", "..."]}',
    '',
    'Rules:',
    `- ask: one short plain question, under ${QUESTION_ASK_MAX} characters, ending with "?".`,
    `- fact: the plain reason this question matters now, one sentence he would say himself, drawn from the files below, with a number or at least four words in a row copied from them, under ${QUESTION_FACT_MAX} characters. it must lead straight to the question. if nothing in the files gives a reason for this question, set fact to "".`,
    `- choices: 2 or 3 short concrete answers he can tap, each under ${QUESTION_CHOICE_MAX} characters.`,
    `- never use these words: ${OWNER_BANNED_WORDS.join(', ')}.`,
    '- a section marked stale is old: prefer the fresh ones, and never present a stale line as what is happening now.',
    '- ask about the product and the people who use it or pay for it, for example "who do you most want using this?". never mention ideas, the team, or what happens to his answer.',
    '- plain lowercase-friendly words, no hype, no em dashes.',
    '',
    '## his answers so far',
    ...(answers.length ? answers.map(a => `- ${a.ask} ${a.label}`) : ['- none yet']),
    '',
    '## questions already asked (never repeat one)',
    ...(avoid.length ? avoid.map(a => `- ${a}`) : ['- none yet']),
    '',
    '## this project\'s files',
    context || '(no readme or goals found)',
    '',
    bundleText(bundle),
  ].join('\n');
}

function buildQuestionRewrite(previous, reasons) {
  return [
    'Your last question broke only these limits:',
    ...reasons.map(r => `- ${r}`),
    '',
    'Fix only those: shorten what is long, and swap each word named for a plain one. Keep the same question, fact, and choices otherwise.',
    'Answer with the whole JSON object again, strict JSON only, no prose and no code fence.',
    '',
    'Your last question:',
    clip(previous, 2000),
  ].join('\n');
}

// One question for the owner, written from this project's files and his
// earlier answers. A question with our own words gets one rewrite; one that
// still fails any check is dropped.
async function generateQuestion({ workspaceRoot, answers = [], avoid = [], bundle = null, deps = {}, ledgerFile, today = dayKey(Date.now()) } = {}) {
  const b = bundle || await readBundle(workspaceRoot, { deps, ledgerFile, today });
  const context = (deps.readContext || readProjectContext)(workspaceRoot);
  const source = `${context}\n${bundleText(b)}`;
  const run = deps.runModel || runModel;
  const ask = async (prompt) => {
    const said = await run(prompt, { cwd: workspaceRoot, onProgress: () => {} });
    if (!said.ok) return { failed: said.reason };
    const parsed = parseBet(said.text);
    return { parsed, check: parsed.error ? { ok: false, reasons: [parsed.error], formatOnly: false } : validateQuestion(parsed.bet, { source, avoid }) };
  };
  let r = await ask(buildQuestionPrompt(b, context, { answers, avoid }));
  if (r.failed) return { ok: false, reason: r.failed };
  if (!r.check.ok && r.check.formatOnly) {
    r = await ask(buildQuestionRewrite(JSON.stringify(r.parsed.bet), r.check.reasons));
    if (r.failed) return { ok: false, reason: r.failed };
  }
  if (!r.check.ok) return { ok: false, reason: `the question was dropped: ${r.check.reasons.slice(0, 3).join('; ')}` };
  const q = r.parsed.bet;
  const fact = typeof q.fact === 'string' && q.fact.trim() ? q.fact.trim() : null;
  return { ok: true, question: { ask: q.ask.trim(), fact, choices: q.choices.map(c => c.trim()) } };
}

// The first of our own words in a line the owner reads, or null.
function ownerWord(text) {
  const m = OWNER_BANNED.exec(String(text || ''));
  return m ? m[0].toLowerCase() : null;
}

function ledgerLine(bets) {
  if (!bets.length) return 'past bets: none yet';
  const count = s => bets.filter(b => b.status === s).length;
  const open = count('proposed') + count('doing');
  return `past bets: ${bets.length} (${count('won')} won, ${count('lost')} lost, ${open} open, ${count('skipped')} skipped)`;
}

// ---- reading the sources -----------------------------------------------------------

function readNow(workspaceRoot) {
  const file = path.join(workspaceRoot, 'atris', 'now.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).slice(0, NOW_LINES);
  const updated = lines.map(l => /^last updated:\s*(.+)$/i.exec(l.trim())).find(Boolean);
  const fact = updated ? `read now.md, last updated ${clip(updated[1], 40)}` : `read now.md, ${plural(lines.filter(l => l.trim()).length, 'line')}`;
  return { fact, text: lines.join('\n') };
}

// ---- what the project is about now: its goal, open missions, and journal ----------

// a source older than this is labeled stale, and the writers prefer fresher ones
const STALE_DAYS = 14;
const MISSIONS_SHOWN = 8;
const JOURNAL_LINES = 20;
const JOURNAL_CHARS = 1500;

// whole days from an ISO date (or "YYYY-MM-DD ...") to today, or null
function ageDays(when, today) {
  const day = /(\d{4}-\d{2}-\d{2})/.exec(String(when || ''));
  if (!day) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day[1]}T00:00:00Z`)) / 86400000);
}

function staleNote(age) {
  return age != null && age > STALE_DAYS ? `stale: ${age} days old` : null;
}

// The goal: the endgame horizon in atris/TODO.md (what the boot shows as the
// goal) and the sentence set with atris goal, each with the day it was set.
function readGoal(workspaceRoot) {
  const out = {};
  try {
    const todo = fs.readFileSync(path.join(workspaceRoot, 'atris', 'TODO.md'), 'utf8');
    const section = (/##\s+Endgame\s*\n([\s\S]*?)(?=\n##|$)/.exec(todo) || [])[1] || '';
    const horizon = (/\*\*Horizon:\*\*\s*(.+)/.exec(section) || [])[1];
    const picked = (/\*\*Picked:\*\*\s*(.+)/.exec(section) || [])[1];
    if (horizon && horizon.trim()) out.horizon = { text: clip(horizon, 240), at: picked ? picked.trim().slice(0, 10) : null };
  } catch {
    // no TODO.md here
  }
  try {
    const board = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.atris', 'state', 'scoreboard.json'), 'utf8'));
    if (board && typeof board.goal === 'string' && board.goal.trim()) out.goal = { text: clip(board.goal, 240), at: board.updated_at ? String(board.updated_at).slice(0, 10) : null };
  } catch {
    // no goal set
  }
  return out.horizon || out.goal ? out : null;
}

// a mission's objective as a plain title: its first sentence
function missionTitle(objective) {
  return clip(String(objective || '').split(/\.\s/)[0].replace(/[.\s]+$/, ''), 100);
}

// Open missions, freshest first, as plain titles with who owns each.
function openMissions(missions, today) {
  const list = missions instanceof Map ? [...missions.values()] : Object.values(missions || {});
  return list
    .filter(m => m && OPEN_MISSION.has(String(m.status || '')) && m.objective)
    .map((m) => {
      const moved = [m.last_tick_at, m.updated_at, m.created_at].filter(Boolean).sort().pop();
      return { title: missionTitle(m.objective), owner: m.owner || null, moved, age: ageDays(moved, today), running: m.status === 'running' };
    })
    // a run that says running but has not moved in a day is dead, not open work
    .filter(m => !(m.running && m.age != null && m.age >= 1))
    .sort((a, b) => String(b.moved).localeCompare(String(a.moved)))
    .slice(0, MISSIONS_SHOWN);
}

// The newest day in atris/logs, its last lines, bounded.
function readJournal(workspaceRoot) {
  const dir = path.join(workspaceRoot, 'atris', 'logs');
  let newest = null;
  try {
    for (const year of fs.readdirSync(dir)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const f of fs.readdirSync(path.join(dir, year))) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && (!newest || f > newest.name)) newest = { name: f, file: path.join(dir, year, f) };
      }
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  let text;
  try {
    text = fs.readFileSync(newest.file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(-JOURNAL_LINES);
  return lines.length ? { day: newest.name.slice(0, 10), text: lines.join('\n').slice(-JOURNAL_CHARS) } : null;
}

// The weekly target and the season record, read the same way the board reads them.
function defaultSeasonFacts(workspaceRoot) {
  const season = require('./gm-season');
  const loaded = season.loadSeason(workspaceRoot, { lastSeen: null });
  const board = season.seasonBoard(loaded, { limit: 8, lastSeen: null });
  if (board.error) return null;
  const mood = board.mood || {};
  return {
    landed: (mood.landed_by_autoland || 0) + (mood.landed_by_you || 0),
    target: board.target ? { landed: board.target.landed, goal: board.target.target.landed, verdict: board.target.verdict } : null,
    record: board.record ? { won: board.record.won, lost: board.record.lost } : null,
    waiting_on_review: mood.waiting_on_review || 0,
    // the jobs behind that count, so a bet can be scored on these exact ones
    waiting_jobs: (loaded.reviews || []).map(r => ({ id: r.task_id, title: r.title })),
    stuck: mood.stuck || 0,
  };
}

function seasonFact(s) {
  const head = s.target
    ? `this week: ${s.target.landed} of ${s.target.goal} landed, ${s.target.verdict}`
    : `this week: ${plural(s.landed, 'job')} landed, no target set`;
  const record = s.record ? `, season ${s.record.won} won ${s.record.lost} lost` : '';
  return `${head}${record}, ${s.waiting_on_review} waiting on review, ${s.stuck} stuck`;
}

// One row per first-parent commit on origin/master in the last 7 days: a
// merged pull request or a direct commit, each counted once. A merge's subject
// is "Merge pull request #n from branch", so its title is the body's first line.
function landedRows(stdout) {
  return String(stdout || '').split('\x1e').map((rec) => {
    const [subject = '', body = ''] = rec.replace(/^\s+/, '').split('\x1f');
    if (!subject.trim()) return null;
    const title = /^Merge pull request #\d+/.test(subject) ? (body.split('\n').map(l => l.trim()).find(Boolean) || subject) : subject;
    return title.trim();
  }).filter(Boolean);
}

function gitOut(workspaceRoot, args) {
  const { spawnSync } = require('child_process');
  const res = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : null;
}

function mainRef(workspaceRoot) {
  return ['origin/master', 'origin/main'].find(ref => gitOut(workspaceRoot, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]) !== null) || null;
}

function defaultGitLanded(workspaceRoot) {
  const ref = mainRef(workspaceRoot);
  if (!ref) return null;
  const out = gitOut(workspaceRoot, ['log', ref, '--first-parent', '--since=7 days ago', '--format=%s%x1f%b%x1e']);
  return out === null ? null : landedRows(out);
}

// ---- the best recent week: the bar an installs bet has to clear -----------------

// The biggest weekly total among the newest BEST_WEEKS. totals are newest first.
function bestWeek(totals) {
  const t = (totals || []).filter(n => Number.isFinite(n)).slice(0, BEST_WEEKS);
  if (!t.length) return null;
  return { best: Math.max(...t), weeks: t.length };
}

// npm days, oldest first, cut into full 7-day blocks from the newest day back.
// Days before the package had any installs are not weeks it existed.
function installTotals(body, weeks = BEST_WEEKS) {
  const days = (body && Array.isArray(body.downloads) ? body.downloads : [])
    .filter(d => d && typeof d.downloads === 'number' && d.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const first = days.findIndex(d => d.downloads > 0);
  const live = first < 0 ? [] : days.slice(first);
  const totals = [];
  for (let end = live.length; end - 7 >= 0 && totals.length < weeks; end -= 7) {
    totals.push(live.slice(end - 7, end).reduce((n, d) => n + d.downloads, 0));
  }
  return totals;
}

function bestSpan(weeks) {
  return weeks === 8 ? '2 months' : plural(weeks, 'week');
}

// ---- the release gap: what is merged but not in the published package -----------

// How many first-parent commits on master are not in the v<version> tag.
// No tag here means the number is unknown, never a guess.
function defaultReleaseGap(workspaceRoot, version) {
  const tag = `v${version}`;
  if (gitOut(workspaceRoot, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]) === null) return { count: null, why: `no ${tag} tag here` };
  const ref = mainRef(workspaceRoot);
  if (!ref) return { count: null, why: 'could not read master' };
  const out = gitOut(workspaceRoot, ['rev-list', '--first-parent', '--count', `${tag}..${ref}`]);
  const count = out === null ? NaN : Number(out.trim());
  return Number.isInteger(count) ? { count } : { count: null, why: `could not compare ${tag} with master` };
}

function releaseFact(version, gap) {
  if (gap && Number.isInteger(gap.count)) {
    return gap.count === 0 ? `published ${version}; everything on master is published` : `published ${version}; ${commas(gap.count)} ${gap.count === 1 ? 'change' : 'changes'} on master not published yet`;
  }
  return `published ${version}; changes on master not published yet: unknown${gap && gap.why ? ` (${gap.why})` : ''}`;
}

function npmName(pkg) {
  return encodeURIComponent(pkg).replace('%40', '@');
}

function defaultFetchJson(url, { timeoutMs = 10000 } = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'atris-gm-bet' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function packageName(workspaceRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
    return pkg && typeof pkg.name === 'string' && pkg.name && !pkg.private ? pkg.name : null;
  } catch {
    return null;
  }
}

// npm's range endpoint gives one row per day. Last week is the newest 7 days
// with data, the week before is the 7 before that.
function installWeeks(body) {
  const days = (body && Array.isArray(body.downloads) ? body.downloads : [])
    .filter(d => d && typeof d.downloads === 'number' && d.day)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (days.length < 7) return null;
  const sum = rows => rows.reduce((n, d) => n + d.downloads, 0);
  const last = sum(days.slice(-7));
  const before = days.length >= 14 ? sum(days.slice(-14, -7)) : null;
  return { last_week: last, week_before: before, through: days[days.length - 1].day };
}

// The real team: every atris/team/<name>/MEMBER.md, with its name and a
// one-line role from the frontmatter (role, then description).
function readTeam(workspaceRoot) {
  const dir = path.join(workspaceRoot, 'atris', 'team');
  let names;
  try {
    names = fs.readdirSync(dir).filter(n => !n.startsWith('_') && !n.startsWith('.'));
  } catch {
    return null;
  }
  const team = [];
  for (const name of names.sort()) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name, 'MEMBER.md'), 'utf8');
    } catch {
      continue;
    }
    const head = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text) || [])[1] || '';
    const field = k => ((new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    const role = field('role');
    const description = field('description');
    const line = [role, description].filter(Boolean).join('. ');
    team.push({ name, role: clip(line || 'team member', 110) });
  }
  return team.length ? team : null;
}

// A verify command that always passes proves nothing. Binary checks only:
// every piece of it is one of these, or it swallows failure with || true.
const TRIVIAL_VERIFY = [
  /^true$/, /^:$/, /^exit 0$/, /^echo\b/, /^printf\b/,
  /^git diff --check$/,
  /^test \d+ -(?:eq|ne|gt|ge|lt|le) \d+$/, /^\[ \d+ -(?:eq|ne|gt|ge|lt|le) \d+ \]$/,
];

function verifyProblem(command) {
  const text = String(command || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'verify is missing; give one command that proves the deliverable (a test file, a file that must exist, a count read back)';
  if (/\|\|\s*(?:true|:|exit 0)\b/.test(text)) return `verify "${clip(text, 80)}" can never fail (it ends in || true); it must fail when the deliverable is missing`;
  const parts = text.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
  if (parts.every(part => TRIVIAL_VERIFY.some(re => re.test(part)))) return `verify "${clip(text, 80)}" is always true or only checks formatting; it must prove the deliverable (a test file, a file that must exist, a count read back)`;
  return null;
}

function readBriefs(workspaceRoot) {
  const dir = path.join(workspaceRoot, 'atris', 'wiki', 'briefs');
  let names;
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.md'));
  } catch {
    return null;
  }
  const rows = names.map((name) => {
    const file = path.join(dir, name);
    try {
      return { name, file, mtime: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, BRIEF_COUNT);
  if (!rows.length) return null;
  return rows.map((r) => {
    const head = fs.readFileSync(r.file, 'utf8').split(/\r?\n/).slice(0, BRIEF_LINES).join('\n');
    const title = (/^#\s+(.+)$/m.exec(head) || [])[1] || r.name.replace(/\.md$/, '');
    return { name: r.name, title: clip(title, 80), text: head };
  });
}

// ---- scoring: did a bet move its number? -------------------------------------------

function daysBetween(from, to) {
  const at = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((at(to) - at(from)) / (24 * 60 * 60 * 1000));
}

// How many of these job ids landed (a completed event whose action is
// accepted or merged, the season board's rule) at or before endMs. A job that
// was closed, dropped, archived, or parked has no such event and counts zero.
// Opens the task db read-only. Resolves { value } or { error, transient }.
function defaultLandedFromQueue(ids, endMs, { dbPath } = {}) {
  const target = dbPath || require('./task-db').getDbPath();
  if (!fs.existsSync(target)) return { error: 'there is no task history here', transient: true };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const marks = ids.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT task_id, payload FROM task_events WHERE event_type = 'completed' AND created_at <= ? AND task_id IN (${marks})`).all(endMs, ...ids);
    const landed = new Set();
    for (const row of rows) {
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}') || {}; } catch { payload = {}; }
      if (LANDED_ACTIONS.has(payload.action)) landed.add(row.task_id);
    }
    return { value: landed.size };
  } catch (err) {
    return { error: `could not read the task history: ${err.message}`, transient: true };
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
}

// ---- which waiting jobs have real work behind them --------------------------------

// The test file a job's verify command runs, or null when the check is a
// generic suite run (or missing): such a job has no check of its own.
function verifyTestFile(verify) {
  const text = Array.isArray(verify) ? verify.join(' ') : String(verify || '');
  const hit = /(?:^|[\s'"])((?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]s)\b/.exec(text);
  return hit ? hit[1] : null;
}

const QUEUE_KINDS = ['branch', 'merged_open', 'no_work', 'placeholder', 'unknown'];
// jobs that can actually land: their work exists somewhere git can see
const REAL_WORK = new Set(['branch', 'merged_open']);

// Sorts the waiting jobs, read-only, by what git and the task db can show:
//   merged_open  a commit on master since the job was made touches its test file
//   branch       a commit on another branch since then touches it
//   no_work      it has its own check, but no commit touches the file yet
//   placeholder  no check of its own (no test file in verify)
//   unknown      the db or git could not tell
function defaultClassifyQueue(workspaceRoot, jobs, { dbPath } = {}) {
  const meta = new Map();
  const target = dbPath || require('./task-db').getDbPath();
  let db;
  try {
    if (!fs.existsSync(target)) throw new Error('no task db');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target, { readOnly: true });
    const ids = jobs.map(j => j.id);
    const rows = ids.length ? db.prepare(`SELECT id, created_at, metadata FROM tasks WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) : [];
    for (const row of rows) {
      let m = {};
      try { m = JSON.parse(row.metadata || '{}') || {}; } catch { m = {}; }
      meta.set(row.id, { verify: m.verify, created_at: Number(row.created_at) });
    }
  } catch {
    return jobs.map(j => ({ ...j, kind: 'unknown' }));
  } finally {
    try { if (db) db.close(); } catch { /* already closed */ }
  }
  const ref = mainRef(workspaceRoot);
  return jobs.map((j) => {
    const m = meta.get(j.id);
    if (!m) return { ...j, kind: 'unknown' };
    const file = verifyTestFile(m.verify);
    if (!file) return { ...j, kind: 'placeholder' };
    if (!ref || !Number.isFinite(m.created_at)) return { ...j, kind: 'unknown', file };
    const since = `--since=@${Math.floor(m.created_at / 1000)}`;
    const onMaster = gitOut(workspaceRoot, ['log', ref, '-1', '--format=%H', since, '--', file]);
    if (onMaster === null) return { ...j, kind: 'unknown', file };
    if (onMaster.trim()) return { ...j, kind: 'merged_open', file };
    const anywhere = gitOut(workspaceRoot, ['log', '--branches', '--remotes', '-1', '--format=%H', since, '--', file]);
    if (anywhere === null) return { ...j, kind: 'unknown', file };
    return { ...j, kind: anywhere.trim() ? 'branch' : 'no_work', file };
  });
}

function queueFact(split) {
  const n = k => split.filter(j => j.kind === k).length;
  const parts = [];
  if (n('branch')) parts.push(`${n('branch')} with work on a branch`);
  if (n('merged_open')) parts.push(`${n('merged_open')} already merged but open`);
  if (n('no_work')) parts.push(`${n('no_work')} with a check but no work yet`);
  if (n('placeholder')) parts.push(`${n('placeholder')} ${n('placeholder') === 1 ? 'placeholder' : 'placeholders'} with no check`);
  if (n('unknown')) parts.push(`${n('unknown')} unknown`);
  return `${split.length} waiting: ${parts.join(', ') || 'none'}`;
}

// The end of a local calendar day, as epoch ms.
function dayEndMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0).getTime() - 1;
}

// Reads one metric the same way the bundle reads it. installs: the 7 days
// that end on `end` (inclusive), from npm. queue_landed: how many of the job
// ids snapshotted when the bet was made landed by the end of `end`, from the
// task db. Resolves { value } or { error, transient }; transient means try
// again later (npm has not counted the days yet, or the db is busy), not
// transient means never.
async function defaultReadMetric(metric, { workspaceRoot, start, end, target = {}, deps = {} }) {
  if (metric === 'installs') {
    const pkg = deps.packageName !== undefined ? deps.packageName : packageName(workspaceRoot);
    if (!pkg) return { error: 'no published package here to read installs from', transient: false };
    let body;
    try {
      body = await (deps.fetchJson || defaultFetchJson)(`https://api.npmjs.org/downloads/range/${start}:${end}/${npmName(pkg)}`);
    } catch (err) {
      return { error: `could not reach npm: ${err.message}`, transient: true };
    }
    const days = (body && Array.isArray(body.downloads) ? body.downloads : []).filter(d => d && typeof d.downloads === 'number' && d.day >= start && d.day <= end);
    if (days.length < 7 || !days.some(d => d.day === end)) return { error: `npm has not counted every day up to ${end} yet`, transient: true };
    return { value: days.reduce((n, d) => n + d.downloads, 0) };
  }
  if (metric === 'queue_landed') {
    const ids = Array.isArray(target.job_ids) ? target.job_ids.filter(Boolean) : [];
    if (!ids.length) return { error: 'the bet has no snapshot of the waiting jobs to score', transient: false };
    return (deps.landedFromQueue || defaultLandedFromQueue)(ids, dayEndMs(end), { dbPath: deps.taskDbPath });
  }
  return { error: `there is no way to read "${metric}"`, transient: false };
}

// Won when the number reached the goal.
function wonBet(metric, actual, goal) {
  return METRICS[metric].up ? actual >= goal : actual <= goal;
}

// Scores every bet the team is doing once its check date is over: reads its
// target number and records won or lost with the real number. Proposed bets
// are never scored. A number that can never be read is marked unreadable
// with why (old "waiting" and "landed" bets, bets with no target); one that
// is only late (npm lags, the db is busy) waits up to SCORE_GRACE_DAYS.
async function scoreBets(workspaceRoot, { ledgerFile = ledgerPath(), today = dayKey(Date.now()), deps = {}, emit = () => {} } = {}) {
  const due = readLedger(ledgerFile, workspaceRoot).filter(b => b.status === 'doing' && b.bet && /^\d{4}-\d{2}-\d{2}$/.test(String(b.bet.check_date || '')) && b.bet.check_date < today);
  const read = deps.readMetric || defaultReadMetric;
  const scored = [];
  for (const b of due) {
    const t = b.bet.target;
    const metric = t && t.metric;
    const end = b.bet.check_date;
    const start = addDays(end, -6);
    const late = daysBetween(end, today);
    const row = { id: b.id, workspace: workspaceRoot, at: new Date().toISOString(), scored_on: today };
    let out;
    if (!t || !METRICS[metric] || !Number.isFinite(t.goal)) {
      out = { error: metric && !METRICS[metric] ? `there is no way to read "${metric}"` : 'the bet has no target number to read', transient: false };
    } else {
      try {
        out = await read(metric, { workspaceRoot, start, end, target: t, deps });
      } catch (err) {
        out = { error: String((err && err.message) || err), transient: true };
      }
    }
    if (!out || !Number.isFinite(out.value)) {
      const why = (out && out.error) || 'the number could not be read';
      if (out && out.transient && late <= SCORE_GRACE_DAYS) continue;
      Object.assign(row, { status: 'unreadable', why });
    } else {
      const window = metric === 'installs' ? `${start} to ${end}` : `landed by the end of ${end}, of ${plural(t.job_ids.length, 'job')} waiting at the start`;
      Object.assign(row, { status: wonBet(metric, out.value, t.goal) ? 'won' : 'lost', actual: out.value, window });
    }
    appendLedger(ledgerFile, row);
    scored.push({ ...row, title: b.bet.title });
    const line = row.status === 'unreadable' ? `could not score a past bet: ${clip(b.bet.title, 60)} (${row.why})` : `scored a past bet: ${row.status}, ${clip(b.bet.title, 60)} (goal ${commas(t.goal)}, got ${commas(row.actual)})`;
    emit({ kind: 'score', key: 'score', line });
  }
  return scored;
}

// The readable numbers in this bundle: today's value and the bar a goal must
// clear. installs: above the best week of the last 8. queue_landed: at least
// half of the jobs waiting on review today, counted from 0.
function bundleMetrics(bundle) {
  const s = (bundle && bundle.sources) || {};
  const out = {};
  if (s.installs) {
    const best = s.installs.best || null;
    out.installs = { baseline: s.installs.data.last_week, best: best ? best.best : null, weeks: best ? best.weeks : 0 };
  }
  if (s.queue && Array.isArray(s.queue.jobs)) {
    // placeholders, jobs with no work yet, and unknowns are left out of both
    // the snapshot and the bar
    const ids = s.queue.jobs.filter(j => REAL_WORK.has(j.kind)).map(j => j.id).filter(Boolean);
    out.queue_landed = { baseline: 0, waiting: s.queue.jobs.length, real: ids.length, least: Math.ceil(ids.length / 2), ids };
  }
  return out;
}

// Reads every source, in a fixed order, and emits one event per source with
// a real fact (or says it was left out). A missing source is omitted, never
// invented. Past bets that are due are scored first, so the ledger the model
// reads already has their results.
async function readBundle(workspaceRoot, { deps = {}, emit = () => {}, ledgerFile, today = dayKey(Date.now()) } = {}) {
  const ledger = ledgerFile || ledgerPath();
  try {
    await (deps.scoreBets || scoreBets)(workspaceRoot, { ledgerFile: ledger, today, deps, emit });
  } catch {
    // scoring is a side job; a failure never blocks the next bet
  }
  const bundle = { workspace: workspaceRoot, today, sources: {}, facts: [] };
  const add = (key, fact, data) => {
    bundle.sources[key] = { fact, ...data };
    bundle.facts.push(fact);
    emit({ kind: 'source', key, line: fact });
  };
  const skip = (key, why) => emit({ kind: 'skip', key, line: why });

  const now = (deps.readNow || readNow)(workspaceRoot);
  if (now) {
    const age = ageDays(/last updated:\s*(.+)$/im.exec(now.text || '') ? /last updated:\s*(.+)$/im.exec(now.text)[1] : null, today);
    const stale = staleNote(age);
    add('now', stale ? `${now.fact}, ${age} days ago, stale` : now.fact, { text: now.text, ...(stale ? { stale: age } : {}) });
  } else skip('now', 'no atris/now.md, left out');

  let season = null;
  try {
    season = (deps.seasonFacts || defaultSeasonFacts)(workspaceRoot);
  } catch {
    season = null;
  }
  if (season) add('season', seasonFact(season), { data: season });
  else skip('season', 'could not read the task list, left out');

  // the review queue split by what is really behind each job: only jobs whose
  // work git can see can land, so only those count toward a queue target
  if (season && Array.isArray(season.waiting_jobs)) {
    let split;
    try {
      split = (deps.classifyQueue || defaultClassifyQueue)(workspaceRoot, season.waiting_jobs, { dbPath: deps.taskDbPath });
    } catch {
      split = season.waiting_jobs.map(j => ({ ...j, kind: 'unknown' }));
    }
    // team plumbing: kept for the queue_landed metric code, never shown to the owner or the writer
    bundle.sources.queue = { fact: queueFact(split), jobs: split };
  }

  let landed = null;
  try {
    landed = (deps.gitLanded || defaultGitLanded)(workspaceRoot);
  } catch {
    landed = null;
  }
  if (landed) add('landed', `changes merged this week: ${commas(landed.length)}`, { subjects: landed.slice(0, 40) });
  else skip('landed', 'could not read what landed on master, left out');

  const pkg = deps.packageName !== undefined ? deps.packageName : packageName(workspaceRoot);
  const fetchJson = deps.fetchJson || defaultFetchJson;
  let installs = null;
  let installBody = null;
  if (pkg) {
    try {
      // a year of days: last week, the week before, and the last 8 full weeks
      installBody = await fetchJson(`https://api.npmjs.org/downloads/range/last-year/${npmName(pkg)}`);
      installs = installWeeks(installBody);
    } catch {
      installs = null;
    }
  }
  if (installs) {
    const before = installs.week_before == null ? '' : ` (week before: ${commas(installs.week_before)})`;
    add('installs', `installs last week: ${commas(installs.last_week)}${before}`, { package: pkg, data: installs });
    const best = bestWeek(installTotals(installBody));
    if (best) {
      bundle.sources.installs.best = best;
      add('installs_best', `best week for installs in the last ${bestSpan(best.weeks)}: ${commas(best.best)}`, { metric: 'installs', ...best });
    } else {
      skip('installs_best', 'no full week of installs yet, so there is no best week to beat');
    }
  } else {
    skip('installs', pkg ? 'could not reach npm for installs, left out' : 'no published package here, installs left out');
  }

  // what is merged but not published: a post about an unpublished feature
  // sends people to a version that does not have it
  let version = null;
  if (pkg) {
    try {
      const latest = await fetchJson(`https://registry.npmjs.org/${npmName(pkg)}/latest`);
      version = latest && typeof latest.version === 'string' && /^\d+\.\d+\.\d+/.test(latest.version) ? latest.version : null;
    } catch {
      version = null;
    }
  }
  if (version) {
    let gap = null;
    try {
      gap = (deps.releaseGap || defaultReleaseGap)(workspaceRoot, version);
    } catch {
      gap = null;
    }
    add('release', releaseFact(version, gap), { version, unpublished: gap && Number.isInteger(gap.count) ? gap.count : null });
  } else {
    skip('release', pkg ? 'could not read the published version from npm, left out' : 'no published package here, release left out');
  }

  let team = null;
  try {
    team = (deps.readTeam || readTeam)(workspaceRoot);
  } catch {
    team = null;
  }
  if (team) add('team', `team: ${plural(team.length, 'member')} in atris/team`, { members: team });
  else skip('team', 'no atris/team folder, steps name no member');

  const briefs = (deps.readBriefs || readBriefs)(workspaceRoot);
  if (briefs && briefs.length) add('briefs', `read ${plural(briefs.length, 'research brief')}, newest: ${briefs[0].title}`, { briefs });
  else skip('briefs', 'no research briefs in atris/wiki/briefs, left out');

  const bets = readLedger(ledger, workspaceRoot);
  // every scored bet the model can learn from, then the newest of the rest
  const isScored = b => ['won', 'lost', 'unreadable'].includes(b.status);
  const keep = new Set([...bets.filter(isScored).slice(-10), ...bets.filter(b => !isScored(b)).slice(-10)]);
  const shown = bets.filter(b => keep.has(b)).map(b => ({
    title: b.bet && b.bet.title,
    status: b.status,
    expect: b.bet && b.bet.expect,
    check_date: b.bet && b.bet.check_date,
    ...(b.bet && b.bet.target ? { goal: b.bet.target.goal, metric: b.bet.target.metric } : {}),
    ...(Number.isFinite(b.actual) ? { actual: b.actual } : {}),
    ...(b.why ? { why: b.why } : {}),
  }));
  add('ledger', ledgerLine(bets), { bets: shown });

  // what the project is about now: kept out of the facts list and the event
  // stream, read only when the files are there
  const goal = (deps.readGoal || readGoal)(workspaceRoot);
  if (goal) bundle.sources.goal = goal;
  let missionMap = null;
  try {
    missionMap = (deps.readMissions || defaultReadMissions)(workspaceRoot);
  } catch {
    missionMap = null;
  }
  const open = missionMap ? openMissions(missionMap, today) : [];
  if (open.length) bundle.sources.missions = { list: open };
  const journal = (deps.readJournal || readJournal)(workspaceRoot);
  if (journal) bundle.sources.journal = { ...journal, age: ageDays(journal.day, today) };

  // what the owner said to aim at, from the question cards; kept out of the
  // facts list, so a why_now still has to quote a real number
  const focus = Object.values(readFocus(focusPath(path.dirname(ledger)), workspaceRoot))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (focus.length) {
    bundle.sources.focus = { answers: focus.map(a => ({ key: a.key, ask: a.ask, label: a.label, at: a.at })) };
    emit({ kind: 'source', key: 'focus', line: `the owner said: ${focus.map(a => a.label).join(', ')}` });
  }
  return bundle;
}

function pastBetLine(b) {
  if ((b.status === 'won' || b.status === 'lost') && Number.isFinite(b.actual)) return `- ${b.status}: ${b.title} (goal ${commas(b.goal)}, got ${commas(b.actual)})`;
  if (b.status === 'unreadable') return `- could not score: ${b.title} (${b.why || 'the number could not be read'})`;
  return `- ${b.title} (${b.status}; expected ${b.expect}; check ${b.check_date})`;
}

function bundleText(bundle) {
  const s = bundle.sources;
  const parts = ['## facts', ...bundle.facts.map(f => `- ${f}`)];
  const aged = (at, verb) => {
    const note = staleNote(ageDays(at, bundle.today));
    return at ? ` (${verb} ${at}${note ? `, ${note}` : ''})` : '';
  };
  if (s.goal) {
    parts.push('', '## the goal');
    if (s.goal.horizon) parts.push(`- horizon: ${s.goal.horizon.text}${aged(s.goal.horizon.at, 'picked')}`);
    if (s.goal.goal) parts.push(`- goal: ${s.goal.goal.text}${aged(s.goal.goal.at, 'set')}`);
  }
  if (s.now) parts.push('', `## atris/now.md${s.now.stale ? ` (stale: ${s.now.stale} days old, prefer the fresher sections)` : ''}`, s.now.text);
  if (s.missions) parts.push('', '## open missions', ...s.missions.list.map((m) => {
    const note = staleNote(m.age);
    const tail = [m.owner, note].filter(Boolean).join(', ');
    return `- ${m.title}${tail ? ` (${tail})` : ''}`;
  }));
  if (s.journal) parts.push('', `## latest journal, ${s.journal.day}${staleNote(s.journal.age) ? ` (${staleNote(s.journal.age)})` : ''}`, s.journal.text);
  if (s.landed && s.landed.subjects.length) parts.push('', '## changes merged on master in the last 7 days', ...s.landed.subjects.map(x => `- ${x}`));
  if (s.installs) parts.push('', `## npm installs for ${s.installs.package}`, `last week: ${s.installs.data.last_week}`, `week before: ${s.installs.data.week_before == null ? 'unknown' : s.installs.data.week_before}`, `through: ${s.installs.data.through}`);
  if (s.release) parts.push('', '## release', `published on npm: ${s.release.version}`, `changes on master not in it: ${s.release.unpublished == null ? 'unknown' : s.release.unpublished}`);
  // what each member is on now: their freshest open mission
  const onNow = new Map();
  for (const m of (s.missions ? s.missions.list : [])) if (m.owner && !staleNote(m.age) && !onNow.has(m.owner)) onNow.set(m.owner, m.title);
  if (s.team) parts.push('', '## the team (a team step names one of these as its member)', ...s.team.members.map(m => (onNow.has(m.name) ? `- ${m.name}: ${m.role.replace(/[.\s]+$/, '')}. now on: ${onNow.get(m.name)}` : `- ${m.name}: ${m.role}`)));
  if (s.briefs) for (const b of s.briefs.briefs) parts.push('', `## research brief: ${b.name}`, b.text);
  if (s.ledger && s.ledger.bets.length) parts.push('', '## past bets', ...s.ledger.bets.map(pastBetLine));
  if (s.focus) parts.push('', '## what the owner asked for', ...s.focus.answers.map(a => `- ${a.ask} ${a.label} (said ${String(a.at).slice(0, 10)})`));
  return parts.join('\n');
}

// ---- the prompt ----------------------------------------------------------------------

// The bar a goal has to clear, in words, for the prompt and the reject reason.
function goalBar(metric, m) {
  if (metric === 'installs') {
    return m.best == null ? 'the goal must be above the baseline' : `the best week in the last ${bestSpan(m.weeks)} was ${commas(m.best)}, so the goal must be above ${commas(m.best)}`;
  }
  return `${commas(m.real)} of the ${commas(m.waiting)} waiting jobs have real work, so the goal must be at least ${commas(m.least)} of those landed`;
}

// metrics the team can use but an owner card never picks: they measure plumbing
const TEAM_ONLY_METRICS = new Set(['queue_landed']);

function metricChoices(bundle) {
  const m = bundleMetrics(bundle);
  return Object.keys(m).filter(k => !TEAM_ONLY_METRICS.has(k)).map((k) => {
    return `"${k}" (${METRICS[k].what}; baseline ${m[k].baseline}; ${goalBar(k, m[k])})`;
  });
}

function buildPrompt(bundle, { today, previousTitle = null, reason = null, previousAnswer = null, blocker = null, avoidTitles = [] } = {}) {
  const choices = metricChoices(bundle);
  const lines = [
    'You are the strategist for a small software business. Below is everything we can read about it right now.',
    'Propose exactly ONE bet: the most ambitious move this team can start this week, one that would beat our best installs week of the last 2 months if it works. It must be new, not already written down in these sources. Small safe bets get rejected.',
    'Propose only a business move: customers, revenue, reach, or product people use. Plumbing is the team\'s job and happens without asking: releases, review queues, unmerged or stuck jobs, test speed, and fixing counts are never the bet.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"title": "...", "why_now": "...", "expect": "...", "target": {"metric": "installs", "baseline": 0, "goal": 0}, "check_in_days": 7, "metric_source": "...", "verify": "...", "cost": "...", "steps": [{"text": "...", "detail": "...", "who": "team", "member": "builder", "public": false}]}',
    '',
    'Rules:',
    '- title: one sentence that starts with an action verb and names a concrete deliverable (a page, a command, a post, an email, a demo, a price). Under 120 characters.',
    `- never use these as the whole action: ship it, improve, optimize, leverage, enhance, boost, streamline, grow, scale, explore.`,
    `- why_now: at most two short plain sentences, under ${WHY_MAX} characters in all, that say what is going on and quote at least one exact fact from the facts list below, with its number inside the sentence.`,
    `- expect: one plain sentence, under ${EXPECT_MAX} characters, that follows why_now and says what we expect if it works, with the numbers inside it, for example "if it works, weekly installs pass 2,400 by nov 1, past our best week of 2,319." the card shows why_now and expect together as one short paragraph, so they must read as one.`,
    `- target: the one number this bet moves. metric is one of: ${choices.length ? choices.join('; ') : 'none can be read right now'}. baseline is that number exactly as it is today. goal is the number you expect on the check date, and it must clear the bar named for its metric.`,
    `- check_in_days: a whole number from ${MIN_CHECK_DAYS} to ${CHECK_WINDOW_DAYS}, how many days from today until we read the number. we work out the date.`,
    '- metric_source: where we will read that number, in plain words (npm installs, or jobs landed from the review queue).',
    '- cost: team time and money, for example "about 6 hours of agent time, $0".',
    `- steps: ${MIN_STEPS} to ${MAX_STEPS} steps in order. text is one plain line under ${STEP_MAX} characters, with no file paths, no commands, and no flags. detail (optional, under ${DETAIL_MAX} characters) holds the exact how: files, commands, numbers. who is "team" for work the agents can do alone and "you" for anything the owner must approve. public is true when the step is visible outside the company.`,
    '- any step that publishes, posts, releases, sends, launches, spends money, or cannot be undone must be who "you". at least one step must be who "team".',
    '- member: every team step names the one member of the team below who does it, by the exact name in the team list. pick the member whose role fits the step. a "you" step has no member. the member of the first team step starts the job, and each later step is handed to its member.',
    '- verify: one shell command, run from the repo root, that exits 0 only when the deliverable exists and works, for example a test file (node --test test/name.test.js), a file that must exist and not be empty (test -s path/to/file), or a count read back (test "$(wc -l < file)" -ge 20). never true, echo, exit 0, or only git diff --check, and never ending in || true. this replaces the formatting check, so it is how we know the job is really done.',
    '- check what has to be true first. if the move shows people something that is merged but not published yet (see the release fact), the release is one step for "you" inside the move, never the move itself.',
    '- past bets marked won or lost are real results, read from the same numbers. lean toward moves like the winners and away from the losers, and when you do, say so in why_now.',
    '- write in plain lowercase-friendly words, no hype, no em dashes.',
    '- a section marked stale is old: prefer the fresh ones, and never present a stale line as what is happening now.',
  ];
  lines.push(`- title, why_now, and expect are read by the owner, so they never use these words: ${OWNER_BANNED_WORDS.join(', ')}. say "idea" or a plain verb instead of bet, and say what changes for people, not how we work.`);
  if (bundle.sources && bundle.sources.focus) lines.push('- the bet must serve what the owner asked for (the last section below). when answers pull different ways, the newest wins.');
  // a skeptic named what blocks the last idea: the blocker is the next bet,
  // not one more step on the old idea
  if (blocker) lines.push('', `The last idea ("${clip(blocker.title, 120)}") is blocked by: ${blocker.missing_first.replace(/[.\s]+$/, '')}. Don't patch that idea. Make clearing this blocker the bet, as big as this team can do in the window, with its own target. The blocker stops being a step and becomes the whole move. If the blocker is team plumbing (a release, a merge, a review, a fix to the build or a count), it is never the bet: keep a business move and put the plumbing in as one step.`);
  if (previousTitle) lines.push('', `Make it sharper, more specific, and different from: ${previousTitle}`);
  const avoid = avoidTitles.filter(t => t && t !== previousTitle);
  if (avoid.length) lines.push('', 'It must be a different move from every one of these bets already shown or waiting:', ...avoid.map(t => `- ${t}`));
  if (previousAnswer) lines.push('', 'Your last answer was:', clip(previousAnswer, 4000));
  if (reason) lines.push('', `Your last answer was rejected: ${reason}. Fix that and answer again with strict JSON only.`);
  lines.push('', `Today is ${today}.`, '', bundleText(bundle));
  return lines.join('\n');
}

// ---- the model call --------------------------------------------------------------------

// Subscription only: the model never bills an API key.
function modelEnv(env = process.env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

function claudeArgs(prompt, model = MODEL) {
  return ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--no-session-persistence', '--strict-mcp-config'];
}

// Runs the model in its own process group. On timeout the whole group is
// killed, so nothing it started keeps running. Streams real progress (tokens
// thought, characters written) through onProgress.
function runModel(prompt, { command = { bin: 'claude', args: claudeArgs }, cwd, timeoutMs = MODEL_TIMEOUT_MS, env = process.env, onProgress = () => {}, spawnFn = require('child_process').spawn, kill = process.kill.bind(process) } = {}) {
  return new Promise((resolve) => {
    const args = typeof command.args === 'function' ? command.args(prompt) : [...(command.args || []), prompt];
    let child;
    try {
      child = spawnFn(command.bin, args, { cwd, env: modelEnv(env), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, reason: `could not start the model: ${err.message}` });
      return;
    }
    let buf = '';
    let size = 0;
    let stderr = '';
    let text = '';
    let result = null;
    let thinking = 0;
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);
    const line = (raw) => {
      if (!raw.trim()) return;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        return;
      }
      if (ev.type === 'system' && ev.subtype === 'thinking_tokens' && Number.isFinite(ev.estimated_tokens)) {
        thinking = ev.estimated_tokens;
        onProgress({ thinking, chars: text.length, text });
      } else if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta' && ev.event.delta && ev.event.delta.type === 'text_delta') {
        text += ev.event.delta.text || '';
        onProgress({ thinking, chars: text.length, text });
      } else if (ev.type === 'result') {
        result = ev;
      }
    };
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > OUTPUT_MAX) return;
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    child.on('error', err => finish({ ok: false, reason: `could not start the model: ${err.message}` }));
    child.on('close', (code) => {
      if (buf) line(buf);
      if (timedOut) return finish({ ok: false, reason: `the model took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped`, timed_out: true });
      if (result && result.is_error) return finish({ ok: false, reason: `the model said: ${clip(result.result || result.subtype, 160)}` });
      const answer = result && typeof result.result === 'string' ? result.result : text;
      if (code !== 0 && !answer) return finish({ ok: false, reason: `the model exited with code ${code}${stderr.trim() ? `: ${clip(stderr.trim().split('\n').pop(), 160)}` : ''}` });
      if (!answer.trim()) return finish({ ok: false, reason: 'the model gave an empty answer' });
      return finish({ ok: true, text: answer });
    });
  });
}

// ---- checking a bet -------------------------------------------------------------------

function parseBet(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'the answer was not JSON' };
  try {
    return { bet: JSON.parse(s.slice(start, end + 1)) };
  } catch {
    return { error: 'the answer was not valid JSON' };
  }
}

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'.-]*/g) || [];
}

function normTitle(text) {
  return words(text).join(' ');
}

function titleProblem(title) {
  const t = String(title || '').trim();
  if (t.length < 20) return 'the title is too short to name a deliverable';
  if (t.length > 140) return 'the title is longer than 140 characters';
  if (/[.!?]\s+\S/.test(t)) return 'the title is more than one sentence';
  const w = words(t);
  if (VAGUE_VERBS.includes(w[0])) return `the title's action is the vague verb "${w[0]}"`;
  const concrete = w.filter(x => x.length >= 4 && !STOP_WORDS.has(x) && !VAGUE_NOUNS.has(x) && !VAGUE_VERBS.includes(x) && !/^\d/.test(x));
  if (concrete.length < 3) return 'the title has no concrete deliverable';
  return null;
}

// why_now must quote the bundle: a number that appears in a fact, or four
// words in a row from the sources.
function citesBundle(whyNow, bundle) {
  const nums = s => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => n.replace(/,/g, '')).filter(n => n.length >= 1);
  const factNums = new Set(bundle.facts.flatMap(nums));
  if (nums(whyNow).some(n => factNums.has(n))) return true;
  const src = ` ${words(bundleText(bundle)).join(' ')} `;
  const w = words(whyNow);
  for (let i = 0; i + 4 <= w.length; i += 1) {
    const gram = w.slice(i, i + 4);
    if (gram.every(x => STOP_WORDS.has(x))) continue;
    if (src.includes(` ${gram.join(' ')} `)) return true;
  }
  return false;
}

function stems(word) {
  const w = String(word || '');
  return [w, w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/d$/, ''), w.replace(/ed$/, ''), w.replace(/ing$/, ''), w.replace(/ing$/, 'e')];
}

function ownerOnlyAction(text) {
  const w = words(text);
  const actions = w.filter((x, i) => i === 0 || w[i - 1] === 'and' || w[i - 1] === 'then');
  return actions.some(a => stems(a).some(x => OWNER_ONLY_WORDS.has(x)));
}

// A step line is plain words: no file paths, file names, flags, or commands.
const STEP_CODE = [
  /`/,
  /(^|\s)[\w.~-]*\/[\w./-]+/,
  /\b[\w-]+\.(js|ts|tsx|sh|md|json|py|yml|yaml|txt|html|css|jsonl)\b/i,
  /(^|\s)--?[a-z]/i,
  /\b(npm|npx|git|node|gh|atris)\s+(install|run|publish|test|view|push|commit|merge|tag|log|pr|task|mission|gm|slop|release|init)\b/i,
];

function stepProblem(text) {
  const t = String(text || '').trim();
  if (t.length > STEP_MAX) return `is ${t.length} characters, over the ${STEP_MAX} that fit one line`;
  if (STEP_CODE.some(re => re.test(t))) return 'has a file path or a command in it; put that in detail';
  return null;
}

function sentenceCount(text) {
  return String(text || '').split(/[.!?]+(?:\s+|$)/).filter(x => x.trim()).length;
}

// Two titles are near duplicates when half or more of their real words match.
function contentWords(text) {
  return new Set(words(text).map(w => w.replace(/[.']/g, '')).filter(w => w.length >= 4 && !STOP_WORDS.has(w)));
}

function nearDuplicate(a, b) {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return normTitle(a) === normTitle(b);
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both) >= 0.5;
}

// The target is the bet's number: one we can read again on the check date,
// starting from today's real value, with a goal that says something either
// way: installs above our best week of the last 2 months, or the review queue
// cut to half or less. Each reason states the numbers so the retry can fix them.
function targetProblems(target, bundle, { allowTeamMetrics = false } = {}) {
  const all = bundleMetrics(bundle);
  const m = allowTeamMetrics ? all : Object.fromEntries(Object.entries(all).filter(([k]) => !TEAM_ONLY_METRICS.has(k)));
  const names = Object.keys(m);
  if (target && TEAM_ONLY_METRICS.has(target.metric) && !allowTeamMetrics) return [`target metric ${target.metric} measures team plumbing, not a business move; an owner bet moves ${names.join(' or ') || 'a business number'}`];
  if (!target || typeof target !== 'object' || Array.isArray(target)) return ['target is missing; give {"metric", "baseline", "goal"}'];
  if (!names.length) return ['there is no number we can read here for a target (no npm installs and no task list)'];
  if (!m[target.metric]) return [`target metric must be one we can read here: ${names.join(' or ')}, got ${JSON.stringify(target.metric)}`];
  const metric = target.metric;
  const known = m[metric];
  const real = known.baseline;
  const label = METRICS[metric].now;
  const out = [];
  if (!Number.isFinite(target.baseline)) out.push(`target baseline must be a number: ${label} is ${commas(real)}`);
  else if (target.baseline !== real) out.push(`target baseline ${commas(target.baseline)} does not match the real number: ${label} is ${commas(real)}`);
  if (!Number.isFinite(target.goal)) {
    out.push('target goal must be a number');
  } else if (metric === 'installs') {
    if (known.best !== null && !(target.goal > known.best)) out.push(`target goal ${commas(target.goal)} does not beat our best installs week of the last ${bestSpan(known.weeks)}, ${commas(known.best)}; the goal must be above ${commas(known.best)}`);
    else if (known.best === null && !(target.goal > real)) out.push(`target goal ${commas(target.goal)} must be above the baseline ${commas(real)}`);
  } else if (metric === 'queue_landed') {
    if (known.real === 0) out.push(known.waiting === 0 ? 'nothing is waiting on review, so there is no queue to land; pick another metric' : `none of the ${commas(known.waiting)} waiting jobs has real work behind it, so none can land; pick another metric`);
    else if (target.goal < known.least) out.push(`target goal ${commas(target.goal)} does not land half the waiting jobs with real work: ${commas(known.real)} have real work, so the goal must be at least ${commas(known.least)}`);
    else if (target.goal > known.real) out.push(`target goal ${commas(target.goal)} is more than the ${commas(known.real)} waiting jobs with real work`);
  }
  return out;
}

function validateBet(bet, { bundle, today, previousTitle = null, avoidTitles = [], allowTeamMetrics = false } = {}) {
  const reasons = [];
  // format-only reasons: a field too long or with too many sentences. Only
  // these can be fixed by a trim turn that changes nothing else.
  const format = new Set();
  const fmt = (r) => { reasons.push(r); format.add(r); };
  if (!bet || typeof bet !== 'object' || Array.isArray(bet)) return { ok: false, reasons: ['the answer was not one JSON object'], formatOnly: false };
  const str = k => (typeof bet[k] === 'string' ? bet[k].trim() : '');
  for (const k of ['title', 'why_now', 'expect', 'metric_source', 'cost']) {
    if (!str(k)) reasons.push(`${k} is missing`);
  }
  for (const k of ['title', 'why_now', 'expect']) {
    const word = ownerWord(str(k));
    if (word) fmt(`${k} uses "${word}", a word the owner never reads; say it plainly`);
  }
  if (str('title')) {
    const p = titleProblem(str('title'));
    if (p && (p === 'the title is longer than 140 characters' || p === 'the title is more than one sentence')) fmt(p);
    else if (p) reasons.push(p);
    if (previousTitle && normTitle(str('title')) === normTitle(previousTitle)) reasons.push('the title repeats the previous bet');
    else {
      const close = [previousTitle, ...avoidTitles].filter(Boolean).find(t => nearDuplicate(str('title'), t));
      if (close) reasons.push(`the title is too close to a bet already shown or waiting: "${clip(close, 80)}"`);
    }
  }
  if (str('why_now') && bundle && !citesBundle(str('why_now'), bundle)) reasons.push('why_now does not quote a fact from the sources');
  if (str('why_now').length > WHY_MAX) fmt(`why_now is ${str('why_now').length} characters, over ${WHY_MAX}`);
  if (sentenceCount(str('why_now')) > 2) fmt('why_now is more than two sentences');
  if (str('expect') && !(/\d/.test(str('expect')) && /[a-z]{3,}/i.test(str('expect')))) reasons.push('expect needs a number and a metric');
  if (str('expect').length > EXPECT_MAX) fmt(`expect is ${str('expect').length} characters, over ${EXPECT_MAX}`);
  if (sentenceCount(str('expect')) > 1) fmt('expect is more than one sentence');
  // the model picks a number of days; the date is ours, so a time zone or a
  // clock change can never push it out of the window. Out of range is a
  // reject with the reason, never a clamp.
  if (bet.check_in_days === undefined || bet.check_in_days === null) reasons.push('check_in_days is missing');
  else if (!Number.isInteger(bet.check_in_days) || bet.check_in_days < MIN_CHECK_DAYS || bet.check_in_days > CHECK_WINDOW_DAYS) {
    reasons.push(`check_in_days must be a whole number from ${MIN_CHECK_DAYS} to ${CHECK_WINDOW_DAYS}, got ${JSON.stringify(bet.check_in_days)}`);
  }
  if (bundle) reasons.push(...targetProblems(bet.target, bundle, { allowTeamMetrics }));
  if (str('metric_source') && !METRIC_SOURCES.some(k => str('metric_source').toLowerCase().includes(k))) reasons.push('metric_source is not a source we can read');
  if (str('cost').length > 200) fmt('cost is longer than 200 characters');
  const vp = verifyProblem(bet.verify);
  if (vp) reasons.push(vp);
  const team = bundle && bundle.sources && bundle.sources.team ? new Set(bundle.sources.team.members.map(m => m.name)) : null;
  const steps = Array.isArray(bet.steps) ? bet.steps : null;
  if (!steps) reasons.push('steps is missing');
  else if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) reasons.push(`steps must have ${MIN_STEPS} to ${MAX_STEPS} items`);
  else {
    steps.forEach((s, i) => {
      const n = i + 1;
      if (!s || typeof s.text !== 'string' || !s.text.trim()) reasons.push(`step ${n} has no text`);
      else {
        const problem = stepProblem(s.text);
        if (problem && problem.startsWith('is ')) fmt(`step ${n} ${problem}`);
        else if (problem) reasons.push(`step ${n} ${problem}`);
      }
      if (s && s.detail != null && typeof s.detail === 'string' && s.detail.length > DETAIL_MAX) fmt(`step ${n} detail must be text under ${DETAIL_MAX} characters`);
      else if (s && s.detail != null && typeof s.detail !== 'string') reasons.push(`step ${n} detail must be text under ${DETAIL_MAX} characters`);
      if (!s || (s.who !== 'team' && s.who !== 'you')) reasons.push(`step ${n} who must be "team" or "you"`);
      if (!s || typeof s.public !== 'boolean') reasons.push(`step ${n} public must be true or false`);
      if (s && s.who === 'team' && (s.public === true || ownerOnlyAction(s.text))) reasons.push(`step ${n} reaches the outside world or cannot be undone, so it must be who "you"`);
      if (team && s && s.who === 'team') {
        if (typeof s.member !== 'string' || !s.member.trim()) reasons.push(`step ${n} has no member; name the team member who does it`);
        else if (!team.has(s.member.trim())) reasons.push(`step ${n} member "${clip(s.member, 40)}" is not on the team; use a name from the team list`);
      }
    });
    if (!steps.some(s => s && s.who === 'team')) reasons.push('no step is for the team');
  }
  return { ok: reasons.length === 0, reasons, formatOnly: reasons.length > 0 && reasons.every(r => format.has(r)) };
}

// The owner's local calendar date n days after today (YYYY-MM-DD), counted
// in calendar days so a clock change never shifts it.
function addDays(today, n) {
  const [y, m, d] = String(today).split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12, 0, 0).getTime());
}

// "goal 2,400, best week in 2 months 2,319" or "goal 3 of the 6 jobs with work landed"
function goalLine(target, known) {
  if (target.metric === 'queue_landed') return `goal ${commas(target.goal)} of the ${commas(target.job_ids.length)} jobs with work landed`;
  if (known && known.best !== null) return `goal ${commas(target.goal)}, best week in ${bestSpan(known.weeks)} ${commas(known.best)}`;
  return `goal ${commas(target.goal)}, ${commas(target.baseline)} last week`;
}

function cleanBet(bet, today, bundle) {
  const target = { metric: bet.target.metric, baseline: bet.target.baseline, goal: bet.target.goal };
  // the jobs waiting right now, kept with the bet: only these can count
  if (target.metric === 'queue_landed') target.job_ids = [...bundleMetrics(bundle).queue_landed.ids];
  return {
    title: bet.title.trim(),
    why_now: bet.why_now.trim(),
    expect: bet.expect.trim(),
    target,
    // the one short line under expect on the card
    goal_line: goalLine(target, bundleMetrics(bundle)[target.metric]),
    check_in_days: bet.check_in_days,
    check_date: addDays(today, bet.check_in_days),
    metric_source: bet.metric_source.trim(),
    cost: bet.cost.trim(),
    verify: String(bet.verify).trim(),
    steps: bet.steps.map(s => ({ text: s.text.trim(), ...(s.detail && s.detail.trim() ? { detail: s.detail.trim() } : {}), who: s.who, ...(s.who === 'team' && typeof s.member === 'string' && s.member.trim() ? { member: s.member.trim() } : {}), public: s.public })),
  };
}

// ---- one generation ----------------------------------------------------------------------

// Reads the sources, asks the model, checks the answer with plain rules, then
// asks a skeptic model whether it makes sense; either can turn it down, and
// there is one retry with the reasons. Resolves { ok, bet, bundle } or
// { ok: false, reason }.
// Every model attempt, writer and skeptic (the kind field), is kept (raw
// answer, parse result, reasons, timing), so
// a failed live run can be read back afterwards.
function attemptsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'gm-bet-attempts.jsonl');
}

function saveAttempt(file, row) {
  if (!file) return;
  try {
    appendLedger(file, row);
  } catch {
    // the attempts log is a receipt, never a reason to fail the bet
  }
}

function wordCount(text) {
  return (String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
}

// ---- the skeptic: a second model judges whether the bet makes sense ----------------

// The writer's code checks are binary (a number, a date, a step that posts).
// Whether the move actually moves its number, what has to be true first, and
// whether a sharp founder would laugh at it is judgment, so a separate model
// call owns it. It gets the bet and the same facts, never the writer's prompt.
function buildSkepticPrompt(bet, bundle, { today } = {}) {
  return [
    'You are a skeptical cofounder. Someone else proposed the bet below for this week. Your job is to catch it if it does not make sense, before the team spends a week on it.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"verdict": "pass", "missing_first": "...", "moves_metric": true, "reason": "..."}',
    '',
    'Check these against the facts below:',
    '- moves_metric: if every step is done, would it actually move the target number (target.metric: installs are read over the 7 days that end on the check date; queue_landed counts only the waiting jobs with real work when the bet was made (target.job_ids; placeholders with no check are left out) that land, accepted or merged, by the check date, and a closed, dropped, or parked job counts zero) from the baseline to the goal? a post does not move installs if the thing it shows is not installable yet, and work nobody outside sees does not move installs at all.',
    '- missing_first: what must be true first and is not, and is not already a step: an unpublished feature (see the release fact), a page or command that does not exist, no audience that would see it. write "nothing" when nothing is missing.',
    '- would a sharp founder reading this find it obviously wrong, padded, or a waste of the week?',
    '- is the deliverable internal plumbing (a release, a review queue, merging or unsticking jobs, test speed, fixing a count or a dashboard)? that is the team\'s job and never an owner bet, so fail it. plumbing as one step inside a business move is fine.',
    'verdict is "pass" only when moves_metric is true, nothing is missing that the steps do not cover, it is not obviously wrong, and it is not plumbing. otherwise "fail".',
    'reason: one or two plain sentences under 240 characters. if the missing piece is something the team or the owner could do, name the step to add.',
    '',
    `Today is ${today}.`,
    '',
    '## the bet',
    JSON.stringify(bet, null, 2),
    '',
    bundleText(bundle),
  ].join('\n');
}

// Shape only: a verdict with the four fields. No reading of the reason.
function parseVerdict(text) {
  const parsed = parseBet(text);
  if (parsed.error) return { error: `the skeptic's answer: ${parsed.error}` };
  const v = parsed.bet;
  if (!v || (v.verdict !== 'pass' && v.verdict !== 'fail')) return { error: 'the skeptic gave no pass or fail verdict' };
  if (typeof v.moves_metric !== 'boolean') return { error: 'the skeptic did not say whether it moves the number' };
  if (typeof v.reason !== 'string' || !v.reason.trim()) return { error: 'the skeptic gave no reason' };
  return {
    verdict: {
      verdict: v.verdict,
      moves_metric: v.moves_metric,
      missing_first: typeof v.missing_first === 'string' ? clip(v.missing_first, 240) : '',
      reason: clip(v.reason, 400),
    },
  };
}

function skepticCommand() {
  return { bin: 'claude', args: p => claudeArgs(p, SKEPTIC_MODEL) };
}

// A pass needs both: the verdict and the skeptic's own yes on moving the number.
function skepticPassed(v) {
  return v.verdict === 'pass' && v.moves_metric === true;
}

// What the skeptic said must be true first, or null when it said nothing is.
function blockerOf(v) {
  const m = String((v && v.missing_first) || '').trim();
  return m && !/^(nothing|none|n\/a)\.?$/i.test(m) ? m : null;
}

function skepticReason(v) {
  const missing = blockerOf(v) ? ` missing first: ${v.missing_first.replace(/[.\s]+$/, '')}.` : '';
  const moves = v.moves_metric ? '' : ' it would not move the target number.';
  return `a skeptic turned it down: ${v.reason.replace(/[.\s]+$/, '')}.${moves}${missing} if the missing piece is something we can do, add it as a step (a release, or anything public, is a step for "you")`;
}

// A free repair turn for an answer that broke only length or sentence limits:
// the reasons and the last answer go back, and only those fields may change.
// The text is never shortened in code.
function buildTrimPrompt(previousAnswer, reasons) {
  const worded = reasons.some(r => r.includes('a word the owner never reads'));
  return [
    worded ? 'Your last answer below broke only these wording or length limits:' : 'Your last answer below broke only these length or sentence limits:',
    ...reasons.map(r => `- ${r}`),
    '',
    worded
      ? 'Fix only those fields: shorten the long ones, and swap each word named for a plain one. Change nothing else: the same idea, the same target, the same check_in_days, the same steps in the same order with the same who and public. Keep the plain words, no em dashes.'
      : 'Shorten only those fields so they fit. Change nothing else: the same idea, the same target, the same check_in_days, the same steps in the same order with the same who and public. Keep the plain words, no em dashes.',
    'Answer with the whole JSON object again, strict JSON only, no prose and no code fence.',
    '',
    'Your last answer:',
    clip(previousAnswer, 4000),
  ].join('\n');
}

// What a trim may not touch. Binary: the same values, or not.
function trimChangedMore(before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!after || typeof after !== 'object') return true;
  if (!same(before.target, after.target) || before.check_in_days !== after.check_in_days) return true;
  const a = Array.isArray(before.steps) ? before.steps : [];
  const b = Array.isArray(after.steps) ? after.steps : [];
  return a.length !== b.length || a.some((s, i) => !b[i] || s.who !== b[i].who || s.public !== b[i].public);
}

async function generateBet({ workspaceRoot, today, previousTitle = null, avoidTitles = [], emit = () => {}, onBundle = () => {}, deps = {}, ledgerFile, attemptsFile, allowTeamMetrics = false } = {}) {
  const bundle = await readBundle(workspaceRoot, { deps, emit, ledgerFile, today });
  // the desk builds its question cards from these facts while the model works
  try { onBundle(bundle); } catch { /* the desk's copy is a convenience */ }
  const run = deps.runModel || runModel;
  // tests pass runSkeptic; a stubbed runModel without one is also used for the
  // skeptic, so a test can never reach the real model by accident
  const judge = deps.runSkeptic || deps.runModel || ((prompt, opts) => runModel(prompt, { ...opts, command: skepticCommand() }));
  const clock = deps.now || Date.now;
  // How each try is asked. first: a fresh bet. patch: fix the last answer
  // against the reasons (code rejects, or a skeptic fail that names no
  // blocker). blocker: the skeptic named what must be true first, so the
  // next bet is clearing that blocker, a new move with its own target.
  // trim: inside a try, a free turn that only shortens fields over a limit.
  let strategy = 'first';
  let reason = null;
  let previousAnswer = null;
  let blocker = null;
  const blocked = [];
  const MODEL_LINES = { first: 'asking the model for one bet', patch: 'asking again with the reasons', blocker: 'asking again: clearing the blocker is the new bet', trim: 'asking for the same bet, shorter' };

  // one model call and its code check, saved to the attempts log
  async function ask(prompt, attempt, how, avoid) {
    let lastSaid = 0;
    const started = clock();
    const answer = await run(prompt, {
      cwd: workspaceRoot,
      onProgress: ({ text = '' }) => {
        const at = clock();
        if (at - lastSaid < 1200) return;
        lastSaid = at;
        const words = wordCount(text);
        emit({ kind: 'thinking', line: words ? `thinking... ${commas(words)} words written` : 'thinking...', n: words });
      },
    });
    const base = { at: new Date(clock()).toISOString(), workspace: workspaceRoot, today, attempt, strategy: how, ...(how === 'blocker' ? { blocker: blocker.missing_first } : {}), previous_title: previousTitle, avoid_titles: avoid.length, ms: clock() - started };
    if (!answer.ok) {
      saveAttempt(attemptsFile, { ...base, kind: 'writer', model_ok: false, raw: null, parse: null, passed: false, reasons: [answer.reason] });
      return { failed: answer.reason, base };
    }
    const parsed = parseBet(answer.text);
    const check = parsed.error ? { ok: false, reasons: [parsed.error], formatOnly: false } : validateBet(parsed.bet, { bundle, today, previousTitle, avoidTitles: avoid, allowTeamMetrics });
    return { parsed, check, base, raw: answer.text };
  }
  const save = (r, extra = {}) => saveAttempt(attemptsFile, { ...r.base, kind: 'writer', model_ok: true, raw: String(r.raw).slice(0, 20000), parse: r.parsed.error || 'ok', passed: r.check.ok, reasons: r.check.reasons, ...extra });

  for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
    emit({ kind: 'model', line: MODEL_LINES[strategy] });
    // a blocked idea is not shown again as a patch
    const avoid = [...avoidTitles, ...blocked];
    const prompt = strategy === 'blocker'
      ? buildPrompt(bundle, { today, previousTitle, blocker, avoidTitles: avoid })
      : buildPrompt(bundle, { today, previousTitle, reason, previousAnswer, avoidTitles: avoid });
    let r = await ask(prompt, attempt, strategy, avoid);
    if (r.failed) return { ok: false, reason: r.failed, bundle };
    save(r);

    // only length or sentence limits broken: one free trim turn, same try
    if (!r.check.ok && r.check.formatOnly) {
      emit({ kind: 'model', line: MODEL_LINES.trim });
      const original = r.parsed.bet;
      const trimmed = await ask(buildTrimPrompt(JSON.stringify(original), r.check.reasons), attempt, 'trim', avoid);
      if (trimmed.failed) return { ok: false, reason: trimmed.failed, bundle };
      if (!trimmed.parsed.error && trimChangedMore(original, trimmed.parsed.bet)) {
        trimmed.check = { ok: false, reasons: ['the trim changed more than the fields over a limit'], formatOnly: false };
      }
      save(trimmed);
      r = trimmed;
    }

    previousAnswer = r.parsed.error ? null : JSON.stringify(r.parsed.bet);
    if (!r.check.ok) {
      strategy = 'patch';
      reason = r.check.reasons.slice(0, 4).join('; ');
      emit({ kind: 'reject', line: `${ORDINALS[attempt - 1]} answer turned down: ${reason}` });
      continue;
    }

    // the code checks passed; now a second model judges whether it makes sense
    const bet = cleanBet(r.parsed.bet, today, bundle);
    emit({ kind: 'skeptic', line: 'a second model is checking that it makes sense' });
    const judgedAt = clock();
    const said = await judge(buildSkepticPrompt(bet, bundle, { today }), { cwd: workspaceRoot, onProgress: () => {} });
    const skepticBase = { ...r.base, kind: 'skeptic', at: new Date(clock()).toISOString(), ms: clock() - judgedAt, title: bet.title };
    if (!said.ok) {
      saveAttempt(attemptsFile, { ...skepticBase, model_ok: false, raw: null, parse: null, passed: false, reasons: [said.reason] });
      return { ok: false, reason: `the skeptic could not check the bet: ${said.reason}`, bundle };
    }
    const judged = parseVerdict(said.text);
    const passed = !judged.error && skepticPassed(judged.verdict);
    saveAttempt(attemptsFile, {
      ...skepticBase,
      model_ok: true,
      raw: String(said.text).slice(0, 20000),
      parse: judged.error || 'ok',
      verdict: judged.verdict || null,
      passed,
      reasons: judged.error ? [judged.error] : (passed ? [] : [judged.verdict.reason]),
    });
    if (judged.error) return { ok: false, reason: `the skeptic could not check the bet: ${judged.error}`, bundle };
    if (passed) {
      emit({ kind: 'check', line: 'checked the bet: every rule passed and the skeptic agreed' });
      return { ok: true, bet: { ...bet, skeptic: judged.verdict }, bundle, attempts: attempt };
    }
    reason = skepticReason(judged.verdict);
    const missing = blockerOf(judged.verdict);
    if (missing) {
      strategy = 'blocker';
      blocker = { title: bet.title, missing_first: missing };
      blocked.push(bet.title);
    } else {
      strategy = 'patch';
    }
    emit({ kind: 'reject', line: `${ORDINALS[attempt - 1]} answer turned down: ${reason}` });
  }
  return { ok: false, reason: `the model's answer was turned down ${WRITER_ATTEMPTS} times (${reason})`, bundle };
}

// ---- do it: the mission -------------------------------------------------------------------

// Which member owns the work, by what the bet asks for. Code-shaped bets go
// to the builder, launch-shaped bets to the launcher, anything else to the
// mission lead. Only members that exist in this workspace are picked.
function pickOwner(bet, workspaceRoot) {
  const text = `${bet.title} ${bet.steps.map(s => s.text).join(' ')}`.toLowerCase();
  const exists = name => fs.existsSync(path.join(workspaceRoot, 'atris', 'team', name, 'MEMBER.md'));
  const launch = /\b(post|posts|thread|tweet|launch|announce|newsletter|video|landing page|blog|changelog|demo|email|outreach|pricing page)\b/;
  const code = /\b(command|cli|endpoint|api|test|script|flag|feature|bug|refactor|build|code|install|onboarding|setup|integration)\b/;
  const title = bet.title.toLowerCase();
  const asCode = { owner: 'builder', lane: 'code' };
  const asLaunch = { owner: 'launcher', lane: 'launch' };
  // the lane: the title decides first, then the steps
  let pick = { owner: 'mission-lead', lane: 'workspace' };
  const lanes = [[code, asCode], [launch, asLaunch]];
  const hit = lanes.find(([re, p]) => re.test(title) && exists(p.owner)) || lanes.find(([re, p]) => re.test(text) && exists(p.owner));
  if (hit) pick = hit[1];
  // the owner: the member of the first team step, when that member is real here
  const first = bet.steps.find(st => st.who === 'team' && st.member && exists(st.member));
  return first ? { owner: first.member, lane: pick.lane } : pick;
}

// The members after the owner, in step order, each named once.
function handoffChain(bet, owner) {
  const chain = [];
  let last = owner;
  for (const st of bet.steps) {
    if (st.who !== 'team' || !st.member || st.member === last) continue;
    chain.push({ from: last, to: st.member, step: st.text });
    last = st.member;
  }
  return chain;
}

// a handoff summary starts with this tag, so the desk can tell who has the job now
function handoffTag(betId) {
  return `[${betId}]`;
}

const YES_RULE = 'rule: a step marked "your yes" is locked until the owner says yes: publishing, pushing tags, releases, posting, sending, and merging to master are held by the guard on your PATH. when you reach that step, run the command once; it is held, and the owner gets a yes card. do the other steps, wait for the ping from gm-phone that says yes, then run it again. never work around the guard.';

// Missions have one owner. A step for another member is passed with the real
// member handoff (atris member handoff <from> <to> "..."), which records the
// baton and queues that member's next push; the objective names each one.
function missionObjective(bet, { owner = null, betId = null } = {}) {
  const steps = bet.steps.map((s, i) => `${i + 1}. [${s.who === 'you' ? 'your yes' : (s.member || 'team')}] ${s.text}${s.detail ? ` (${s.detail})` : ''}`);
  const chain = owner ? handoffChain(bet, owner) : [];
  const handoffs = chain.length
    ? `handoffs: you are ${owner}; do your steps, then pass each step that belongs to another member with ${chain.map(h => `atris member handoff ${h.from} ${h.to} "${betId ? `${handoffTag(betId)} ` : ''}${h.step}"`).join(', then ')}.`
    : null;
  return [
    `${bet.title.replace(/[.\s]+$/, '')}.`,
    `why now: ${bet.why_now}`,
    `we expect ${bet.expect}, read from ${bet.metric_source} on ${bet.check_date}.`,
    `steps: ${steps.join(' ')}`,
    handoffs,
    bet.verify ? `done means this check passes: ${bet.verify}` : null,
    YES_RULE,
  ].filter(Boolean).join(' ');
}

// How long a job may run: the hours its idea says it costs, plus a quarter
// for slack, from 1 hour to a day, at 12 rounds of work an hour. An idea
// that names no hours gets the deep tier's 3. Passed as --max-wall and
// --max-ticks, so a long job is never cut off at the one-hour tier, with
// --stop-when-done, so the hours are a ceiling and a job done early stops.
const JOB_SLACK = 1.25;
const JOB_MIN_HOURS = 1;
const JOB_MAX_HOURS = 24;
const JOB_DEFAULT_HOURS = 3;
const TICKS_PER_HOUR = 12;

function costHours(cost) {
  const t = String(cost || '').toLowerCase();
  const range = /(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/.exec(t);
  if (range) return Number(range[2]);
  const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/.exec(t);
  if (hours) return Number(hours[1]);
  const minutes = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/.exec(t);
  if (minutes) return Number(minutes[1]) / 60;
  return null;
}

function jobTime(bet) {
  const hours = costHours(bet && bet.cost);
  const wall = hours ? Math.min(JOB_MAX_HOURS, Math.max(JOB_MIN_HOURS, hours * JOB_SLACK)) : JOB_DEFAULT_HOURS;
  return { seconds: Math.round(wall * 3600), ticks: Math.ceil(wall * TICKS_PER_HOUR) };
}

const MISSION_VERIFY = 'git diff --check';
const MISSION_STOP = 'every team step is done with proof, and every your-yes step was asked, not done';

// The bet's own verify is the check; a bet made before verify existed keeps
// the old formatting check.
function missionStartArgs(bet, { owner, lane }, betId = null) {
  // the owner steps are sealed into the mission record at start
  const seal = require('./yes-lock').sealFor(bet.steps);
  const time = jobTime(bet);
  return ['mission', 'start', missionObjective(bet, { owner, betId }), '--owner', owner, '--runner', 'claude', '--lane', lane, '--verify', bet.verify || MISSION_VERIFY, '--stop', MISSION_STOP, '--max-wall', String(time.seconds), '--max-ticks', String(time.ticks), '--stop-when-done', ...(seal.length ? ['--yes-lock', JSON.stringify(seal)] : []), '--json'];
}

// the run gets the same time as the start, so the detached driver never
// falls back to the one-hour default
function missionRunArgs(missionId, bet) {
  const time = jobTime(bet);
  return ['mission', 'run', missionId, '--max-wall', String(time.seconds), '--max-ticks', String(time.ticks), '--stop-when-done', '--detach', '--json'];
}

function yesPingArgs(missionId, step) {
  return ['mission', 'ping', missionId, `the owner said yes to this step: ${step.text}. you may do it now.`, '--from', 'gm-phone'];
}

function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(s.slice(start));
  } catch {
    const id = /"mission_id"\s*:\s*"([^"]+)"/.exec(s) || /"id"\s*:\s*"(mission-[^"]+)"/.exec(s);
    return id ? { mission_id: id[1] } : null;
  }
}

// Runs one atris command and captures its output (the mission runner tests stub).
function makeCliRunner({ cliPath, cwd, env = process.env, timeoutMs = 60000 }) {
  const { execFile } = require('child_process');
  return args => new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { cwd, env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, timeout: timeoutMs, maxBuffer: OUTPUT_MAX }, (err, stdout, stderr) => {
      const code = err ? (Number.isInteger(err.code) ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// ---- jobs in flight: what the started bets are doing now ---------------------------

const JOB_POLL_MS = 25000;
const OPEN_MISSION = new Set(['planning', 'running', 'ready', 'paused', 'blocked']);
// an open mission that has not moved in this long is not working
const STALL_MS = 2 * 60 * 60 * 1000;

// Every mission in this workspace, read-only, through the same reader the
// mission command uses (it only reads .atris/state/missions.jsonl).
function defaultReadMissions(workspaceRoot) {
  return require(path.join(__dirname, '..', 'commands', 'mission.js')).loadMissionMap(workspaceRoot);
}

// A mission's last receipt, read-only. Null when there is none.
function defaultReadReceipt(mission, workspaceRoot) {
  if (!mission || !mission.receipt_path) return null;
  const file = path.isAbsolute(mission.receipt_path) ? mission.receipt_path : path.join(mission.worktree_root || workspaceRoot, mission.receipt_path);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// "14 hours", "3 days": how long a stalled job has been still
function agoWords(ms) {
  const h = Math.max(1, Math.round(ms / 3600000));
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

// "10 minutes", "2 hours", "3 days": a plain span of time
function spanWords(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(h / 24)} days`;
}

// "about 4 hours left", "about 20 minutes left"
function leftWords(ms) {
  const hours = ms / 3600000;
  if (hours >= 1) { const h = Math.round(hours); return `about ${h} ${h === 1 ? 'hour' : 'hours'} left`; }
  return `about ${Math.max(5, Math.round(ms / 300000) * 5)} minutes left`;
}

// a job whose run hit its wall or its last round, as the mission records it
const OUT_OF_TIME = /wall-exceeded|max-ticks-reached/;

function ageLabel(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'just started';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// One started bet and its mission, as the deck sees it:
//   working  the mission is open, asks nothing of the owner, and moved in the last 2 hours
//   yes      the mission has open asks for the owner (one card per ask)
//   done     the mission finished (complete) or halted (stopped), or it is
//            open but has not moved in over 2 hours (stalled, a halt)
//   gone     no such mission here (it is not counted as working)
// done carries what changed, the proof, and the check, only as the receipt
// says them; with no receipt it says so.
function jobState(row, mission, receipt, nowMs) {
  const title = (row.bet && row.bet.title) || row.id;
  if (!mission) return { kind: 'gone', bet_id: row.id, title };
  const owner = mission.owner || row.owner || 'the team';
  const since = Date.parse(mission.created_at || '') || null;
  const asks = (Array.isArray(mission.human_asks) ? mission.human_asks : [])
    .map((ask, index) => ({ index, text: String(typeof ask === 'string' ? ask : (ask && ask.text) || '').trim(), answered: Boolean(ask && typeof ask === 'object' && ask.answered_at) }))
    .filter(a => a.text && !a.answered);
  const status = String(mission.status || '');
  const outOfTime = OUT_OF_TIME.test([mission.last_tick_reason, mission.pause_reason, mission.stop_reason].join(' '));
  // a round that left a receipt made progress
  const progress = Boolean(mission.receipt_path);
  if (status === 'complete' || status === 'stopped') {
    const result = receipt && receipt.result && typeof receipt.result === 'object' ? receipt.result : null;
    const landing = result && result.landing && typeof result.landing === 'object' ? result.landing : null;
    const checked = result && typeof result.passed === 'boolean' ? (result.passed ? 'passed' : 'failed') : 'none';
    const stopped = status === 'stopped';
    const changed = landing && landing.changed ? clip(landing.changed, 160) : null;
    return {
      kind: 'done',
      bet_id: row.id,
      mission_id: mission.id,
      title,
      owner,
      halted: stopped,
      stop_reason: stopped && mission.stop_reason ? clip(mission.stop_reason, 140) : null,
      changed,
      proof: receipt ? (mission.receipt_path || null) : null,
      checked,
      // a check that failed, or a halt nothing proved, goes back to the team on its own
      failed: checked === 'failed' || (stopped && checked !== 'passed'),
      out_of_time: stopped && outOfTime,
      progress,
    };
  }
  const base = { bet_id: row.id, mission_id: mission.id, title, owner, since, running_for: since ? ageLabel(nowMs - since) : null, status };
  if (asks.length) return { ...base, kind: 'yes', asks };
  if (!OPEN_MISSION.has(status)) return { ...base, kind: 'gone' };
  // paused because its time or its rounds ran out: it goes on now, no two-hour wait
  if (status === 'paused' && OUT_OF_TIME.test(String(mission.pause_reason || ''))) {
    return { kind: 'done', bet_id: row.id, mission_id: mission.id, title, owner, halted: true, stop_reason: 'it ran out of time', changed: null, proof: mission.receipt_path || null, checked: 'none', failed: true, out_of_time: true, progress };
  }
  // the newest of its last tick and its last update is when it last moved
  const moved = Math.max(...[mission.last_tick_at, mission.updated_at, mission.created_at].map(t => Date.parse(t || '') || 0));
  if (moved && nowMs - moved > STALL_MS) {
    return {
      kind: 'done',
      bet_id: row.id,
      mission_id: mission.id,
      title,
      owner,
      halted: true,
      stalled: true,
      stop_reason: `stopped moving ${agoWords(nowMs - moved)} ago, nothing finished`,
      changed: null,
      // the last tick's receipt, when there is one; a stalled job never reached its final check
      proof: mission.receipt_path || null,
      checked: 'none',
      failed: true,
      out_of_time: outOfTime,
      progress,
    };
  }
  const wall = Number(mission.max_wall_seconds) || Number(mission.budget_contract && mission.budget_contract.requested_seconds) || 0;
  const leftMs = wall && since ? since + wall * 1000 - nowMs : 0;
  return { ...base, kind: 'working', ...(leftMs > 0 ? { left: leftWords(leftMs) } : {}) };
}

// Who reviews finished work: the lead of the roster's review job (atris
// engine roster), read from saved state.
function defaultReviewer(workspaceRoot) {
  const team = require('./engine-registry').resolveJobTeam('review', workspaceRoot);
  const lead = team && team.lead;
  return (lead && (lead.engine || lead.name)) || (typeof lead === 'string' ? lead : null) || null;
}

const REVIEW_TRIES = 3;
const REVIEW_TIMEOUT_S = 900;

// The reviewer reads the repo (engine ask is read-only) and says pass or fail.
function reviewPrompt(bet, job) {
  const steps = (bet && Array.isArray(bet.steps) ? bet.steps : []).map((st, i) => `${i + 1}. [${st.who === 'you' ? 'owner' : (st.member || 'team')}] ${st.text}`).join(' ');
  return [
    'You are reviewing finished work before it counts as done. You can read this repo; you cannot change anything.',
    `The bet: ${(bet && bet.title) || job.title}.`,
    steps ? `Its steps: ${steps}` : null,
    bet && bet.verify ? `The check that had to pass: ${bet.verify}` : null,
    `What the worker says changed: ${job.changed || 'it left no receipt'}.`,
    `The check result: ${job.checked === 'passed' ? 'passed' : (job.checked === 'failed' ? 'failed' : 'no check ran')}.`,
    'Look at the repo yourself. Is the deliverable really there, and does it do what the bet says? Owner-only steps (publish, post, release) are not expected to be done.',
    'Answer with strict JSON only, no prose and no code fence: {"verdict": "pass", "reason": "one or two plain sentences"} or {"verdict": "fail", "reason": "..."}',
  ].filter(Boolean).join('\n');
}

// The reviewer's answer out of the engine ask receipt; null when there is none.
function reviewVerdict(stdout) {
  const receipt = parseJsonOut(stdout);
  const answer = receipt && Array.isArray(receipt.answers) ? receipt.answers.find(a => a && a.ok && a.stdout) : null;
  if (!answer) return null;
  const parsed = parseBet(answer.stdout);
  const v = parsed.bet;
  if (!v || (v.verdict !== 'pass' && v.verdict !== 'fail') || typeof v.reason !== 'string') return null;
  return { verdict: v.verdict, reason: clip(v.reason, 240) };
}

// The member who has a job right now: the newest handoff tagged with its bet,
// else the mission's owner.
function defaultReadHandoffs(workspaceRoot) {
  try {
    return fs.readFileSync(path.join(workspaceRoot, '.atris', 'state', 'member-handoffs.jsonl'), 'utf8')
      .split('\n').filter(l => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function currentMember(betId, owner, handoffs) {
  const tag = handoffTag(betId);
  const hits = handoffs.filter(h => h && typeof h.summary === 'string' && h.summary.includes(tag) && h.to);
  return hits.length ? hits[hits.length - 1].to : owner;
}

// a line that ends like a sentence
function sentence(text) {
  const t = String(text || '').trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
}

// One short line of why for a choice: the idea's expected result, without
// "if it works", ending at the first comma after about 40 characters, so it
// is a whole clause and never cut mid word.
function choiceWhy(expect) {
  const first = String(expect || '').trim().split(/\.\s/)[0].replace(/^if it works,\s*/i, '').replace(/[.\s]+$/, '');
  const cut = first.indexOf(', ', 40);
  return sentence(cut > 0 ? first.slice(0, cut) : clip(first, 110));
}

// A business move, not plumbing: its target is a number we can read and
// not one that only measures the team.
function isBusinessMove(bet) {
  const metric = bet && bet.target && bet.target.metric;
  return Boolean(metric && METRICS[metric] && !TEAM_ONLY_METRICS.has(metric));
}

// What went wrong on the last run, in words for the team's next mission.
function failWhy(row) {
  if (row.mission_out_of_time) return 'ran out of time before its check passed; pick up where it left off';
  if (row.mission_stalled) return row.mission_stop_reason || 'stopped moving, nothing finished';
  if (row.mission_halted) return `halted: ${row.mission_stop_reason || 'it stopped before it finished'}`;
  const r = row.review;
  if (r && r.verdict === 'fail') return `did not pass: ${String(r.reason || '').replace(/[.\s]+$/, '')}`;
  if (r && r.verdict === 'could not run') return `could not be looked over: ${String(r.reason || '').replace(/[.\s]+$/, '')}`;
  return 'did not pass its check';
}

// Why a bet made under older rules can no longer be shown, or null. Only the
// rules that do not need today's numbers re-run here: a real check, a member
// from the team on every team step, and no team-only metric. The skeptic
// does not re-run, so the plumbing metric is dropped by name.
function queuedProblem(bet, team) {
  if (!bet || typeof bet !== 'object' || !Array.isArray(bet.steps)) return 'it is not a whole bet';
  const metric = bet.target && bet.target.metric;
  if (!metric || !METRICS[metric]) return 'it has no target number we can read';
  if (TEAM_ONLY_METRICS.has(metric)) return `its target ${metric} measures team plumbing, not a business move`;
  const vp = verifyProblem(bet.verify);
  if (vp) return vp;
  for (const k of ['title', 'why_now', 'expect']) {
    const word = ownerWord(bet[k]);
    if (word) return `its ${k} uses "${word}", a word the owner never reads`;
  }
  if (team) {
    const names = new Set(team.map(m => m.name));
    const i = bet.steps.findIndex(st => st && st.who === 'team' && !(typeof st.member === 'string' && names.has(st.member)));
    if (i >= 0) return `step ${i + 1} names no member on the team`;
  }
  return null;
}

// ---- the desk: a queue of ready bets, one shown at a time --------------------------------

const QUEUE_TARGET = 3;
const REFILL_BELOW = 2;
// one generation at a time; the cap of 3 calls in flight per session is never reached
const MAX_IN_FLIGHT = 1;
const SESSION_IN_FLIGHT_CAP = 3;
const STALE_MS = 6 * 60 * 60 * 1000;
const RECENT_TITLES = 20;
// two failed background generations in a row pause the prefetch, and a timer
// tries again after 10 minutes
const MAX_BACKGROUND_FAILURES = 2;
const BACKOFF_MS = 10 * 60 * 1000;

// deps:
//   workspaceRoot, ledgerFile, attemptsFile   where
//   generate(opts)                            -> generateBet result (tests stub)
//   runCli(args)                              -> Promise<{ code, stdout, stderr }>
//   log(row)                                  receipt row for gm-phone-actions.jsonl
//   now()                                     clock
//   readMissions(root), readReceipt(m, root)  mission state, read-only (tests stub)
//   pollMs                                    how often to read job status and top up the queue (off when unset)
//   warmOnCreate                              start filling the queue at once (default on)
//   setTimer(fn, ms)                          the backoff timer (tests stub; unref'd by default)
//   readBundle()                              -> Promise<bundle>, the facts for question cards when no generation reads them
//   choices                                   2 or more ideas ready show as one card to pick from (default on)
//   driverAlive(mission)                      is a process really running this mission (tests stub)
function createBetDesk(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const focusFile = focusPath(path.dirname(deps.ledgerFile));
  const questionsFile = questionsPath(path.dirname(deps.ledgerFile));
  // a desk with a stubbed idea writer never reaches the real question model
  const writeQuestion = deps.generateQuestion || (deps.generate
    ? (() => new Promise(() => {}))
    : (opts => generateQuestion({ ...opts, deps: deps.generatorDeps || {}, ledgerFile: deps.ledgerFile, today: dayKey(now()) })));
  // the real writer starts on the next turn, so its first reads never hold up a tap
  const generate = deps.generate || (opts => new Promise(resolve => setImmediate(resolve)).then(() => generateBet({ ...opts, deps: deps.generatorDeps || {}, ledgerFile: deps.ledgerFile, attemptsFile: deps.attemptsFile })));
  const log = deps.log || (() => {});
  const state = {
    status: 'idle',
    current: null,
    queue: [],
    inFlight: 0,
    maxInFlight: 0,
    gen: null,
    // a sharper idea asked for, made in the background like any other
    pendingSharper: null,
    topping: false,
    failures: 0,
    backoffUntil: 0,
    retry: null,
    // the last bundle a generation read, for the question cards
    bundle: deps.bundle || null,
    // questions passed over this session, so a re-tap asks the next one
    passedQuestions: new Set(),
    // the question writer: one at a time, resting after failures like the idea writer
    qInFlight: null,
    qFailures: 0,
    qBackoffUntil: 0,
    qRetry: null,
    run: 0,
    error: null,
    mission: null,
    started: [],
    // the started bets' missions as of the last read: working ones, and open
    // asks that need the owner's yes
    jobs: { working: [], yes: [], at: 0 },
    // yes cards passed over this session, so a re-tap moves on
    seenYes: new Set(),
    // reviews running now, by bet id
    reviews: new Map(),
    // failed jobs being sent back to the team now, by bet id
    retrying: new Map(),
  };

  const iso = () => new Date(now()).toISOString();
  const record = (id, patch) => appendLedger(deps.ledgerFile, { id, workspace: deps.workspaceRoot, at: iso(), ...patch });
  const newId = () => `bet-${dayKey(now())}-${crypto.randomBytes(4).toString('hex')}`;

  // queued bets live in the ledger, so a restart or a reload wastes nothing
  for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot)) {
    if (row.status !== 'queued' || !row.bet) continue;
    state.queue.push({ id: row.id, bet: row.bet, created_at: Date.parse(row.created_at) || 0 });
  }

  // the team, read once: a queued bet whose members are not on it is not shown
  let team = null;
  try {
    team = (deps.readTeam || readTeam)(deps.workspaceRoot);
  } catch {
    team = null;
  }

  // Old bets go: older than 6 hours, or made under rules that have changed
  // since. Each is marked stale with why, and the queue refills behind them.
  function dropStale() {
    const keep = [];
    for (const item of state.queue) {
      const why = now() - item.created_at > STALE_MS ? 'older than 6 hours' : queuedProblem(item.bet, team);
      if (why) {
        record(item.id, { status: 'stale', stale_reason: why });
        log({ card: 'bet', choice: 'stale', command: null, ran: 'in process', exit_code: 0, bet_id: item.id, why });
      } else {
        keep.push(item);
      }
    }
    state.queue = keep;
  }
  dropStale();

  // every title the next bet must differ from: the one on screen, the queue,
  // the one being made, and the newest ones in the ledger
  function avoidTitles() {
    const titles = [];
    if (state.current && state.current.bet) titles.push(state.current.bet.title);
    for (const item of state.queue) titles.push(item.bet.title);
    for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot).slice(-RECENT_TITLES)) if (row.bet && row.bet.title) titles.push(row.bet.title);
    return [...new Set(titles)];
  }

  function show(item) {
    state.current = item;
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    record(item.id, { status: 'proposed', shown_at: iso() });
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, bet_id: item.id });
  }

  // approvals live beside the ledger, in ~/.atris/state, outside the workspace
  const lockDir = path.dirname(deps.ledgerFile);

  // The your-yes lock for a job: written before it runs, so the guard holds
  // each owner step from the first tick.
  function lockYesSteps(missionId, betId, steps) {
    try {
      const yesLock = require('./yes-lock');
      const locks = yesLock.writeYesLocks(lockDir, missionId, { betId, seal: yesLock.sealFor(steps) });
      log({ card: 'bet', choice: 'lock', command: null, ran: 'in process', exit_code: 0, bet_id: betId, mission_id: missionId, locked_steps: locks.map(l => l.step) });
    } catch (err) {
      log({ card: 'bet', choice: 'lock', command: null, ran: 'in process', exit_code: 1, bet_id: betId, mission_id: missionId, error: clip(String((err && err.message) || err), 160) });
    }
  }

  // Reads every started bet's mission, read-only. A mission that finished or
  // halted gets one ledger row with what its receipt says (the bet stays
  // "doing" so it is still scored won or lost on its check date). Open asks
  // become yes cards; open missions are the working list.
  function pollJobs() {
    let missions;
    try {
      missions = (deps.readMissions || defaultReadMissions)(deps.workspaceRoot);
    } catch {
      return state.jobs;
    }
    const get = id => (missions instanceof Map ? missions.get(id) : (missions || {})[id]) || null;
    let handoffRows = null;
    const handoffs = () => {
      if (!handoffRows) handoffRows = (deps.readHandoffs || defaultReadHandoffs)(deps.workspaceRoot);
      return handoffRows;
    };
    let reviewer;
    const reviewerName = () => {
      if (reviewer === undefined) {
        try { reviewer = (deps.reviewer || defaultReviewer)(deps.workspaceRoot); } catch { reviewer = null; }
      }
      return reviewer;
    };
    const working = [];
    const yes = [];
    for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot)) {
      if (row.status !== 'doing' || !row.mission_id || row.mission_result) continue;
      const mission = get(row.mission_id);
      const finished = mission && (mission.status === 'complete' || mission.status === 'stopped');
      const receipt = finished ? (deps.readReceipt || defaultReadReceipt)(mission, deps.workspaceRoot) : null;
      const job = jobState(row, mission, receipt, now());
      // still because the guard holds a step for the owner's yes: that is a yes card, not a halt
      const held = job.stalled ? require('./yes-lock').askedYesLocks(lockDir, mission.id) : [];
      if (held.length) {
        for (const lock of held) yes.push({ ...job, kind: 'yes', ask: lock.text, command: lock.held_command || null, lock_step: lock.step, ask_index: null, key: `${mission.id}:step-${lock.step}` });
        continue;
      }
      // finished with nothing failed: the roster's reviewer looks before it counts as done
      if (job.kind === 'done' && !job.failed && !job.halted) {
        startReview(row, job, reviewerName());
        working.push({ ...job, kind: 'working', owner: currentMember(row.id, job.owner, handoffs()) });
        continue;
      }
      if (job.kind === 'done') {
        record(row.id, {
          mission_result: job.failed ? 'failed' : 'done',
          mission_status: job.stalled ? 'stalled' : mission.status,
          mission_checked: job.checked,
          mission_changed: job.changed,
          mission_proof: job.proof,
          mission_halted: job.halted,
          mission_stalled: Boolean(job.stalled),
          mission_out_of_time: Boolean(job.out_of_time),
          mission_progress: Boolean(job.progress),
          mission_stop_reason: job.stop_reason,
          finished_seen_at: iso(),
        });
        log({ card: 'bet', choice: 'job_finished', command: null, ran: 'in process', exit_code: job.failed ? 1 : 0, bet_id: row.id, mission_id: mission.id });
      } else if (job.kind === 'working') {
        working.push({ ...job, owner: currentMember(row.id, job.owner, handoffs()) });
        // a step the job tried and the guard held is a yes card
        for (const lock of require('./yes-lock').askedYesLocks(lockDir, mission.id)) {
          yes.push({ ...job, kind: 'yes', ask: lock.text, command: lock.held_command || null, lock_step: lock.step, ask_index: null, key: `${mission.id}:step-${lock.step}` });
        }
      } else if (job.kind === 'yes') {
        for (const ask of job.asks) yes.push({ ...job, ask_index: ask.index, ask: ask.text, key: `${job.mission_id}:${ask.index}` });
      }
    }
    const expectOf = new Map(readLedger(deps.ledgerFile, deps.workspaceRoot).map(r => [r.id, r.bet && r.bet.expect]));
    state.jobs = { working, yes: yes.map(y => ({ ...y, expect: expectOf.get(y.bet_id) || null })), at: now() };
    retryFailed();
    return state.jobs;
  }

  // A job that halted, stalled, or did not pass is never a card: it goes back
  // to the team once on its own, and the second time it is closed quietly
  // with why. A bet made under older rules (plumbing) is closed at once.
  function retryFailed() {
    for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot)) {
      if (row.mission_result !== 'failed' || row.done_seen_at || state.retrying.has(row.id)) continue;
      const why = failWhy(row);
      const problem = row.bet ? queuedProblem(row.bet, team) : 'it is not a whole bet';
      if (problem) { close(row, problem); continue; }
      // up to two more rounds while each one makes progress; one with none closes
      const rounds = Number(row.auto_sent_back) || 0;
      if (rounds >= 2) { close(row, `${why}, after two more rounds`); continue; }
      if (rounds === 1 && !row.mission_progress) { close(row, `${why}, after one try again`); continue; }
      const run = sendBackJob(row, why)
        .catch(err => close(row, `it could not go back to the team: ${clip(String((err && err.message) || err), 120)}`))
        .finally(() => state.retrying.delete(row.id));
      state.retrying.set(row.id, run);
    }
  }

  function close(row, reason) {
    record(row.id, { mission_result: 'closed', closed_reason: reason, closed_at: iso(), done_seen_at: iso() });
    log({ card: 'bet', choice: 'close', command: null, ran: 'in process', exit_code: 0, bet_id: row.id, mission_id: row.mission_id, why: reason });
  }

  // One review per finished job at a time. A pass makes it done; a fail makes
  // it failed (it goes back to the team on its own); a review that cannot run is tried again
  // on the next read, and after REVIEW_TRIES it counts as failed with why.
  function startReview(row, job, engine) {
    if (state.reviews.has(row.id)) return;
    const finish = (patch) => {
      record(row.id, { ...patch, mission_status: 'complete', mission_checked: job.checked, mission_changed: job.changed, mission_proof: job.proof, mission_halted: false, mission_stop_reason: null, finished_seen_at: iso() });
      log({ card: 'bet', choice: 'job_finished', command: null, ran: 'in process', exit_code: patch.mission_result === 'done' ? 0 : 1, bet_id: row.id, mission_id: job.mission_id });
    };
    const tries = (Number(row.review_tries) || 0) + 1;
    const gaveUp = reason => (tries >= REVIEW_TRIES
      ? finish({ mission_result: 'failed', review: { engine, verdict: 'could not run', reason }, review_tries: tries })
      : record(row.id, { review_tries: tries, review_error: reason }));
    if (!engine) { gaveUp('no reviewer is set in the engine roster'); return; }
    const args = ['engine', 'ask', reviewPrompt(row.bet, job), '--engine', engine, '--timeout', String(REVIEW_TIMEOUT_S), '--json'];
    const run = (deps.reviewCli || deps.runCli)(args).then((res) => {
      log({ card: 'bet', choice: 'review', command: `atris engine ask "<review of ${row.id}>" --engine ${engine} --timeout ${REVIEW_TIMEOUT_S} --json`, exit_code: res.code, bet_id: row.id, mission_id: job.mission_id });
      const v = res.code === 0 ? reviewVerdict(res.stdout) : null;
      if (!v) return gaveUp(res.code === 0 ? 'the reviewer gave no pass or fail' : `the review exited with code ${res.code}`);
      return finish({ mission_result: v.verdict === 'pass' ? 'done' : 'failed', review: { engine, ...v }, review_tries: tries });
    }).catch(err => gaveUp(String((err && err.message) || err))).finally(() => {
      state.reviews.delete(row.id);
      // a fail goes back to the team now, not on the next read
      retryFailed();
    });
    state.reviews.set(row.id, run);
  }

  // Finished business moves not yet seen, from the ledger, so they survive a
  // restart. Plumbing and failed work never become a card.
  function doneJobs() {
    return readLedger(deps.ledgerFile, deps.workspaceRoot)
      .filter(row => row.mission_result === 'done' && !row.done_seen_at && isBusinessMove(row.bet))
      .map(row => ({ kind: 'done', bet_id: row.id, mission_id: row.mission_id, title: row.bet.title, owner: row.owner || 'the team', bet: row.bet }));
  }

  // The next card that is not a bet: a yes the owner owes comes first, then
  // a finished job. Nothing pops on its own; these only come on the next tap.
  function nextJobCard() {
    const ask = state.jobs.yes.find(j => !state.seenYes.has(j.key));
    if (ask) return { kind: 'yes', id: `yes:${ask.key}`, job: ask };
    const done = doneJobs()[0];
    if (done) return { kind: 'done', id: `done:${done.bet_id}`, job: done };
    return null;
  }

  function showJob(item) {
    state.current = item;
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: item.kind, bet_id: item.job.bet_id });
  }

  // The questions written ahead, oldest first, not yet shown.
  function readyQuestions() {
    return readLedger(questionsFile, deps.workspaceRoot).filter(r => r.status === 'ready' && r.question);
  }

  const answerCount = () => Object.keys(readFocus(focusFile, deps.workspaceRoot)).length;

  // Every answer so far, oldest first, for both writers.
  function answersSoFar() {
    return Object.values(readFocus(focusFile, deps.workspaceRoot))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-12)
      .map(a => ({ ask: a.ask, label: a.label }));
  }

  // Keeps QUESTIONS_READY questions written ahead, one writer at a time.
  // After MAX_BACKGROUND_FAILURES in a row it rests for BACKOFF_MS.
  function pumpQuestions() {
    if (state.qInFlight) return state.qInFlight;
    if (readyQuestions().length >= QUESTIONS_READY) return null;
    if (state.qFailures >= MAX_BACKGROUND_FAILURES) {
      if (now() < state.qBackoffUntil) return null;
      state.qFailures = 0;
    }
    const avoid = readLedger(questionsFile, deps.workspaceRoot).slice(-20).map(r => r.question && r.question.ask).filter(Boolean);
    const opts = { workspaceRoot: deps.workspaceRoot, answers: answersSoFar(), avoid, bundle: state.bundle };
    const seen = answerCount();
    const run = Promise.resolve()
      .then(() => writeQuestion(opts))
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        state.qInFlight = null;
        // written before the newest answer while another is ready: write it again, knowing the answer
        if (out && out.ok && seen < answerCount() && readyQuestions().length >= 1) {
          log({ card: 'bet', choice: 'question', command: null, ran: 'in process', exit_code: 0, stale: 'written before the newest answer' });
          return pumpQuestions();
        }
        if (out && out.ok) {
          state.qFailures = 0;
          const id = `q-${dayKey(now())}-${crypto.randomBytes(4).toString('hex')}`;
          appendLedger(questionsFile, { id, workspace: deps.workspaceRoot, created_at: iso(), status: 'ready', answers_seen: seen, question: out.question });
          log({ card: 'bet', choice: 'question', command: null, ran: 'in process', exit_code: 0, question: id });
        } else {
          state.qFailures += 1;
          log({ card: 'bet', choice: 'question', command: null, ran: 'in process', exit_code: 1, error: clip((out && out.reason) || 'no question', 200) });
          if (state.qFailures >= MAX_BACKGROUND_FAILURES) {
            state.qBackoffUntil = now() + BACKOFF_MS;
            if (!state.qRetry) state.qRetry = setTimer(() => { state.qRetry = null; pumpQuestions(); }, BACKOFF_MS);
            return null;
          }
        }
        return pumpQuestions();
      });
    state.qInFlight = run;
    return run;
  }

  // A question when no idea is ready: the next one written ahead from this
  // project, else the one generic question if it was not answered this week;
  // null when there is none to ask.
  function nextQuestion() {
    const row = readyQuestions().find(r => !state.passedQuestions.has(r.id));
    if (row) {
      const q = row.question;
      return { kind: 'question', id: `question:${row.id}`, question: { key: row.id, ask: q.ask, line: q.fact, choices: q.choices.map((label, i) => ({ id: `a${i + 1}`, label })) } };
    }
    const F = FALLBACK_QUESTION;
    const said = readFocus(focusFile, deps.workspaceRoot)[F.key];
    if (state.passedQuestions.has(F.key) || (said && now() - (Date.parse(said.at) || 0) < FOCUS_FRESH_MS)) return null;
    return { kind: 'question', id: `question:${F.key}`, question: { key: F.key, ask: F.ask, line: installsLine(state.bundle), choices: F.choices.map(c => ({ ...c })) } };
  }

  // Two or three ideas ready: one card to pick from. Each is shown, so each
  // is recorded as proposed; the ones not picked are passed.
  const CHOICE_MAX = 3;
  function showChoice(items) {
    state.current = { kind: 'choice', id: `choice:${items.map(i => i.id).join(',')}`, items };
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    for (const item of items) record(item.id, { status: 'proposed', shown_at: iso() });
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'choice', bet_ids: items.map(i => i.id) });
  }

  // one tap on a choice: that idea's full card, with do it as before
  function pick({ id } = {}) {
    const cur = onJob('choice');
    const item = cur && cur.items.find(i => i.id === id);
    if (!item) return { ok: false, reason: 'gone', message: 'there is nothing to pick on screen' };
    for (const other of cur.items) if (other !== item) record(other.id, { status: 'passed', note: 'not picked' });
    log({ card: 'bet', choice: 'pick', command: null, ran: 'in process', exit_code: 0, bet_id: item.id });
    state.current = item;
    state.status = 'ready';
    return { ok: true, ...view() };
  }

  // nothing ready and nothing left to ask: one plain card, shown at once
  const WAIT_CARD = { what: 'the next idea is being written.', why: 'tap the orb again in a minute to see it.' };
  function showWait() {
    state.current = { kind: 'wait', id: `wait:${now()}` };
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'wait' });
  }

  function showQuestion(item) {
    if (item.question.key !== FALLBACK_QUESTION.key) appendLedger(questionsFile, { id: item.question.key, workspace: deps.workspaceRoot, status: 'shown', shown_at: iso() });
    state.current = item;
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'question', question: item.question.key });
  }

  // a re-tap on a job card moves on: a yes waits for a later session, a done is seen
  function passJob(item) {
    if (item.kind === 'wait') return;
    if (item.kind === 'choice') {
      for (const i of item.items) record(i.id, { status: 'passed', note: 'not picked' });
      log({ card: 'bet', choice: 'pass', command: null, ran: 'in process', exit_code: 0, kind: 'choice' });
      return;
    }
    if (item.kind === 'question') {
      state.passedQuestions.add(item.question.key);
      if (item.question.key !== FALLBACK_QUESTION.key) appendLedger(questionsFile, { id: item.question.key, workspace: deps.workspaceRoot, status: 'passed' });
      log({ card: 'bet', choice: 'pass', command: null, ran: 'in process', exit_code: 0, kind: 'question', question: item.question.key });
      return;
    }
    if (item.kind === 'yes') state.seenYes.add(item.job.key);
    if (item.kind === 'done') record(item.job.bet_id, { done_seen_at: iso() });
    log({ card: 'bet', choice: 'pass', command: null, ran: 'in process', exit_code: 0, kind: item.kind, bet_id: item.job.bet_id });
  }

  pollJobs();
  // the same read also tops up the queue, so it stays full with no page open
  if (deps.pollMs) {
    const timer = setInterval(() => { pollJobs(); pump(); }, deps.pollMs);
    if (timer.unref) timer.unref();
  }

  // after MAX_BACKGROUND_FAILURES in a row the prefetch rests, and one timer
  // tries again; a tap in the meantime still gets a card at once
  function backOff() {
    state.backoffUntil = now() + BACKOFF_MS;
    if (state.retry) return;
    state.retry = setTimer(() => { state.retry = null; pump(); }, BACKOFF_MS);
  }

  function startGeneration({ sharperOf = null } = {}) {
    if (state.inFlight >= MAX_IN_FLIGHT || state.inFlight >= SESSION_IN_FLIGHT_CAP) return null;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.run += 1;
    const gen = { run: state.run, events: [], sharperOf };
    state.gen = gen;
    const emit = (ev) => { gen.events.push({ i: gen.events.length, at: now(), ...ev }); };
    // started now, not on a later tick, so the in-flight count is exact
    let started;
    try {
      started = Promise.resolve(generate({ workspaceRoot: deps.workspaceRoot, today: dayKey(now()), previousTitle: sharperOf, avoidTitles: avoidTitles(), emit, onBundle: (b) => { state.bundle = b; } }));
    } catch (err) {
      started = Promise.reject(err);
    }
    gen.done = started
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        state.inFlight -= 1;
        if (state.gen === gen) state.gen = null;
        if (out.bundle) state.bundle = out.bundle;
        if (!out.ok) {
          // a failure stays in the log; the owner never waits on it or sees it
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 1, error: clip(out.reason, 200) });
          emit({ kind: 'failed', line: out.reason });
          state.failures += 1;
          if (state.failures >= MAX_BACKGROUND_FAILURES) backOff();
          return pump();
        }
        state.failures = 0;
        const item = { id: newId(), bet: out.bet, created_at: now() };
        record(item.id, { created_at: iso(), status: 'queued', bet: out.bet, previous_title: sharperOf });
        log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 0, bet_id: item.id });
        emit({ kind: 'done', line: 'bet ready' });
        // the sharper idea the owner asked for is the next bet shown
        if (sharperOf) state.queue.unshift(item);
        else state.queue.push(item);
        return pump();
      });
    return gen;
  }

  // Keeps the queue topped up: below 2 it refills to 3, one generation at a
  // time. A sharper idea the owner asked for goes first.
  function pump() {
    pumpQuestions();
    dropStale();
    if (state.inFlight >= MAX_IN_FLIGHT) return state.gen && state.gen.done;
    if (state.pendingSharper) {
      const sharperOf = state.pendingSharper;
      state.pendingSharper = null;
      const gen = startGeneration({ sharperOf });
      return gen && gen.done;
    }
    if (state.queue.length < REFILL_BELOW) state.topping = true;
    if (state.queue.length >= QUEUE_TARGET) state.topping = false;
    if (!state.topping) return null;
    if (state.failures >= MAX_BACKGROUND_FAILURES) {
      if (now() < state.backoffUntil) return null;
      state.failures = 0;
    }
    const gen = startGeneration();
    return gen && gen.done;
  }

  // The page opened: start filling the queue so the first tap does not wait.
  function warm() {
    pump();
    return view();
  }

  // A tap on the orb: the card on screen is passed over, and the next one
  // shows at once: a yes, a finished job, a queued bet, a question, or a
  // plain card that says the next idea is being written. A tap never waits.
  // sharper passes the bet over and asks the background for a sharper one.
  function next({ sharper = false } = {}) {
    if (state.status === 'starting') return { ok: true, busy: true, ...view() };
    const onScreen = state.status === 'ready' && state.current ? state.current : null;
    if (onScreen && onScreen.kind && onScreen.kind !== 'bet') {
      passJob(onScreen);
    } else if (onScreen) {
      record(onScreen.id, { status: 'passed', ...(sharper ? { note: 'asked for a sharper idea' } : {}) });
      log({ card: 'bet', choice: sharper ? 'sharper' : 'pass', command: null, ran: 'in process', exit_code: 0, bet_id: onScreen.id });
      if (sharper) state.pendingSharper = onScreen.bet.title;
    } else {
      log({ card: 'bet', choice: 'think', command: null, ran: 'in process', exit_code: 0 });
    }
    dropStale();
    if (now() - state.jobs.at > 5000) pollJobs();
    const job = nextJobCard();
    if (job) showJob(job);
    else if (deps.choices !== false && state.queue.length >= 2) showChoice(state.queue.splice(0, CHOICE_MAX));
    else if (state.queue.length) show(state.queue.shift());
    else {
      const question = nextQuestion();
      if (question) showQuestion(question);
      else {
        showWait();
        // the card says an idea is being written, so one is, even mid backoff
        if (!state.gen) { state.failures = 0; state.backoffUntil = 0; }
      }
    }
    pump();
    return { ok: true, ...view() };
  }

  const isBet = () => state.status === 'ready' && state.current && (!state.current.kind || state.current.kind === 'bet');

  function skip() {
    if (!isBet()) return { ok: false, reason: 'gone', message: 'there is no idea on screen to skip' };
    record(state.current.id, { status: 'skipped' });
    log({ card: 'bet', choice: 'skip', command: null, ran: 'in process', exit_code: 0, bet_id: state.current.id });
    state.status = 'skipped';
    return { ok: true, ack: 'not now. all clear.' };
  }

  async function doIt() {
    if (!isBet()) return { ok: false, reason: 'gone', message: 'there is no idea on screen to start' };
    const { id, bet } = state.current;
    const pick = pickOwner(bet, deps.workspaceRoot);
    const startArgs = missionStartArgs(bet, pick, id);
    state.status = 'starting';
    const display = args => require('./gm-phone').displayCommand(args);
    let res = await deps.runCli(startArgs);
    log({ card: 'bet', choice: 'do', command: display(startArgs), exit_code: res.code, bet_id: id });
    const started = parseJsonOut(res.stdout);
    const missionId = started && (started.mission ? started.mission.id : started.mission_id);
    if (res.code !== 0 || !missionId) {
      state.status = 'ready';
      const why = clip((res.stderr || res.stdout || '').trim().split('\n').pop(), 160);
      log({ card: 'bet', choice: 'do', command: null, ran: 'in process', exit_code: res.code, bet_id: id, error: why || null });
      return { ok: false, reason: 'start_failed', message: 'it did not get going. try again in a minute.' };
    }
    const owner = (started.mission && started.mission.owner) || pick.owner;
    record(id, { status: 'doing', mission_id: missionId, owner });
    lockYesSteps(missionId, id, bet.steps);
    const runArgs = missionRunArgs(missionId, bet);
    res = await deps.runCli(runArgs);
    log({ card: 'bet', choice: 'do', command: display(runArgs), exit_code: res.code, bet_id: id, mission_id: missionId });
    const ran = parseJsonOut(res.stdout) || {};
    let line;
    // what the owner reads; the command and exit code stay in the log
    if (res.code === 0 && ran.action === 'mission_run_detached') line = `${owner} has it and is starting now.`;
    else if (ran.reason === 'human_asks_open') line = `${owner} has it, and is waiting on your yes before starting.`;
    else line = `${owner} has it, but has not started yet. it can be started from the mac.`;
    state.status = 'started';
    state.mission = { id: missionId, owner, line, commands: [display(startArgs), display(runArgs)] };
    state.started.push({ bet_id: id, mission_id: missionId, owner, steps: bet.steps, yes: {} });
    pollJobs();
    return { ok: true, ack: line, mission: state.mission };
  }

  const onJob = kind => (state.status === 'ready' && state.current && state.current.kind === kind ? state.current : null);

  // nice: a finished job was seen; nothing else happens
  function nice() {
    const item = onJob('done');
    if (!item) return { ok: false, reason: 'gone', message: 'there is no finished job on screen' };
    record(item.job.bet_id, { done_seen_at: iso() });
    log({ card: 'bet', choice: 'nice', command: null, ran: 'in process', exit_code: 0, bet_id: item.job.bet_id });
    state.status = 'cleared';
    return { ok: true, ack: 'nice.' };
  }

  // an answer to the question on screen is saved to the focus file, where
  // the writer reads it for every bet after this one
  function answer({ choice } = {}) {
    const item = onJob('question');
    if (!item) return { ok: false, reason: 'gone', message: 'there is no question on screen' };
    const picked = item.question.choices.find(c => c.id === choice);
    if (!picked) return { ok: false, reason: 'bad_choice', message: 'that is not one of the answers' };
    const q = item.question;
    appendLedger(focusFile, { workspace: deps.workspaceRoot, key: q.key, answer: picked.id, label: picked.label, ask: q.ask, at: iso() });
    if (q.key !== FALLBACK_QUESTION.key) appendLedger(questionsFile, { id: q.key, workspace: deps.workspaceRoot, status: 'answered' });
    log({ card: 'bet', choice: 'answer', command: null, ran: 'in process', exit_code: 0, question: q.key, answer: picked.id });
    state.status = 'cleared';
    // the next questions are written knowing this answer: any written before
    // it are retired, except the oldest, so the next tap is still instant
    const count = answerCount();
    readyQuestions().slice(1).filter(r => (Number(r.answers_seen) || 0) < count).forEach((r) => {
      appendLedger(questionsFile, { id: r.id, workspace: deps.workspaceRoot, status: 'stale' });
    });
    pumpQuestions();
    return { ok: true, ack: `got it: ${picked.label}.` };
  }

  // Send back: a job that did not pass goes to the team again as a new
  // mission on the same bet, with what went wrong in the objective.
  async function sendBackJob(row, why) {
    const again = { ...row.bet, why_now: `the last run ${why}. try again. ${row.bet.why_now}` };
    const pick = pickOwner(again, deps.workspaceRoot);
    const display = args => require('./gm-phone').displayCommand(args);
    const startArgs = missionStartArgs(again, pick, row.id);
    let res = await deps.runCli(startArgs);
    log({ card: 'bet', choice: 'send_back', command: display(startArgs), exit_code: res.code, bet_id: row.id });
    const started = parseJsonOut(res.stdout);
    const missionId = started && (started.mission ? started.mission.id : started.mission_id);
    if (res.code !== 0 || !missionId) return close(row, `it could not go back to the team (exit code ${res.code})`);
    const owner = (started.mission && started.mission.owner) || pick.owner;
    record(row.id, { mission_id: missionId, owner, mission_result: null, mission_halted: null, mission_stalled: null, mission_out_of_time: null, mission_progress: null, mission_stop_reason: null, review_tries: 0, done_seen_at: null, sent_back_at: iso(), auto_sent_back: (Number(row.auto_sent_back) || 0) + 1 });
    lockYesSteps(missionId, row.id, again.steps);
    const runArgs = missionRunArgs(missionId, again);
    res = await deps.runCli(runArgs);
    log({ card: 'bet', choice: 'send_back', command: display(runArgs), exit_code: res.code, bet_id: row.id, mission_id: missionId });
    return null;
  }

  // yes: answers the mission's open ask through atris decide, matched by
  // mission and ask, never by its place in a list
  async function answerYes() {
    const item = onJob('yes');
    if (!item) return { ok: false, reason: 'gone', message: 'there is no question on screen' };
    const { job } = item;
    if (job.lock_step) {
      require('./yes-lock').approveYesLock(lockDir, job.mission_id, job.lock_step, null, iso());
      const args = ['mission', 'ping', job.mission_id, `the owner said yes to step ${job.lock_step}: ${job.ask}. the guard lets it through now; run it again.`, '--from', 'gm-phone'];
      const res = await deps.runCli(args);
      log({ card: 'bet', choice: 'yes', command: require('./gm-phone').displayCommand(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id, step: job.lock_step });
      state.seenYes.add(job.key);
      record(job.bet_id, { yes_answered: { mission_id: job.mission_id, step: job.lock_step, at: iso() } });
      state.status = 'cleared';
      pollJobs();
      return { ok: true, ack: `${job.owner}: got your yes` };
    }
    const listed = await deps.runCli(['decide', '--json']);
    const open = (parseJsonOut(listed.stdout) || {}).decisions || [];
    const match = open.find(d => d && d.mission_id === job.mission_id && d.ask_index === job.ask_index);
    if (!match) {
      state.seenYes.add(job.key);
      state.status = 'cleared';
      return { ok: true, ack: 'that question was already answered.' };
    }
    const args = ['decide', String(match.number), 'yes', '--json'];
    const res = await deps.runCli(args);
    log({ card: 'bet', choice: 'yes', command: require('./gm-phone').displayCommand(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id });
    if (res.code !== 0) return { ok: false, reason: 'answer_failed', message: 'your yes did not go through; try again' };
    state.seenYes.add(job.key);
    record(job.bet_id, { yes_answered: { mission_id: job.mission_id, ask_index: job.ask_index, at: iso() } });
    state.status = 'cleared';
    pollJobs();
    return { ok: true, ack: `${job.owner}: got your yes` };
  }

  // Two sentences for the owner: what is going on, and why it matters to
  // the business. Nothing about how the work was checked.
  function publicJob(item) {
    const j = item.job;
    const expect = item.kind === 'yes' ? j.expect : j.bet && j.bet.expect;
    const why = expect ? ` ${sentence(expect)}` : '';
    if (item.kind === 'yes') return { what: j.ask, why: `${j.owner} is waiting on your yes for this.${why}` };
    return { what: j.title, why: `this is done.${why}` };
  }

  // Decision cards for the steps that need the owner's yes, for every bet
  // started this session. Saying yes tells the mission with a ping; it runs
  // nothing public.
  function yesCards() {
    const cards = [];
    state.started.forEach((m, n) => {
      m.steps.forEach((step, i) => {
        if (step.who !== 'you' || m.yes[i]) return;
        cards.push({
          id: `yes-${n}-${i}`,
          text: `your yes: ${step.text}`,
          moves: null,
          bet_yes: { n, i },
          choices: [
            {
              id: 'yes',
              label: 'yes, tell the mission',
              effect: 'records your yes. nothing goes out until the mission does this step.',
              member: m.owner,
              ack: `${m.owner}: got your yes`,
              confirm: true,
              steps: [yesPingArgs(m.mission_id, step)],
            },
            { id: 'later', label: 'later' },
          ],
        });
      });
    });
    return cards;
  }

  function recordYes({ n, i }) {
    const m = state.started[n];
    if (!m) return;
    m.yes[i] = now();
    record(m.bet_id, { yes: { ...m.yes } });
    try { require('./yes-lock').approveYesLock(lockDir, m.mission_id, i + 1, null, iso()); } catch { /* no lock for this job */ }
  }

  function view() {
    // the writer's progress stays in the log; the page never reads it
    const events = [];
    const cur = state.current;
    const kind = cur ? (cur.kind || 'bet') : null;
    return {
      status: state.status,
      id: cur ? cur.id : null,
      kind,
      bet: kind === 'bet' ? cur.bet : null,
      job: kind === 'yes' || kind === 'done' ? publicJob(cur) : (kind === 'wait' ? { ...WAIT_CARD } : null),
      question: kind === 'question' ? { ask: cur.question.ask, line: cur.question.line, choices: cur.question.choices } : null,
      // each option: its title, and one plain line of why, the result it expects
      choice: kind === 'choice' ? { options: cur.items.map(i => ({ id: i.id, title: i.bet.title, why: choiceWhy(i.bet.expect) })) } : null,
      working: state.jobs.working.map(j => ({ title: j.title, owner: j.owner, ...(j.left ? { left: j.left } : {}) })),
      // the footer count: only members really working
      team_working: teamTable().rows.filter(r => r.status === 'working').length,
      events: events.map(e => ({ i: e.i, kind: e.kind, line: e.line, ...(e.key ? { key: e.key } : {}), ...(e.n != null ? { n: e.n } : {}) })),
      error: state.error,
      queue: state.queue.length,
      mission: state.mission ? { owner: state.mission.owner, line: state.mission.line } : null,
    };
  }

  // ---- the team table: who is on what, from real state ----

  // A member is working only when a process is really running its mission,
  // or the mission moved in the last few minutes. A handoff that no process
  // picked up is waiting to start. Members with nothing in the last day are
  // left out.
  const RECENT_MS = 24 * 60 * 60 * 1000;
  const MOVING_MS = 5 * 60 * 1000;
  const STATUS_ORDER = ['waiting for your yes', 'working', 'waiting to start', 'stopped', 'done', 'idle'];
  const driverAlive = deps.driverAlive || ((m) => {
    try { return require(path.join(__dirname, '..', 'commands', 'mission.js')).missionDriverHealth(m, deps.workspaceRoot).alive === true; } catch { return false; }
  });
  let teamCache = null;
  function teamTable() {
    if (teamCache && now() - teamCache.at < 10000) return teamCache.table;
    const names = new Set((team || []).map(m => m.name));
    let missions;
    try { missions = (deps.readMissions || defaultReadMissions)(deps.workspaceRoot); } catch { missions = null; }
    const list = missions instanceof Map ? [...missions.values()] : Object.values(missions || {});
    const ideaTitle = new Map(readLedger(deps.ledgerFile, deps.workspaceRoot).filter(r => r.mission_id && r.bet).map(r => [r.mission_id, r.bet.title]));
    const best = new Map();
    const put = (member, row, at) => {
      if (!names.has(member)) return;
      const rank = STATUS_ORDER.indexOf(row.status);
      const cur = best.get(member);
      if (!cur || rank < cur.rank || (rank === cur.rank && at > cur.at)) best.set(member, { row: { member, ...row }, rank, at });
    };
    for (const m of list) {
      if (!m || !m.owner) continue;
      const moved = Math.max(...[m.last_tick_at, m.updated_at, m.created_at].map(t => Date.parse(t || '') || 0));
      const age = now() - moved;
      if (!moved || age > RECENT_MS) continue;
      const created = Date.parse(m.created_at || '') || moved;
      const on = ideaTitle.get(m.id) || missionTitle(m.objective);
      const status = String(m.status || '');
      if (status === 'complete') { put(m.owner, { on, status: 'done', time: `finished ${spanWords(age)} ago` }, moved); continue; }
      if (status === 'stopped') { put(m.owner, { on, status: 'stopped', time: `stopped ${spanWords(age)} ago` }, moved); continue; }
      if (!OPEN_MISSION.has(status)) continue;
      const asks = (Array.isArray(m.human_asks) ? m.human_asks : []).some(a => a && !(typeof a === 'object' && a.answered_at))
        || require('./yes-lock').askedYesLocks(lockDir, m.id).length > 0;
      if (asks) { put(m.owner, { on, status: 'waiting for your yes', time: `waiting ${spanWords(age)}` }, moved); continue; }
      if (driverAlive(m) || age <= MOVING_MS) {
        const wall = Number(m.max_wall_seconds) || Number(m.budget_contract && m.budget_contract.requested_seconds) || 0;
        const left = wall ? created + wall * 1000 - now() : 0;
        put(m.owner, { on, status: 'working', time: left > 0 ? leftWords(left) : `at it for ${spanWords(now() - created)}` }, moved);
        continue;
      }
      if (!m.last_tick_at) { put(m.owner, { on, status: 'waiting to start', time: `waiting ${spanWords(now() - created)}` }, moved); continue; }
      put(m.owner, { on, status: 'stopped', time: `stopped ${spanWords(age)} ago` }, moved);
    }
    for (const hnd of (deps.readHandoffs || defaultReadHandoffs)(deps.workspaceRoot)) {
      const at = Date.parse((hnd && (hnd.closed_at || hnd.created_at)) || '') || 0;
      if (!hnd || !hnd.to || !at || now() - at > RECENT_MS) continue;
      const on = clip(String(hnd.summary || '').replace(/^\[[^\]]*\]\s*/, ''), 100);
      if (hnd.status === 'open') put(hnd.to, { on, status: 'waiting to start', time: `waiting ${spanWords(now() - at)}` }, at);
      else put(hnd.to, { on, status: 'idle', time: `free for ${spanWords(now() - at)}` }, at);
    }
    const rows = [...best.values()]
      .sort((a, b) => a.rank - b.rank || a.row.member.localeCompare(b.row.member))
      .map(x => x.row);
    const table = { rows };
    teamCache = { at: now(), table };
    return table;
  }

  // a word to a member from its talk card or a card on screen: atris member steer
  const SAY_MAX = 280;
  async function steer({ member, text } = {}) {
    const name = String(member || '');
    if (!(team || []).some(m => m.name === name)) return { ok: false, reason: 'gone', message: 'there is no such member on the team' };
    const said = String(text || '').trim();
    if (!said) return { ok: false, reason: 'empty', message: 'say something first' };
    if (said.length > SAY_MAX) return { ok: false, reason: 'too_long', message: `keep it under ${SAY_MAX} characters` };
    const args = ['member', 'steer', name, said, '--json'];
    const res = await deps.runCli(args);
    log({ card: 'bet', choice: 'steer', command: require('./gm-phone').displayCommand(args), exit_code: res.code, member: name, chars: said.length });
    teamCache = null;
    if (res.code !== 0) return { ok: false, reason: 'steer_failed', message: 'it did not reach them. try again in a minute.' };
    return { ok: true, ack: `sent to ${name}.` };
  }

  // resolves when every review and send back running now has finished (tests and shutdown)
  async function settle() {
    while (state.reviews.size || state.retrying.size) await Promise.all([...state.reviews.values(), ...state.retrying.values()]);
  }

  // the queue starts filling now, not when the page first opens; with the
  // queue already full, the facts for a question card are read on their own
  if (deps.warmOnCreate !== false) {
    pump();
    if (!state.inFlight && deps.readBundle) {
      Promise.resolve().then(() => deps.readBundle()).then((b) => { if (b && !state.bundle) state.bundle = b; }).catch(() => {});
    }
  }

  return { warm, next, pick, teamTable, steer, skip, doIt, nice, answerYes, answer, pollJobs, settle, yesCards, recordYes, view, state };
}

module.exports = {
  BACKOFF_MS,
  FALLBACK_QUESTION,
  choiceWhy,
  JOB_POLL_MS,
  OWNER_BANNED,
  jobTime,
  generateQuestion,
  readProjectContext,
  validateQuestion,
  STALL_MS,
  focusPath,
  readFocus,
  queuedProblem,
  MODEL_TIMEOUT_MS,
  STALE_MS,
  YES_RULE,
  buildPrompt,
  addDays,
  attemptsPath,
  bundleText,
  citesBundle,
  claudeArgs,
  createBetDesk,
  defaultReleaseGap,
  generateBet,
  bestWeek,
  installTotals,
  installWeeks,
  jobState,
  ledgerPath,
  makeCliRunner,
  missionObjective,
  modelEnv,
  parseVerdict,
  pickOwner,
  readBundle,
  readLedger,
  releaseFact,
  runModel,
  scoreBets,
  skepticCommand,
  validateBet,
};
