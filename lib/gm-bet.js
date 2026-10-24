'use strict';

// gm bet: one new, specific business move nobody wrote down yet, with a
// prediction, a check date, and exact steps. The owner taps "think" on the
// phone page; this module reads real local sources (each read is a progress
// event with one real fact), asks three writers at once for one bet each,
// checks each with plain rules and a skeptic as it lands, and keeps every bet
// in a ledger. "do it" turns the bet into a real atris mission.
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
  scoreboard: { what: "the owner's own number for this project, as he reports it on the phone; read from his first report on or after the check date", now: 'the last reported value', up: true },
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

// ---- the owner's scoreboard: the one number that says this project is going well ----

// Beside the ledger, one row per change: a pick (its name, which way is good,
// and how it is read) or a report of its value. The newest pick wins; its
// reports are the ones after it.
function scoreboardPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'gm-scoreboard.jsonl');
}

function readScoreboard(file, workspaceRoot) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let board = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.workspace !== workspaceRoot) continue;
    if (row.kind === 'pick' && row.name) board = { name: row.name, up: row.up !== false, source: row.source === 'installs' ? 'installs' : 'reported', at: row.at, reports: [] };
    else if (row.kind === 'report' && board && Number.isFinite(row.value)) board.reports.push({ value: row.value, at: row.at });
    // the owner stopped tracking it: no number until one is picked again
    else if (row.kind === 'clear') board = null;
  }
  return board;
}

// the best of the last 8 reports, once there are 3: the bar a goal must clear
const SCOREBOARD_REPORTS = 8;
const SCOREBOARD_MIN_REPORTS = 3;

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
    '- talk to him as "you", for example "changes you redid". never use his name, and never say "the owner".',
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

// The owner's first name, read at run time from deps or the workspace's git
// user, so a label a writer wrote about him by name reads to him as "you".
// Null when there is none to read, and then nothing is swapped.
function ownerFirstName(workspaceRoot, deps = {}) {
  if (deps.ownerName !== undefined) return deps.ownerName || null;
  try {
    const name = require('child_process').execFileSync('git', ['config', 'user.name'], { cwd: workspaceRoot, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\s+/)[0];
    return /^[A-Za-z][A-Za-z'-]{1,}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function toYou(label, name) {
  if (!name || typeof label !== 'string') return label;
  const esc = name.replace(/[-']/g, m => `\\${m}`);
  return label.replace(new RegExp(`\\b${esc}'s\\b`, 'gi'), 'your').replace(new RegExp(`\\b${esc}\\b`, 'gi'), 'you');
}

// ---- reading free text: is it a question back, an answer, an instruction? ----

const SAY_READ_MS = 15000;
const SAY_KINDS = new Set(['question', 'answer', 'instruction', 'unclear']);
// on the weekly number card, what an instruction wants done with the number
const NUMBER_INTENTS = new Set(['stop', 'change', 'later', 'other']);
const SAY_FALLBACK = 'say that another way, or tap a button.';
// the last turns of a card's conversation the reader sees
const THREAD_TURNS = 6;

// the roster's model for quick reads (its search job), on the subscription
function readerModel(workspaceRoot) {
  try {
    const team = require('./engine-registry').resolveJobTeam('search', workspaceRoot);
    const lead = team && team.lead;
    if (lead && (lead.id === 'claude' || lead.bin === 'claude') && lead.roster_model) return lead.roster_model;
  } catch {
    // no roster here
  }
  return 'haiku';
}

// One quick call: what kind of message the owner typed on the card on
// screen, and what to say back. The card, the conversation on it so far, and
// a short view of the project go in.
async function readSaid({ text, card, thread = [], hint = null, workspaceRoot, bundle = null, deps = {} } = {}) {
  const context = clip((deps.readContext || readProjectContext)(workspaceRoot), 1500);
  const goal = bundle && bundle.sources && bundle.sources.goal;
  const prompt = [
    'You read one short message the owner typed on a card in the app that runs his project, and say what kind it is.',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"kind": "question" | "answer" | "instruction" | "unclear", "reply": "..."}',
    '- question: he asks something back, like "what do you mean?" or "why?". reply: one or two plain sentences that say why the card asks this and give a concrete example from this project. read the conversation so far, so a follow-up builds on it.',
    '- answer: his words answer the card. reply: "".',
    '- instruction: he wants something done, or has a new idea. reply: one plain sentence saying what will happen next.',
    '- unclear: you cannot tell. reply: one short question back.',
    '- a message that ends with "?" or asks why, what, or how is a question back, never an answer.',
    '- you may add "suggestions": 0 to 3 short replies he could tap next, each under 40 characters, never one of the buttons already on the card.',
    card.kind === 'number' ? '- on this number card an instruction also has "intent": "stop" when he wants to stop tracking this number, "change" when he wants a different number, "later" when he wants to be asked another time, else "other". for "other", reply says what this card can do.' : '',
    `- plain lowercase-friendly words, no em dashes, and never these words: ${OWNER_BANNED_WORDS.join(', ')}.`,
    '- talk to him as "you", for example "changes you redid". never use his name, and never say "the owner".',
    '',
    `## the card on screen (${card.kind})`,
    card.title || '',
    card.detail || '',
    card.buttons && card.buttons.length ? `buttons: ${card.buttons.join(' / ')}` : '',
    '',
    '## the conversation on this card so far',
    ...(thread.length ? thread.map(t => `- ${t.who === 'owner' ? 'owner' : 'you'}: ${t.text}`) : ['- none yet']),
    '',
    `## his message: "${clip(text, 280)}"`,
    hint ? `note: ${hint}` : '',
    '',
    '## this project',
    goal && goal.horizon ? `goal: ${goal.horizon.text}` : '',
    context || '(no readme or goals found)',
  ].filter(l => l !== '').join('\n');
  const model = (deps.readerModel || readerModel)(workspaceRoot);
  const said = await (deps.runModel || runModel)(prompt, { cwd: workspaceRoot, timeoutMs: SAY_READ_MS, command: { bin: 'claude', args: p => claudeArgs(p, model) }, onProgress: () => {} });
  if (!said.ok) return { ok: false, reason: said.reason };
  const parsed = parseBet(said.text);
  const v = parsed.bet;
  if (!v || !SAY_KINDS.has(v.kind) || typeof v.reply !== 'string') return { ok: false, reason: 'the read was not the shape asked for' };
  const suggestions = Array.isArray(v.suggestions) ? v.suggestions.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  const intent = card.kind === 'number' && NUMBER_INTENTS.has(v.intent) ? v.intent : null;
  return { ok: true, kind: v.kind, reply: clip(v.reply, 280), ...(intent ? { intent } : {}), ...(suggestions.length ? { suggestions } : {}) };
}

// Two or three numbers that would tell the owner this project is going well,
// suggested from its own files. Each is a short plain name and which way is good.
async function generateScoreboardChoices({ workspaceRoot, bundle = null, deps = {}, ledgerFile, today = dayKey(Date.now()) } = {}) {
  const b = bundle || await readBundle(workspaceRoot, { deps, ledgerFile, today });
  const context = (deps.readContext || readProjectContext)(workspaceRoot);
  const prompt = [
    'You help the owner of this project pick the one number that tells him it is going well. Below is what its own files say.',
    'Suggest 2 or 3 such numbers for THIS project, the kind he would check each week. For example: a web app, "people who used it this week"; a research lab, "experiments that worked"; a fund, "returns this month"; a journal, "days you wrote".',
    'Answer with strict JSON only, no prose and no code fence: {"choices": [{"name": "...", "up": true}]}',
    '- name: a short plain phrase under 40 characters. up: true when higher is better, false when lower is better.',
    `- never use these words: ${OWNER_BANNED_WORDS.join(', ')}.`,
    '- talk to him as "you", for example "changes you redid". never use his name, and never say "the owner".',
    '',
    "## this project's files",
    context || '(no readme or goals found)',
    '',
    bundleText(b),
  ].join('\n');
  const said = await (deps.runModel || runModel)(prompt, { cwd: workspaceRoot, onProgress: () => {} });
  if (!said.ok) return { ok: false, reason: said.reason };
  const parsed = parseBet(said.text);
  const list = parsed.bet && Array.isArray(parsed.bet.choices) ? parsed.bet.choices : [];
  const choices = list
    .filter(c => c && typeof c.name === 'string' && c.name.trim() && c.name.trim().length <= 40 && !ownerWord(c.name) && !PROCESS_TALK.test(c.name))
    .slice(0, 3)
    .map(c => ({ name: c.name.trim(), up: c.up !== false }));
  return choices.length >= 2 ? { ok: true, choices } : { ok: false, reason: 'fewer than two usable numbers' };
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

function defaultFetchJson(url, { timeoutMs = 10000, signal = null } = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'atris-gm-bet' }, ...(signal ? { signal } : {}) }, (res) => {
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

// ---- the team page's cells --------------------------------------------------------

// what a cell shows when there is nothing true to put in it
const NO_RATING = '\u00b7\u00b7';

// role, description, type, and parked from one member's MEMBER.md
// frontmatter. A card with neither role nor description gives a "role:"
// line in its body, else its first plain paragraph.
function memberCardFacts(workspaceRoot, name) {
  let text = '';
  try { text = fs.readFileSync(path.join(workspaceRoot, 'atris', 'team', name, 'MEMBER.md'), 'utf8'); } catch { text = ''; }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const head = block ? block[1] : '';
  const field = k => ((new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(head) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
  let role = field('role');
  const description = field('description');
  if (!role && !description) {
    const body = block ? text.slice(block[0].length) : text;
    const line = /^role:\s*(.+)$/im.exec(body);
    const para = body.split(/\r?\n\s*\r?\n/).map(x => x.trim()).find(x => x && !/^[#>|`-]/.test(x));
    role = line ? line[1].trim() : (para || '');
  }
  return { role, description, type: field('type'), parked: require('./member-park').isParkedText(text) };
}

// A role in a few words: up to its first full stop or colon, title-case
// words lowercased (a name like CEO or YouTube keeps its letters), at most
// six words.
function roleWords(text) {
  const first = String(text || '').split(/[.;:!?](?:\s|$)/)[0].replace(/\s+[-\u2013]\s+/g, ', ').trim();
  const words = first.split(/\s+/).filter(Boolean).map(w => (/^\(?[A-Z][a-z'\u2019]*[,)]?$/.test(w) ? w.toLowerCase() : w));
  if (!words.length) return NO_RATING;
  return words.length > 6 ? `${words.slice(0, 6).join(' ').replace(/[,\s]+$/, '')}\u2026` : words.join(' ');
}

// The role cell for one card: its role, unless that only says the member's
// own name ("builder" for builder), then its description.
function memberRoleWords(name, card) {
  const plain = w => String(w || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const role = roleWords(card.role || card.description);
  if (card.description && plain(role) === plain(name)) return roleWords(card.description);
  return role;
}

// The tool and its exact model, the tool id then the roster's own label for
// the model, from a member's resolved pick. Only a pinned model counts: a
// tool alone is not a model.
function engineWords(picked) {
  const id = picked && picked.engine && picked.engine.id;
  const model = picked && picked.model;
  if (!id || !model) return NO_RATING;
  const label = String(require('./engine-registry').rosterModelLabel(model) || model).trim();
  return label.toLowerCase().startsWith(`${String(id).toLowerCase()} `) ? label : `${id} ${label}`;
}

// One plain sentence: the status, what it is on, and for how long.
function statusSentence(row) {
  if (!row || !row.on) return row && row.time ? `${row.status}, ${row.time}` : `${(row && row.status) || 'idle'}: no work in the last day`;
  const on = /^[A-Z][a-z]/.test(row.on) ? row.on[0].toLowerCase() + row.on.slice(1) : row.on;
  return `${row.status}: ${on}, ${row.time}`;
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
async function defaultReadMetric(metric, { workspaceRoot, start, end, target = {}, deps = {}, ledgerFile = null }) {
  if (metric === 'scoreboard') {
    const board = readScoreboard(scoreboardPath(path.dirname(ledgerFile || ledgerPath())), workspaceRoot);
    const hit = board && board.reports.find(r => String(r.at).slice(0, 10) >= end);
    return hit ? { value: hit.value } : { error: 'the owner has not reported the number for this date yet', transient: true };
  }
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
function wonBet(metric, actual, goal, target = {}) {
  const up = metric === 'scoreboard' ? target.up !== false : METRICS[metric].up;
  return up ? actual >= goal : actual <= goal;
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
        out = await read(metric, { workspaceRoot, start, end, target: t, deps, ledgerFile });
      } catch (err) {
        out = { error: String((err && err.message) || err), transient: true };
      }
    }
    if (!out || !Number.isFinite(out.value)) {
      const why = (out && out.error) || 'the number could not be read';
      if (out && out.transient && late <= SCORE_GRACE_DAYS) continue;
      Object.assign(row, { status: 'unreadable', why });
    } else {
      const window = metric === 'installs' ? `${start} to ${end}` : (metric === 'scoreboard' ? `reported on or after ${end}` : `landed by the end of ${end}, of ${plural(t.job_ids.length, 'job')} waiting at the start`);
      Object.assign(row, { status: wonBet(metric, out.value, t.goal, t) ? 'won' : 'lost', actual: out.value, window });
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
  if (s.scoreboard) {
    out.scoreboard = { baseline: s.scoreboard.baseline, best: s.scoreboard.best, reports: s.scoreboard.reports, up: s.scoreboard.up, name: s.scoreboard.name };
  } else if (s.installs) {
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
// The value of p, or late() once the deadline passes or the signal stops it
// first; p then goes on alone with its errors dropped. With no deadline it is
// just p. The timer is cleared on every way out, and unref'd as a backstop,
// so it never holds the process open.
function byDeadline(p, deadline, late, signal = null) {
  const work = Promise.resolve(p);
  if (!deadline) return work;
  let timer;
  let onStop = null;
  const cut = new Promise((resolve) => {
    const give = () => { clearTimeout(timer); work.catch(() => {}); resolve(late()); };
    timer = setTimeout(give, Math.max(0, deadline - Date.now()));
    if (timer.unref) timer.unref();
    if (signal) {
      if (signal.aborted) give();
      else { onStop = give; signal.addEventListener('abort', onStop, { once: true }); }
    }
  });
  return Promise.race([work, cut]).finally(() => {
    clearTimeout(timer);
    if (onStop) signal.removeEventListener('abort', onStop);
  });
}

// deadline (ms since 1970, optional): the sources are read by then. Scoring
// past bets and each npm read that is still going at the deadline are left
// out (scoring finishes on its own), so a slow network never eats the time
// the writers need.
// signal (optional): a stop ends the waits at once, and the npm reads with them.
async function readBundle(workspaceRoot, { deps = {}, emit = () => {}, ledgerFile, today = dayKey(Date.now()), deadline = null, signal = null } = {}) {
  const ledger = ledgerFile || ledgerPath();
  const LATE = Symbol('late');
  try {
    const scored = await byDeadline((deps.scoreBets || scoreBets)(workspaceRoot, { ledgerFile: ledger, today, deps, emit }), deadline, () => LATE, signal);
    if (scored === LATE) emit({ kind: 'skip', key: 'score', line: 'scoring past bets took too long, so it finishes on its own' });
  } catch {
    // scoring is a side job; a failure never blocks the next bet
  }
  // an npm read gets what is left before the deadline, at most its usual 10 seconds
  const fetchOpts = () => (deadline ? { timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())), ...(signal ? { signal } : {}) } : undefined);
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
      const url = `https://api.npmjs.org/downloads/range/last-year/${npmName(pkg)}`;
      installBody = await byDeadline(fetchOpts() ? fetchJson(url, fetchOpts()) : fetchJson(url), deadline, () => LATE, signal);
      if (installBody === LATE) throw new Error('npm took too long');
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
      const url = `https://registry.npmjs.org/${npmName(pkg)}/latest`;
      const latest = await byDeadline(fetchOpts() ? fetchJson(url, fetchOpts()) : fetchJson(url), deadline, () => null, signal);
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

  // the owner's own number: a reported one is the target, with the last
  // report as the baseline; an installs one keeps the npm numbers
  const board = readScoreboard(scoreboardPath(path.dirname(ledger)), workspaceRoot);
  if (board && board.source === 'reported' && board.reports.length) {
    const last = board.reports[board.reports.length - 1];
    const recent = board.reports.slice(-SCOREBOARD_REPORTS).map(r => r.value);
    const best = recent.length >= SCOREBOARD_MIN_REPORTS ? (board.up ? Math.max(...recent) : Math.min(...recent)) : null;
    add('scoreboard', `${board.name}: last reported ${commas(last.value)} on ${String(last.at).slice(0, 10)}`, { name: board.name, up: board.up, baseline: last.value, best, reports: recent.length });
  } else if (board) {
    bundle.sources.scoreboard_pick = { name: board.name, up: board.up, source: board.source };
  }

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
  if (s.scoreboard) parts.push('', "## the owner's scoreboard", `- ${s.scoreboard.name} (${s.scoreboard.up ? 'higher' : 'lower'} is better); last reported ${commas(s.scoreboard.baseline)}`);
  else if (s.scoreboard_pick) parts.push('', "## the owner's scoreboard", `- ${s.scoreboard_pick.name} (${s.scoreboard_pick.up ? 'higher' : 'lower'} is better), read from ${s.scoreboard_pick.source === 'installs' ? 'npm installs' : 'his reports'}`);
  if (s.focus) parts.push('', '## what the owner asked for', ...s.focus.answers.map(a => `- ${a.ask} ${a.label} (said ${String(a.at).slice(0, 10)})`));
  return parts.join('\n');
}

// ---- the prompt ----------------------------------------------------------------------

// The bar a goal has to clear, in words, for the prompt and the reject reason.
function goalBar(metric, m) {
  if (metric === 'scoreboard') {
    const dir = m.up ? 'above' : 'below';
    return m.best == null
      ? `with fewer than ${SCOREBOARD_MIN_REPORTS} reports any honest goal ${dir} the baseline ${commas(m.baseline)} passes`
      : `the best of the last ${m.reports} reports was ${commas(m.best)}, so the goal must be ${dir} ${commas(m.best)}`;
  }
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
    if (k === 'scoreboard') return `"scoreboard" (${m[k].name}, the owner's own number; baseline ${m[k].baseline}; ${goalBar(k, m[k])})`;
    return `"${k}" (${METRICS[k].what}; baseline ${m[k].baseline}; ${goalBar(k, m[k])})`;
  });
}

function buildPrompt(bundle, { today, previousTitle = null, reason = null, previousAnswer = null, blocker = null, avoidTitles = [], reworkOf = null, ownerNote = null, angle = null, concern = null } = {}) {
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
    '- never propose a trade, buying or selling stocks, shares, crypto, or any security, or moving money between accounts.',
  ];
  lines.push(`- title, why_now, and expect are read by the owner, so they never use these words: ${OWNER_BANNED_WORDS.join(', ')}. say "idea" or a plain verb instead of bet, and say what changes for people, not how we work.`);
  if (bundle.sources && bundle.sources.focus) lines.push('- the bet must serve what the owner asked for (the last section below). when answers pull different ways, the newest wins.');
  // a skeptic named what blocks the last idea: the blocker is the next bet,
  // not one more step on the old idea
  if (blocker) lines.push('', `The last idea ("${clip(blocker.title, 120)}") is blocked by: ${blocker.missing_first.replace(/[.\s]+$/, '')}. Don't patch that idea. Make clearing this blocker the bet, as big as this team can do in the window, with its own target. The blocker stops being a step and becomes the whole move. If the blocker is team plumbing (a release, a merge, a review, a fix to the build or a count), it is never the bet: keep a business move and put the plumbing in as one step.`);
  if (previousTitle) lines.push('', `Make it sharper, more specific, and different from: ${previousTitle}`);
  // the owner asked to sharpen an idea a second look worried about
  if (previousTitle && concern) lines.push(`A second look at that idea worried: ${clip(String(concern).replace(/[.\s]+$/, ''), 240)}. The new idea must answer that worry.`);
  // each writer in the swarm leans a different way, so the drafts differ
  if (angle) lines.push('', angle);
  // what the owner typed on a card
  if (ownerNote && reworkOf) lines.push('', `The owner read the idea "${clip(reworkOf, 160)}" and said: "${clip(ownerNote, 280)}". Rework it so it fits what they said; it may keep the same deliverable.`);
  else if (ownerNote) lines.push('', `The owner said: "${clip(ownerNote, 280)}". The next idea must fit that.`);
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

// The writer and the skeptic think briefly: on the real prompt, low effort
// answered in 17 to 19 seconds against 21 at the default, and its answers
// passed the plain-rule checks.
const IDEA_EFFORT = 'low';
function writerCommand() {
  return { bin: 'claude', args: p => [...claudeArgs(p, MODEL), '--effort', IDEA_EFFORT] };
}

// The writer and the skeptic get every fact in the prompt, so they run in an
// empty folder of their own: started in the workspace, the model also loads
// that project's agent instructions and memory, about 11,000 tokens nobody
// asked for, and its first word came 10 seconds later (measured).
function quietDir() {
  const dir = path.join(require('os').tmpdir(), 'atris-gm-ideas');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the model can still start in a missing folder's parent */ }
  return dir;
}

// Runs the model in its own process group. On timeout the whole group is
// killed, so nothing it started keeps running. Streams real progress (tokens
// thought, characters written) through onProgress.
// Writers running now, by process group, so the server can end them when it
// stops; otherwise a stopped server leaves them running on their own.
const LIVE_WRITERS = new Map();

// SIGTERM now, then SIGKILL for the same groups after the grace, so a child
// that ignores SIGTERM does not outlive the server either.
function stopWriters() {
  let n = 0;
  const groups = [...LIVE_WRITERS];
  for (const [pid, kill] of groups) {
    try { kill(-pid, 'SIGTERM'); n += 1; } catch { /* already gone */ }
  }
  LIVE_WRITERS.clear();
  if (groups.length) {
    const t = setTimeout(() => {
      for (const [pid, kill] of groups) {
        try { kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, STOP_GRACE_MS);
    if (t.unref) t.unref();
  }
  return n;
}

// A signal (an AbortSignal) stops the call early: the whole process group
// gets SIGTERM, then SIGKILL if it is still there after STOP_GRACE_MS, and
// the call resolves once the process is gone, so nothing it started is left.
const STOP_GRACE_MS = 1500;
const STOPPED_REASON = 'stopped: another idea was picked first';

function runModel(prompt, { command = { bin: 'claude', args: claudeArgs }, cwd, timeoutMs = MODEL_TIMEOUT_MS, env = process.env, onProgress = () => {}, spawnFn = require('child_process').spawn, kill = process.kill.bind(process), signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve({ ok: false, reason: STOPPED_REASON, stopped: true });
      return;
    }
    const args = typeof command.args === 'function' ? command.args(prompt) : [...(command.args || []), prompt];
    let child;
    try {
      child = spawnFn(command.bin, args, { cwd, env: modelEnv(env), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, reason: `could not start the model: ${err.message}` });
      return;
    }
    if (child && child.pid) LIVE_WRITERS.set(child.pid, kill);
    let buf = '';
    let size = 0;
    let stderr = '';
    let text = '';
    let result = null;
    let thinking = 0;
    let timedOut = false;
    let stopped = false;
    let hardKill = null;
    let done = false;
    const killGroup = (sig) => {
      try {
        kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutMs);
    // The SIGKILL for the group always fires after the grace, even when the
    // model itself has exited by then: a child it started with its own
    // stdio can ignore SIGTERM and outlive it, so the group is tracked (and
    // the timer kept alive) until that kill has gone out.
    const onAbort = () => {
      if (done || stopped) return;
      stopped = true;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => {
        killGroup('SIGKILL');
        if (LIVE_WRITERS.get(child.pid) === kill) LIVE_WRITERS.delete(child.pid);
      }, STOP_GRACE_MS);
      // it fires while the process lives, and never holds it open on its own
      if (hardKill.unref) hardKill.unref();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
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
      if (signal) signal.removeEventListener('abort', onAbort);
      // a stopped call keeps its SIGKILL and its place in LIVE_WRITERS until
      // the grace is over; every other call is finished with its group
      if (!stopped) LIVE_WRITERS.delete(child.pid);
      resolve(out);
    };
    child.on('error', err => finish({ ok: false, reason: `could not start the model: ${err.message}` }));
    child.on('close', (code) => {
      if (buf) line(buf);
      if (stopped) return finish({ ok: false, reason: STOPPED_REASON, stopped: true });
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

// What a yes is for, as the owner reads it. A plain ask stays as written. A
// held command, a handed-off job's own or one between backticks in an ask,
// is said in words that keep its verb and its target: create or delete,
// which release, which pull request, which branch, which repo. One that
// cannot be said exactly says where it goes and shows what it names, and
// never gets a friendlier verb.
const ASK_TOOLS = { gh: 'GitHub', git: 'the git remote', npm: 'npm', pnpm: 'npm', yarn: 'npm', npx: 'npm', atris: 'Atris', curl: 'a web service', vercel: 'Vercel' };

function plainAsk(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const tick = /`([^`]+)`/.exec(t);
  const handed = /^(.{3,80}?\bwants to) (\S+)(.*)$/.exec(t);
  let lead = null;
  let cmd = '';
  if (tick) cmd = tick[1].trim();
  else if (handed && ASK_TOOLS[handed[2]]) { lead = handed[1]; cmd = `${handed[2]}${handed[3]}`.trim(); }
  const words = cmd.split(' ').filter(Boolean);
  if (!words.length || !ASK_TOOLS[words[0]]) return t;
  // the guard keeps the first 120 characters: a cut command is never said in words
  const exact = cmd.length < 120 ? require('./yes-lock').describeCommand(words) : null;
  const what = exact || `run a command that changes ${ASK_TOOLS[words[0]]}: "${words.slice(1).join(' ')}"`;
  return lead ? `${lead} ${what}` : `ok to ${what}?`;
}

// A job's work as plain words: code spans and flags are dropped, a path or
// a file name reads "a file", and a command left bare goes. When too little
// is left to read, it is the member's job.
function plainWork(text, member) {
  const t = String(text || '');
  if (!STEP_CODE.some(re => re.test(t))) return t;
  const kept = t.replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(w => w && !/^--?[a-z]/i.test(w))
    .map(w => (/\/|\.(js|ts|tsx|sh|md|json|py|yml|yaml|txt|html|css|jsonl)\b/i.test(w) ? 'a file' : w))
    .join(' ')
    .replace(/\b(npm|npx|git|node|gh|atris)\s+[a-z-]+\b/gi, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return kept.split(' ').length >= 3 && !STEP_CODE.some(re => re.test(kept)) ? kept : `a job for ${member}`;
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
  } else if (metric === 'scoreboard') {
    const better = (a, b) => (known.up ? a > b : a < b);
    const dir = known.up ? 'above' : 'below';
    if (known.best != null && !better(target.goal, known.best)) out.push(`target goal ${commas(target.goal)} does not beat the best of the last ${known.reports} reports, ${commas(known.best)}; the goal must be ${dir} ${commas(known.best)}`);
    else if (known.best == null && !better(target.goal, real)) out.push(`target goal ${commas(target.goal)} must be ${dir} the baseline ${commas(real)}`);
  } else if (metric === 'queue_landed') {
    if (known.real === 0) out.push(known.waiting === 0 ? 'nothing is waiting on review, so there is no queue to land; pick another metric' : `none of the ${commas(known.waiting)} waiting jobs has real work behind it, so none can land; pick another metric`);
    else if (target.goal < known.least) out.push(`target goal ${commas(target.goal)} does not land half the waiting jobs with real work: ${commas(known.real)} have real work, so the goal must be at least ${commas(known.least)}`);
    else if (target.goal > known.real) out.push(`target goal ${commas(target.goal)} is more than the ${commas(known.real)} waiting jobs with real work`);
  }
  return out;
}

// a trade, buying or selling a security, or moving money: never an idea
const TRADE = /\b(buy|sell|short|trade|trading)\b[^.]{0,40}\b(stocks?|shares|securit(?:y|ies)|options|crypto|bitcoin|tokens|bonds?|etfs?|index fund|positions?)\b|\b(wire|transfer|move|send)\b[^.]{0,30}\b(money|funds|cash)\b[^.]{0,30}\b(account|brokerage|bank|wallet)\b/i;

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
  const allText = [str('title'), str('why_now'), str('expect'), ...(Array.isArray(bet.steps) ? bet.steps.map(st => `${st && st.text} ${st && st.detail}`) : [])].join(' . ');
  if (TRADE.test(allText)) reasons.push('it proposes a trade or moving money; ideas never do that');
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
  if (target.metric === 'scoreboard') return `goal ${commas(target.goal)}, last reported ${commas(target.baseline)}`;
  if (target.metric === 'queue_landed') return `goal ${commas(target.goal)} of the ${commas(target.job_ids.length)} jobs with work landed`;
  if (known && known.best !== null) return `goal ${commas(target.goal)}, best week in ${bestSpan(known.weeks)} ${commas(known.best)}`;
  return `goal ${commas(target.goal)}, ${commas(target.baseline)} last week`;
}

function cleanBet(bet, today, bundle) {
  const target = { metric: bet.target.metric, baseline: bet.target.baseline, goal: bet.target.goal };
  // the jobs waiting right now, kept with the bet: only these can count
  if (target.metric === 'queue_landed') target.job_ids = [...bundleMetrics(bundle).queue_landed.ids];
  // the owner's number keeps its name and which way is good, for scoring later
  if (target.metric === 'scoreboard') Object.assign(target, { name: bundleMetrics(bundle).scoreboard.name, up: bundleMetrics(bundle).scoreboard.up });
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

// Every model attempt, writer and skeptic (the kind field), is kept (raw
// answer, parse result, reasons, timing), so a failed live run can be read
// back afterwards. generateBet (the swarm, below) writes them.
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
//
// The bar is the inner scorecard: the team is judged only on what it controls
// and can check. A pass needs every team step to be work the team can do and
// see done, and the move to push the number the right way this week. It does
// not have to reach the goal: one idea cannot add a whole week's target, and
// the old bar (from the baseline to the goal) turned down all of the last 82
// drafts it judged, so every tap waited and then got nothing.
function buildSkepticPrompt(bet, bundle, { today } = {}) {
  return [
    'You are a skeptical cofounder. Someone else proposed the bet below for this week. Your job is to catch it if it does not make sense, before the team spends a week on it.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"verdict": "pass", "doable": true, "moves_metric": true, "missing_first": "...", "reason": "...", "concern": "..."}',
    '',
    'The team is judged only on what it controls and can check. Judge it that way, against the facts below:',
    '- doable: is every team step work the team can do on its own this week, and check once it is done (a page that exists, a post drafted, a demo recorded, a test that passes)? steps for "you" wait for the owner\'s yes and are fine. a team step that only happens if strangers act is not doable.',
    '- moves_metric: if every step is done, would it plausibly push the target number the right way this week (target.metric: installs are read over the 7 days that end on the check date; queue_landed counts only the waiting jobs with real work when the bet was made (target.job_ids; placeholders with no check are left out) that land, accepted or merged, by the check date, and a closed, dropped, or parked job counts zero)? it does not have to reach target.goal; the goal is the hope, not the bar, so never fail it only because the goal is ambitious. a post does not move installs if the thing it shows is not installable yet, and work nobody outside sees does not move installs at all.',
    '- missing_first: what must be true first and is not, and is not already a step: an unpublished feature (see the release fact), a page or command that does not exist, no audience that would see it. write "nothing" when nothing is missing.',
    '- would a sharp founder reading this find it obviously wrong, padded, or a waste of the week?',
    '- does it propose a trade, buying or selling stocks, shares, crypto, or any security, or moving money between accounts: fail it.',
    '- is the deliverable internal plumbing (a release, a review queue, merging or unsticking jobs, test speed, fixing a count or a dashboard)? that is the team\'s job and never an owner bet, so fail it. plumbing as one step inside a business move is fine.',
    'verdict is "pass" when doable and moves_metric are both true, nothing is missing that the steps do not cover, it is not obviously wrong, and it is not plumbing. otherwise "fail".',
    'reason: one or two plain sentences under 240 characters. if the missing piece is something the team or the owner could do, name the step to add.',
    `concern: when it fails, the worry in one plain everyday line under 120 characters for the owner, who reads it on the card; never these words: ${OWNER_BANNED_WORDS.join(', ')}. "" when it passes.`,
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
      // doable and concern are newer; an answer without them still counts
      ...(typeof v.doable === 'boolean' ? { doable: v.doable } : {}),
      ...(typeof v.concern === 'string' && v.concern.trim() ? { concern: clip(v.concern.trim(), 200) } : {}),
    },
  };
}

function skepticCommand() {
  return { bin: 'claude', args: p => [...claudeArgs(p, SKEPTIC_MODEL), '--effort', IDEA_EFFORT] };
}

// A pass needs the verdict and the skeptic's own yes on moving the number,
// and never a no on whether the team can do and check every step.
function skepticPassed(v) {
  return v.verdict === 'pass' && v.moves_metric === true && v.doable !== false;
}

// What the skeptic said must be true first, or null when it said nothing is.
function blockerOf(v) {
  const m = String((v && v.missing_first) || '').trim();
  return m && !/^(nothing|none|n\/a)\.?$/i.test(m) ? m : null;
}

function skepticReason(v) {
  const missing = blockerOf(v) ? ` missing first: ${v.missing_first.replace(/[.\s]+$/, '')}.` : '';
  const moves = v.moves_metric ? '' : ' it would not move the target number.';
  const doable = v.doable === false ? ' a team step is not work the team can do and check on its own.' : '';
  return `a skeptic turned it down: ${v.reason.replace(/[.\s]+$/, '')}.${moves}${doable}${missing} if the missing piece is something we can do, add it as a step (a release, or anything public, is a step for "you")`;
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

// ---- the swarm: several writers at once -----------------------------------------------

// Three writers start at once, each leaning a different way, and every draft
// is checked the moment it lands: the plain rules in code, then the skeptic,
// while the other writers keep going. The first draft that passes both is the
// idea, and every call still running is stopped. Nothing waits past the
// budget: when it runs out, the best draft so far is the idea, with the
// skeptic's worry in one plain line. Measured on the real prompt, one writer
// took 17 to 27 seconds and one skeptic 9 to 20, and one writer after another
// with its skeptic took over two minutes across three tries.
const SWARM_WRITERS = 3;
const SWARM_BUDGET_MS = 30000;
// reading the facts gets the first quarter of it; anything slower is left out
const SOURCES_SHARE = 0.25;
// a call that cannot finish inside the budget is not started: a writer needs
// about 40% of it, a skeptic about 13% (the shares of a 30 second budget)
const WRITE_MIN_LEFT_MS = 12000;
const JUDGE_MIN_LEFT_MS = 4000;
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
// each writer leans a different way; any project has these three doors
const WRITER_ANGLES = [
  { key: 'reach', text: 'Lean toward reach: put something real in front of new people who would want it and do not know it exists yet.' },
  { key: 'first_hour', text: 'Lean toward the people already here: make their first hour better, so more of them stay, come back, or tell someone.' },
  { key: 'proof', text: 'Lean toward proof: one small thing people can see, try, or copy this week that shows what this does.' },
];

// What the waiting card says while the drafts are written, in the owner's
// words: each event that carries say is one line the page can show.
const SWARM_SAY = {
  drafting: n => (n === 1 ? 'drafting an idea' : `drafting ${COUNT_WORDS[n] || n} ideas at once`),
  checking: k => `the ${ORDINALS[k - 1] || 'next'} draft is in. checking it`,
  redraft: 'one draft missed a rule. redrafting it',
  shorten: 'one draft ran long. shortening it',
  heldUp: 'found one that holds up',
  notHeld: 'that one did not hold up. still working',
  outOfTime: 'out of time. bringing the best one so far',
  nothing: 'nothing usable came back this time',
};

// The best draft when none passed: one the skeptic only had small doubts
// about first, then one it had no time to look at, then the rest, oldest
// first within each.
function draftRank(c) {
  if (!c.verdict) return 1;
  const v = c.verdict;
  if (v.moves_metric === true && v.doable !== false && !blockerOf(v)) return 0;
  return 2 + (v.moves_metric === true ? 0 : 2) + (v.doable === false ? 1 : 0) + (blockerOf(v) ? 1 : 0);
}

// The skeptic's worry as one line the owner reads on the card: its own
// concern, else the first sentence of its reason, when that is plain words
// with none of our own; otherwise a plain line that says what kind of worry.
const CONCERN_MAX = 140;
function ownerConcern(c) {
  if (!c.verdict) return c.unjudged && !/no time left/.test(c.unjudged) ? 'not double-checked: the second look did not finish.' : 'not double-checked yet: it came in as time ran out.';
  const v = c.verdict;
  const first = String(v.reason || '').split(/(?<=[.!?])\s+/)[0];
  const said = String(v.concern || first || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  const plain = said && said.length <= CONCERN_MAX - 12 && !ownerWord(said) && !/\u2014/.test(said) && !STEP_CODE.some(re => re.test(said));
  if (plain) return `one worry: ${said.charAt(0).toLowerCase()}${said.slice(1)}.`;
  if (v.moves_metric !== true) return 'one worry: it may not move your number much this week.';
  if (v.doable === false) return 'one worry: one step depends on people outside the team.';
  if (blockerOf(v)) return 'one worry: something has to be in place before it can work.';
  return 'one worry: it may not be the best use of this week.';
}

// Reads the sources, then runs the swarm. Resolves { ok: true, bet, bundle,
// checked: true } for a draft both checks passed; { ok: true, bet (with
// concern), checked: false } for the best draft when none passed in the
// budget; { ok: false, reason } only when no draft met the plain rules at
// all; { ok: false, stopped: true } when the signal stopped it first.
// writers: how many at once (tests pass 1 to walk one writer's retries).
// Every model attempt, writer and skeptic (the kind field), with its lane, is
// kept in the attempts log, the stopped ones too.
async function generateBet({ workspaceRoot, today, previousTitle = null, avoidTitles: avoidIn = [], reworkOf = null, ownerNote = null, concern = null, emit = () => {}, onBundle = () => {}, deps = {}, ledgerFile, attemptsFile, allowTeamMetrics = false, writers = deps.writers || SWARM_WRITERS, budgetMs = deps.budgetMs || SWARM_BUDGET_MS, signal = null } = {}) {
  // the budget runs on the real clock, the one the stop timer uses
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();
  const writeMin = Math.min(WRITE_MIN_LEFT_MS, budgetMs * (WRITE_MIN_LEFT_MS / SWARM_BUDGET_MS));
  const judgeMin = Math.min(JUDGE_MIN_LEFT_MS, budgetMs * (JUDGE_MIN_LEFT_MS / SWARM_BUDGET_MS));
  // a rework may stay close to the idea it reworks
  const avoidTitles = reworkOf ? avoidIn.filter(t => t !== reworkOf) : avoidIn;
  const run = deps.runModel || ((prompt, opts) => runModel(prompt, { ...opts, command: writerCommand() }));
  // tests pass runSkeptic; a stubbed runModel without one is also used for the
  // skeptic, so a test can never reach the real model by accident
  const judge = deps.runSkeptic || deps.runModel || ((prompt, opts) => runModel(prompt, { ...opts, command: skepticCommand() }));
  const clock = deps.now || Date.now;
  const cwd = deps.runModel ? workspaceRoot : quietDir();
  const n = Math.max(1, Math.floor(Number(writers)) || 1);
  const MODEL_LINES = { first: 'asking the model for one bet', patch: 'asking again with the reasons', blocker: 'asking again: clearing the blocker is the new bet', trim: 'asking for the same bet, shorter' };

  // the swarm's shared state, set up before anything is read so the budget
  // and a stop cover the reading too: the drafts that met the rules, why each
  // lane ended, and the calls still running, so one stop ends them all
  const drafts = [];
  const ends = [];
  const live = new Set();
  let turnedDown = 0;
  let checking = 0;
  let winner = null;
  let over = null;
  let release;
  const ended = new Promise((resolve) => { release = resolve; });
  const stop = (why) => {
    if (over) return;
    over = why;
    for (const ac of live) ac.abort();
    live.clear();
    release();
  };
  if (signal && signal.aborted) stop('stopped');
  const onSignal = () => stop('stopped');
  if (signal && !over) signal.addEventListener('abort', onSignal, { once: true });
  const timer = setTimeout(() => stop('budget'), Math.max(0, left()));
  // the reading's waits end with the swarm, on every way out
  const readStop = new AbortController();
  const finish = (out) => {
    clearTimeout(timer);
    readStop.abort();
    if (signal) signal.removeEventListener('abort', onSignal);
    return out;
  };

  // the facts, read in the first share of the budget: whatever is still
  // slow by then is left out, so the writers keep the time they need
  const reading = readBundle(workspaceRoot, { deps, emit, ledgerFile, today, deadline: Date.now() + budgetMs * SOURCES_SHARE, signal: readStop.signal });
  reading.catch(() => {});
  let bundle;
  try {
    bundle = await Promise.race([reading, ended.then(() => null)]);
  } catch (err) {
    finish();
    throw err;
  }
  if (over === 'stopped') return finish({ ok: false, stopped: true, reason: 'stopped before an idea was picked' });
  if (!bundle) return finish({ ok: false, reason: `the facts took longer than ${Math.round(budgetMs / 1000)} seconds to read` });
  // the desk builds its question cards from these facts while the model works
  try { onBundle(bundle); } catch { /* the desk's copy is a convenience */ }

  // one model call the swarm can stop; none starts once the budget is spent,
  // even when the stop timer has not had its turn yet
  async function call(fn, prompt, opts) {
    if (over || left() <= 0) return { ok: false, reason: 'the time for this idea ran out', stopped: true };
    const ac = new AbortController();
    live.add(ac);
    try {
      return await fn(prompt, { ...opts, signal: ac.signal });
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    } finally {
      live.delete(ac);
    }
  }

  async function lane(index) {
    const laneNo = index + 1;
    const angle = n > 1 ? WRITER_ANGLES[index % WRITER_ANGLES.length] : null;
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
    const tag = { lane: laneNo, ...(angle ? { angle: angle.key } : {}) };

    // one writer call and its code check, saved to the attempts log
    async function ask(prompt, attempt, how, avoid) {
      let lastSaid = 0;
      const started = clock();
      const answer = await call(run, prompt, {
        cwd,
        onProgress: ({ text = '' }) => {
          if (over) return;
          const at = clock();
          if (at - lastSaid < 1200) return;
          lastSaid = at;
          const w = wordCount(text);
          emit({ kind: 'thinking', line: w ? `thinking... ${commas(w)} words written` : 'thinking...', n: w, lane: laneNo });
        },
      });
      const base = { at: new Date(clock()).toISOString(), workspace: workspaceRoot, today, attempt, strategy: how, ...tag, ...(how === 'blocker' ? { blocker: blocker.missing_first } : {}), previous_title: previousTitle, avoid_titles: avoid.length, ms: clock() - started };
      if (!answer.ok) {
        saveAttempt(attemptsFile, { ...base, kind: 'writer', model_ok: false, ...(answer.stopped ? { stopped: true } : {}), raw: null, parse: null, passed: false, reasons: [answer.reason] });
        return { failed: answer.reason, stopped: Boolean(answer.stopped), base };
      }
      const parsed = parseBet(answer.text);
      const check = parsed.error ? { ok: false, reasons: [parsed.error], formatOnly: false } : validateBet(parsed.bet, { bundle, today, previousTitle, avoidTitles: avoid, allowTeamMetrics });
      return { parsed, check, base, raw: answer.text };
    }
    const save = r => saveAttempt(attemptsFile, { ...r.base, kind: 'writer', model_ok: true, raw: String(r.raw).slice(0, 20000), parse: r.parsed.error || 'ok', passed: r.check.ok, reasons: r.check.reasons });

    for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
      if (over) return;
      // a writer that cannot finish inside the budget is never started, the first one included
      if (left() < writeMin) { ends.push({ lane: laneNo, out_of_time: true, reason }); return; }
      emit({ kind: 'model', line: MODEL_LINES[strategy], ...tag });
      // a blocked idea is not shown again as a patch
      const avoid = [...avoidTitles, ...blocked];
      const angleText = angle ? angle.text : null;
      const prompt = strategy === 'blocker'
        ? buildPrompt(bundle, { today, previousTitle, blocker, avoidTitles: avoid, reworkOf, ownerNote, angle: angleText, concern })
        : buildPrompt(bundle, { today, previousTitle, reason, previousAnswer, avoidTitles: avoid, reworkOf, ownerNote, angle: angleText, concern });
      let r = await ask(prompt, attempt, strategy, avoid);
      if (over) return;
      if (r.failed) { ends.push({ lane: laneNo, model_failed: true, reason: r.failed }); return; }
      save(r);

      // only length or sentence limits broken: one free trim turn, same try
      if (!r.check.ok && r.check.formatOnly) {
        emit({ kind: 'model', line: MODEL_LINES.trim, ...tag, say: SWARM_SAY.shorten });
        const original = r.parsed.bet;
        const trimmed = await ask(buildTrimPrompt(JSON.stringify(original), r.check.reasons), attempt, 'trim', avoid);
        if (over) return;
        if (trimmed.failed) { ends.push({ lane: laneNo, model_failed: true, reason: trimmed.failed }); return; }
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
        turnedDown += 1;
        const again = attempt < WRITER_ATTEMPTS && left() >= writeMin;
        emit({ kind: 'reject', line: `${ORDINALS[attempt - 1]} answer turned down: ${reason}`, ...tag, ...(again ? { say: SWARM_SAY.redraft } : {}) });
        continue;
      }

      // the code checks passed; now a second model judges whether it makes sense
      const bet = cleanBet(r.parsed.bet, today, bundle);
      const draft = { bet, lane: laneNo, attempt, verdict: null, order: drafts.length };
      drafts.push(draft);
      if (left() < judgeMin) { draft.unjudged = 'no time left to check it'; ends.push({ lane: laneNo, out_of_time: true, reason }); return; }
      checking += 1;
      emit({ kind: 'skeptic', line: 'a second model is checking that it makes sense', ...tag, say: SWARM_SAY.checking(checking) });
      const judgedAt = clock();
      const said = await call(judge, buildSkepticPrompt(bet, bundle, { today }), { cwd, onProgress: () => {} });
      const skepticBase = { ...r.base, kind: 'skeptic', at: new Date(clock()).toISOString(), ms: clock() - judgedAt, title: bet.title };
      if (!said.ok) {
        saveAttempt(attemptsFile, { ...skepticBase, model_ok: false, ...(said.stopped ? { stopped: true } : {}), raw: null, parse: null, passed: false, reasons: [said.reason] });
        if (over) return;
        draft.unjudged = `the skeptic could not check the bet: ${said.reason}`;
        ends.push({ lane: laneNo, reason: draft.unjudged });
        return;
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
      if (over) return;
      if (judged.error) {
        draft.unjudged = `the skeptic could not check the bet: ${judged.error}`;
        ends.push({ lane: laneNo, reason: draft.unjudged });
        return;
      }
      draft.verdict = judged.verdict;
      if (passed) {
        winner = draft;
        emit({ kind: 'check', line: 'checked the bet: every rule passed and the skeptic agreed', ...tag, say: SWARM_SAY.heldUp });
        stop('pass');
        return;
      }
      reason = skepticReason(judged.verdict);
      turnedDown += 1;
      const missing = blockerOf(judged.verdict);
      if (missing) {
        strategy = 'blocker';
        blocker = { title: bet.title, missing_first: missing };
        blocked.push(bet.title);
      } else {
        strategy = 'patch';
      }
      emit({ kind: 'reject', line: `${ORDINALS[attempt - 1]} answer turned down: ${reason}`, ...tag, say: SWARM_SAY.notHeld });
    }
    ends.push({ lane: laneNo, reason });
  }

  emit({ kind: 'swarm', line: `${plural(n, 'writer')} at once`, n, say: SWARM_SAY.drafting(n) });
  const lanes = Array.from({ length: n }, (_, i) => lane(i).catch((err) => { ends.push({ lane: i + 1, reason: String((err && err.message) || err) }); }));
  Promise.all(lanes).then(() => stop('done'));
  await ended;
  finish();

  if (over === 'stopped') return { ok: false, stopped: true, reason: 'stopped before an idea was picked', bundle };
  if (winner) return { ok: true, bet: { ...winner.bet, skeptic: winner.verdict }, bundle, attempts: winner.attempt, lane: winner.lane, checked: true };
  // none passed: the best draft is still a card the owner can act on
  const best = [...drafts].sort((a, b) => draftRank(a) - draftRank(b) || a.order - b.order)[0];
  if (best) {
    const why = best.verdict ? skepticReason(best.verdict) : best.unjudged;
    emit({ kind: 'fallback', line: `no draft passed every check${over === 'budget' ? ' in time' : ''}; showing the best one: ${why}`, say: SWARM_SAY.outOfTime });
    return { ok: true, bet: { ...best.bet, skeptic: best.verdict || null, concern: ownerConcern(best) }, bundle, attempts: best.attempt, lane: best.lane, checked: false, reason: why };
  }
  emit({ kind: 'none', line: 'no draft met the plain rules', say: SWARM_SAY.nothing });
  const failedAll = ends.length > 0 && ends.every(e => e.model_failed);
  const last = [...ends].reverse().find(e => e.reason);
  if (failedAll) return { ok: false, reason: ends[0].reason, bundle };
  if (ends.length > 0 && ends.every(e => e.out_of_time) && !turnedDown) return { ok: false, reason: `no time was left to draft inside ${Math.round(budgetMs / 1000)} seconds once the facts were read`, bundle };
  if (over === 'budget') return { ok: false, reason: `nothing usable came back in ${Math.round(budgetMs / 1000)} seconds${last ? ` (${last.reason})` : ''}`, bundle };
  return { ok: false, reason: `the model's answer was turned down ${plural(turnedDown, 'time')} (${last ? last.reason : 'no answer met the rules'})`, bundle };
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

// a number as written: 5, 2.5, .5, or 1,000, never a tail of a longer one
const NUM = '(?<![\\d.,])((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)';
const numberOf = text => Number(String(text).replace(/,/g, ''));

function costHours(cost) {
  const t = String(cost || '').toLowerCase();
  const range = new RegExp(`${NUM}\\s*(?:-|to)\\s*${NUM}\\s*(?:hours?|hrs?)\\b`).exec(t);
  if (range) return numberOf(range[2]);
  const hours = new RegExp(`${NUM}\\s*(?:hours?|hrs?)\\b`).exec(t);
  if (hours) return numberOf(hours[1]);
  const minutes = new RegExp(`${NUM}\\s*(?:minutes?|mins?)\\b`).exec(t);
  if (minutes) return numberOf(minutes[1]) / 60;
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
function missionStartArgs(bet, { owner, lane }, betId = null, workspaceRoot = process.cwd()) {
  // the owner steps are sealed into the mission record at start
  const seal = require('./yes-lock').sealFor(bet.steps);
  const time = jobTime(bet);
  // --worktree: the job runs, and its check runs, in its own copy of the
  // code. Mission #266 ran in the shared main folder, which sat on an old
  // branch, so its check could not see the work it had merged. A folder with
  // no git has no master to protect and no copy to make, so the job runs in
  // place there, as it always did.
  const worktree = inGitCheckout(workspaceRoot) ? ['--worktree'] : [];
  return ['mission', 'start', missionObjective(bet, { owner, betId }), '--owner', owner, '--runner', 'claude', '--lane', lane, '--verify', bet.verify || MISSION_VERIFY, '--stop', MISSION_STOP, '--max-wall', String(time.seconds), '--max-ticks', String(time.ticks), '--stop-when-done', ...worktree, ...(seal.length ? ['--yes-lock', JSON.stringify(seal)] : []), '--json'];
}

function inGitCheckout(workspaceRoot) {
  return String(gitOut(workspaceRoot, ['rev-parse', '--is-inside-work-tree']) || '').trim() === 'true';
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
// Every mission the desk follows: the main folder's, plus those in worktrees
// ("do it" missions run in their own), newest record winning.
function readDeskMissions(workspaceRoot) {
  const missionCmd = require(path.join(__dirname, '..', 'commands', 'mission.js'));
  const map = new Map(missionCmd.loadMissionMap(workspaceRoot));
  const at = m => Date.parse((m && (m.updated_at || m.last_tick_at || m.created_at)) || '') || 0;
  for (const rolled of missionCmd.listWorktreeRollupMissions(workspaceRoot)) {
    if (!rolled || !rolled.id) continue;
    const known = map.get(rolled.id);
    if (!known || at(rolled) >= at(known)) map.set(rolled.id, rolled);
  }
  return map;
}

const defaultReadMissions = readDeskMissions;

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

// "oct 21": a day the way the owner says it
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthDay(at) {
  const d = new Date(at);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
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
  const hit = latestHandoff(betId, handoffs);
  return hit ? hit.to : owner;
}

function latestHandoff(betId, handoffs) {
  const tag = handoffTag(betId);
  const hits = handoffs.filter(h => h && typeof h.summary === 'string' && h.summary.includes(tag) && h.to);
  return hits.length ? hits[hits.length - 1] : null;
}

// When the newest handoff for a job could not start its member (the team was
// at its limit, no engine, asleep), say that instead of "<member> has it".
function handoffWaiting(betId, handoffs) {
  const hit = latestHandoff(betId, handoffs);
  const wake = hit && hit.wake;
  if (!wake || wake.status !== 'not_started') return null;
  return clip(String(wake.text || `${hit.to} did not start`).split('. to start it:')[0], 160);
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

// ideas kept ready ahead; one is written again the moment one is shown
const QUEUE_TARGET = 3;
// one drafting at a time (each runs up to three model calls at once, the
// swarm); the cap of 3 draftings in flight per session is never reached
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
//   scoreboard                                ask for the owner's number and its weekly value (gm phone turns it on)
//   suggestScoreboard(opts)                   -> { ok, choices }, the numbers to offer (tests stub)
//   readSaid(opts)                            -> { ok, kind, reply, suggestions }, what the owner typed (tests stub)
//   sayTimeoutMs                              how long a read may take before the plain fallback (15 s)
//   loadSeason(root)                          -> season, the board's 30 days of plays for each ovr (tests stub)
//   resolveEngine(name)                       -> { engine, model }, the member's roster pick (tests stub)
function createBetDesk(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  // is a process really running this mission: its driver's pid is alive
  const driverAlive = deps.driverAlive || ((m) => {
    try { return require(path.join(__dirname, '..', 'commands', 'mission.js')).missionDriverHealth(m, deps.workspaceRoot).alive === true; } catch { return false; }
  });
  const focusFile = focusPath(path.dirname(deps.ledgerFile));
  const questionsFile = questionsPath(path.dirname(deps.ledgerFile));
  const scoreboardFile = scoreboardPath(path.dirname(deps.ledgerFile));
  // a desk with a stubbed idea writer never reaches the real reader either
  const readFn = deps.readSaid || (deps.generate
    ? (async () => ({ ok: false, reason: 'no reader here' }))
    : (opts => readSaid({ ...opts, workspaceRoot: deps.workspaceRoot, bundle: state.bundle, deps: deps.generatorDeps || {} })));
  const suggestNumbers = deps.suggestScoreboard || (deps.generate
    ? (() => new Promise(() => {}))
    : (opts => generateScoreboardChoices({ ...opts, deps: deps.generatorDeps || {}, ledgerFile: deps.ledgerFile, today: dayKey(now()) })));
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
    failures: 0,
    backoffUntil: 0,
    retry: null,
    // the last bundle a generation read, for the question cards
    bundle: deps.bundle || null,
    // questions passed over this session, so a re-tap asks the next one
    passedQuestions: new Set(),
    // the question writer: one at a time, resting after failures like the idea writer
    qInFlight: null,
    // the numbers the model suggests for the scoreboard question
    suggestions: null,
    // the conversation on the card or member talk on screen: { id, turns }
    thread: { id: null, turns: [] },
    sInFlight: null,
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
    // yeses said this session, by key, and nos; a yes only passed over is still owed
    answeredYes: new Set(),
    // yeses skipped with not now, in the order skipped: they wait at the back
    skippedYes: new Map(),
    skips: 0,
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
    state.queue.push({ id: row.id, bet: row.bet, created_at: Date.parse(row.created_at) || 0, ...(row.state_key ? { state_key: row.state_key } : {}), ...(row.rework_of ? { rework_of: row.rework_of } : {}) });
  }

  // the team, read once: a queued bet whose members are not on it is not shown
  let team = null;
  try {
    team = (deps.readTeam || readTeam)(deps.workspaceRoot);
  } catch {
    team = null;
  }

  // What a prepared idea was written from on the owner's side: his answers
  // to the question cards and his own number. An idea written before either
  // changed would not know what he just said, so it is never shown.
  function ownerStateKey() {
    const focus = Object.values(readFocus(focusFile, deps.workspaceRoot)).map(a => [String(a.key), String(a.label)]).sort((a, b) => a[0].localeCompare(b[0]));
    const board = readScoreboard(scoreboardFile, deps.workspaceRoot);
    const last = board && board.reports.length ? board.reports[board.reports.length - 1].value : null;
    return crypto.createHash('sha256').update(JSON.stringify({ focus, board: board ? [board.name, board.up, board.source, last] : null })).digest('hex').slice(0, 12);
  }

  // Titles the owner already saw or turned down: shown, passed, skipped, or started.
  const SEEN = new Set(['proposed', 'passed', 'skipped', 'doing']);
  function seenTitles() {
    return readLedger(deps.ledgerFile, deps.workspaceRoot).filter(r => r.bet && r.bet.title && (SEEN.has(r.status) || r.shown_at)).map(r => ({ id: r.id, title: r.bet.title }));
  }

  // The number an idea starts from, as it was when it was written, against
  // the newest facts read: when it moved, the idea's numbers are old.
  function startMoved(bet) {
    const t = bet && bet.target;
    const m = t && state.bundle ? bundleMetrics(state.bundle)[t.metric] : null;
    if (!m || !Number.isFinite(m.baseline) || !Number.isFinite(t.baseline) || m.baseline === t.baseline) return null;
    return `the number it starts from moved: ${commas(t.baseline)} then, ${commas(m.baseline)} now`;
  }

  // Why a prepared idea can no longer be shown, or null while it is fresh:
  // older than 6 hours, made under rules that changed since, written before
  // the owner's newest answer or number, too close to one he already saw or
  // turned down, or its starting number moved.
  function staleWhy(item, seen) {
    if (now() - item.created_at > STALE_MS) return 'older than 6 hours';
    const rule = queuedProblem(item.bet, team);
    if (rule) return rule;
    if (item.state_key && item.state_key !== ownerStateKey()) return 'written before the owner\'s newest answer';
    // a rework of the idea the owner wrote a note on may stay close to it
    const close = seen.find(s => s.id !== item.id && s.title !== item.rework_of && nearDuplicate(item.bet.title, s.title));
    if (close) return `too close to one already shown: ${clip(close.title, 80)}`;
    return startMoved(item.bet);
  }

  // Old bets go. Each is marked stale with why, and the queue refills behind them.
  function dropStale() {
    const keep = [];
    const seen = state.queue.length ? seenTitles() : [];
    for (const item of state.queue) {
      const why = staleWhy(item, seen);
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
      // its process is alive (a laptop that slept makes the times look old): working, never resent
      if (job.kind === 'done' && (job.failed || job.halted) && driverAlive(mission)) {
        working.push({ kind: 'working', bet_id: row.id, mission_id: mission.id, title: job.title, owner: currentMember(row.id, job.owner, handoffs()) });
        continue;
      }
      // still because the guard holds a step for the owner's yes: that is a yes card, not a halt
      const held = job.stalled ? require('./yes-lock').askedYesLocks(lockDir, mission.id) : [];
      if (held.length) {
        for (const lock of held) yes.push({ ...job, kind: 'yes', ask: lock.text, command: lock.held_command || null, lock_step: lock.step, lock_hash: lock.hash || null, ask_index: null, key: `${mission.id}:step-${lock.step}:${lock.hash || ''}` });
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
        const waiting = handoffWaiting(row.id, handoffs());
        working.push({ ...job, owner: currentMember(row.id, job.owner, handoffs()), ...(waiting ? { waiting } : {}) });
        // a step the job tried and the guard held is a yes card
        for (const lock of require('./yes-lock').askedYesLocks(lockDir, mission.id)) {
          yes.push({ ...job, kind: 'yes', ask: lock.text, command: lock.held_command || null, lock_step: lock.step, lock_hash: lock.hash || null, ask_index: null, key: `${mission.id}:step-${lock.step}:${lock.hash || ''}` });
        }
      } else if (job.kind === 'yes') {
        for (const ask of job.asks) yes.push({ ...job, ask_index: ask.index, ask: ask.text, key: `${job.mission_id}:${ask.index}` });
      }
    }
    // a run woken by a handoff, held from a command: the card shows on the
    // job it was handed off from when that job is on the desk, else on its
    // own; the yes always goes to the run that was held
    for (const card of require('./yes-lock').handoffYesCards(lockDir)) {
      const parent = [...working, ...yes].find(j => j.mission_id && j.mission_id === card.parent_mission_id) || null;
      const where = parent ? { bet_id: parent.bet_id, title: parent.title, owner: parent.owner } : { bet_id: null, title: 'a handed-off job', owner: card.who && card.who !== 'a handed-off job' ? card.who : 'the handed-off job' };
      yes.push({ kind: 'yes', ...where, mission_id: card.mission_id, ask: card.ask, command: card.command, lock_step: card.step, lock_hash: card.hash || null, ask_index: null, key: `${card.mission_id}:step-${card.step}:${card.hash || ''}` });
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
    let missionMap;
    const missionOf = (id) => {
      if (missionMap === undefined) {
        try { missionMap = (deps.readMissions || defaultReadMissions)(deps.workspaceRoot); } catch { missionMap = null; }
      }
      return missionMap instanceof Map ? missionMap.get(id) : (missionMap || {})[id];
    };
    for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot)) {
      if (row.mission_result !== 'failed' || row.done_seen_at || state.retrying.has(row.id)) continue;
      // its process turned out to be alive: it is working, so put it back and never resend it
      const live = row.mission_id ? missionOf(row.mission_id) : null;
      if (live && driverAlive(live)) {
        record(row.id, { mission_result: null, mission_halted: null, mission_stalled: null, mission_out_of_time: null, mission_progress: null, mission_stop_reason: null });
        log({ card: 'bet', choice: 'still_running', command: null, ran: 'in process', exit_code: 0, bet_id: row.id, mission_id: row.mission_id });
        continue;
      }
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

  // The yeses still owed, one per key: not answered yes or no this session.
  function owedYes() {
    const keys = new Set();
    return state.jobs.yes.filter(j => !state.answeredYes.has(j.key) && !keys.has(j.key) && keys.add(j.key));
  }

  // The next card that is not a bet: a yes the owner owes comes first, then
  // a finished job. Nothing pops on its own; these only come on the next tap.
  // Yes cards never take over the screen: right after a yes, the next card is
  // a normal one, and only a yes not seen yet comes up on its own. The rest
  // wait behind the small need-you line, in the job deck.
  function nextJobCard({ afterYes = false } = {}) {
    const ask = afterYes ? null : owedYes().find(j => !state.seenYes.has(j.key));
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

  // ---- the scoreboard: the owner's own number ----

  const SCOREBOARD_ASK = 'what number tells you this is going well?';
  // questions kept here, not in the questions file
  const LOCAL_QUESTIONS = new Set([FALLBACK_QUESTION.key, 'scoreboard']);
  const LOWER_IS_BETTER = /\b(fewer|less|lower|reduce|down|churn|bugs?|costs?|spend|refunds?|complaints?)\b/i;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function fallbackNumbers() {
    const list = [];
    if (state.bundle && state.bundle.sources && state.bundle.sources.installs) list.push({ name: 'installs each week', up: true });
    list.push({ name: 'people who used it this week', up: true }, { name: 'money that came in this month', up: true });
    return list.slice(0, 3);
  }

  // the model's suggestions, written once in the background while none is saved
  function pumpSuggestions() {
    if (!deps.scoreboard || state.suggestions || state.sInFlight || readScoreboard(scoreboardFile, deps.workspaceRoot)) return;
    state.sInFlight = Promise.resolve()
      .then(() => suggestNumbers({ workspaceRoot: deps.workspaceRoot, bundle: state.bundle }))
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        if (out && out.ok && Array.isArray(out.choices)) state.suggestions = out.choices;
        else log({ card: 'bet', choice: 'scoreboard', command: null, ran: 'in process', exit_code: 1, error: clip((out && out.reason) || 'no numbers', 160) });
      });
  }

  // The card the owner owes before any idea: which number to watch, while
  // none is saved; then, for a number nobody can read on its own, its value
  // once a week, and whenever an idea is waiting on it to be scored.
  function askCard() {
    if (!deps.scoreboard) return null;
    const board = readScoreboard(scoreboardFile, deps.workspaceRoot);
    if (!board) {
      if (state.passedQuestions.has('scoreboard')) return null;
      const list = (state.suggestions || fallbackNumbers()).slice(0, 3).map(c => ({ ...c, name: you(c.name) }));
      return {
        kind: 'question',
        id: 'question:scoreboard',
        question: { key: 'scoreboard', ask: SCOREBOARD_ASK, line: null, choices: [...list.map((c, i) => ({ id: `s${i + 1}`, label: c.name })), { id: 'other', label: 'something else', other: true }], numbers: list },
      };
    }
    const today = dayKey(now());
    // passed over today (not now, or a tap past it): asked again tomorrow
    if (board.source !== 'reported' || state.passedQuestions.has(`report:${today}`)) return null;
    const last = board.reports[board.reports.length - 1] || null;
    const weekly = !last || now() - (Date.parse(last.at) || 0) >= WEEK_MS;
    const waiting = readLedger(deps.ledgerFile, deps.workspaceRoot).some(r => r.status === 'doing' && r.bet && r.bet.target && r.bet.target.metric === 'scoreboard'
      && String(r.bet.check_date || '') < today && !board.reports.some(x => String(x.at).slice(0, 10) >= r.bet.check_date));
    if (!weekly && !waiting) return null;
    return { kind: 'report', id: `report:${today}`, board, last };
  }

  function showAsk(item) {
    if (item.kind === 'question') { showQuestion(item); return; }
    state.current = item;
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'report' });
  }

  // the number for the card on screen, saved beside the ledger
  function report({ value } = {}) {
    const item = onJob('report');
    if (!item) return { ok: false, reason: 'gone', message: 'there is no number asked for on screen' };
    const raw = String(value == null ? '' : value).replace(/,/g, '').trim();
    const v = Number(raw);
    if (!raw || !Number.isFinite(v)) return { ok: false, reason: 'bad_number', message: 'that is not a number' };
    appendLedger(scoreboardFile, { workspace: deps.workspaceRoot, kind: 'report', value: v, at: iso() });
    log({ card: 'bet', choice: 'report', command: null, ran: 'in process', exit_code: 0 });
    state.status = 'cleared';
    return { ok: true, ack: `saved: ${commas(v)}.` };
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
      return { kind: 'question', id: `question:${row.id}`, question: { key: row.id, ask: q.ask, line: q.fact, choices: q.choices.map((label, i) => ({ id: `a${i + 1}`, label: you(label) })) } };
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

  // nothing ready and nothing left to ask: one calm line, shown at once; the
  // page brings the idea in once it is written
  const WAIT_CARD = { what: 'writing your next idea.' };
  function showWait() {
    state.current = { kind: 'wait', id: `wait:${now()}`, shown_at: now(), lines: [] };
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'wait' });
  }
  const onWait = () => state.status === 'ready' && Boolean(state.current) && state.current.kind === 'wait';

  // How the waiting card shows it is alive: the plain lines of the drafting
  // it waits on (the one running when it showed, or the one that took over
  // when that was stopped), newest last, and when that drafting began.
  const WAIT_LINES = 6;
  function waitProgress(cur) {
    const was = cur.waitsOn;
    if (state.gen && (!was || (was.stopping && was !== state.gen))) {
      // the line that says why it started over stays on the card
      if (was && was.stopSay) cur.lines = [...(cur.lines || []), { at: was.stopped_at, line: was.stopSay }];
      cur.waitsOn = state.gen;
    }
    const g = cur.waitsOn || null;
    const said = g ? g.events.filter(e => e.say).map(e => ({ at: e.at, line: e.say })) : [];
    if (g && g.stopping && g.stopSay) said.push({ at: g.stopped_at, line: g.stopSay });
    const lines = [...(cur.lines || []), ...said].sort((a, b) => a.at - b.at).slice(-WAIT_LINES);
    const startedAt = g ? g.started_at : (cur.shown_at || now());
    return { progress: lines, started_at: startedAt, waited_ms: Math.max(0, now() - startedAt) };
  }

  // The wait ended with no draft that met the plain rules (the model is down,
  // or every draft broke a rule): a card the owner can act on, never an error.
  const MISSED_CARD = { what: 'no idea came together this time.' };
  // It remembers the wait it ended (after, and the id that wait was served
  // under), so words the owner was typing there still count.
  function showMissed() {
    const was = state.current && state.current.kind === 'wait' ? state.current : null;
    const servedWait = was && state.served && state.served.kind === 'wait' ? state.served.id : null;
    state.current = { kind: 'missed', id: `missed:${now()}`, ...(was ? { after: was.id, afterServed: servedWait } : {}) };
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'missed' });
  }

  // The owner asked for something (a sharper idea, words on a card): a
  // background top-up still drafting is stopped, so his ask starts now
  // instead of after it.
  function makeRoomFor() {
    if (state.gen && !state.gen.asked && !state.gen.stopping) state.gen.stop('the owner asked for something', 'starting a new one for what you asked');
  }

  // Which ready idea goes next: one the owner asked for first, then a
  // checked one; one a second look worried about waits behind them.
  function nextIndex() {
    if (!state.queue.length) return -1;
    if (state.queue[0].asked) return 0;
    const i = state.queue.findIndex(item => !item.bet.concern);
    return i >= 0 ? i : 0;
  }
  const checkedReady = () => state.queue.filter(item => !item.bet.concern);

  function showQuestion(item) {
    if (!LOCAL_QUESTIONS.has(item.question.key)) appendLedger(questionsFile, { id: item.question.key, workspace: deps.workspaceRoot, status: 'shown', shown_at: iso() });
    state.current = item;
    state.status = 'ready';
    state.mission = null;
    state.error = null;
    log({ card: 'bet', choice: 'show', command: null, ran: 'in process', exit_code: 0, kind: 'question', question: item.question.key });
  }

  // a re-tap on a job card moves on: a yes waits for a later session, a done is seen.
  // later: not now on a yes, which also sends it to the back of the job deck
  function passJob(item, { later = false } = {}) {
    if (item.kind === 'wait' || item.kind === 'missed') return;
    if (item.kind === 'report') { state.passedQuestions.add(item.id); return; }
    if (item.kind === 'choice') {
      for (const i of item.items) record(i.id, { status: 'passed', note: 'not picked' });
      log({ card: 'bet', choice: 'pass', command: null, ran: 'in process', exit_code: 0, kind: 'choice' });
      return;
    }
    if (item.kind === 'question') {
      state.passedQuestions.add(item.question.key);
      if (!LOCAL_QUESTIONS.has(item.question.key)) appendLedger(questionsFile, { id: item.question.key, workspace: deps.workspaceRoot, status: 'passed' });
      log({ card: 'bet', choice: 'pass', command: null, ran: 'in process', exit_code: 0, kind: 'question', question: item.question.key });
      return;
    }
    const skipped = later && item.kind === 'yes';
    if (item.kind === 'yes') state.seenYes.add(item.job.key);
    if (skipped) { state.skips += 1; state.skippedYes.set(item.job.key, state.skips); }
    if (item.kind === 'done') record(item.job.bet_id, { done_seen_at: iso() });
    log({ card: 'bet', choice: skipped ? 'later' : 'pass', command: null, ran: 'in process', exit_code: 0, kind: item.kind, bet_id: item.job.bet_id });
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

  function startGeneration({ sharperOf = null, reworkOf = null, ownerNote = null, concern = null } = {}) {
    if (state.inFlight >= MAX_IN_FLIGHT || state.inFlight >= SESSION_IN_FLIGHT_CAP) return null;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.run += 1;
    // what the idea is written from on the owner's side, read before it starts
    const key = ownerStateKey();
    const stopper = new AbortController();
    const asks = { sharperOf, reworkOf, ownerNote, concern };
    const gen = { run: state.run, events: [], sharperOf, started_at: now(), key, asked: Boolean(sharperOf || ownerNote), asks, stopping: false };
    // stops every model call this drafting has running; its answer is dropped.
    // say: the plain line the waiting card shows for it
    gen.stop = (why, say = null) => {
      if (gen.stopping) return;
      gen.stopping = why || true;
      gen.stopSay = say;
      gen.stopped_at = now();
      stopper.abort();
    };
    state.gen = gen;
    const emit = (ev) => { gen.events.push({ i: gen.events.length, at: now(), ...ev }); };
    // started now, not on a later tick, so the in-flight count is exact
    let started;
    try {
      started = Promise.resolve(generate({ workspaceRoot: deps.workspaceRoot, today: dayKey(now()), previousTitle: sharperOf, avoidTitles: avoidTitles(), ...(ownerNote ? { reworkOf, ownerNote } : {}), ...(concern ? { concern } : {}), signal: stopper.signal, emit, onBundle: (b) => { state.bundle = b; } }));
    } catch (err) {
      started = Promise.reject(err);
    }
    gen.done = started
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        state.inFlight -= 1;
        if (state.gen === gen) state.gen = null;
        if (out.bundle) state.bundle = out.bundle;
        // stopped on purpose: not a failure, and an ask it carried is asked again
        if (gen.stopping || out.stopped) {
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 0, stopped: clip(String(gen.stopping === true ? 'stopped' : gen.stopping || 'stopped'), 120) });
          if (gen.asked && !state.pendingSharper) state.pendingSharper = asks;
          return pump();
        }
        if (!out.ok) {
          // a failure stays in the log; the owner never sees the reason
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 1, error: clip(out.reason, 200) });
          emit({ kind: 'failed', line: out.reason });
          state.failures += 1;
          if (state.failures >= MAX_BACKGROUND_FAILURES) backOff();
          // the owner is waiting on the calm line: the wait ends in a card he can act on
          if (onWait()) showMissed();
          return pump();
        }
        const item = { id: newId(), bet: out.bet, created_at: now(), state_key: key, ...(gen.asked ? { asked: true } : {}), ...(ownerNote && reworkOf ? { rework_of: reworkOf } : {}) };
        // stale the moment it lands (too close to one just shown): counted as
        // a failure, so a writer that keeps landing there rests instead of looping
        const staleNow = staleWhy(item, seenTitles());
        if (staleNow) {
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 1, error: clip(`stale on arrival: ${staleNow}`, 200) });
          state.failures += 1;
          if (state.failures >= MAX_BACKGROUND_FAILURES) {
            backOff();
            // resting now, so nothing is drafting for a wait on screen
            if (onWait()) showMissed();
          }
          return pump();
        }
        state.failures = 0;
        record(item.id, { created_at: iso(), status: 'queued', bet: out.bet, state_key: key, checked: out.checked !== false && !out.bet.concern, previous_title: sharperOf, ...(ownerNote ? { rework_of: reworkOf, owner_note: ownerNote } : {}) });
        log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 0, bet_id: item.id, checked: out.checked !== false && !out.bet.concern, ms: now() - gen.started_at });
        emit({ kind: 'done', line: 'bet ready' });
        // the sharper or reworked idea the owner asked for is the next shown
        if (sharperOf || ownerNote) state.queue.unshift(item);
        else state.queue.push(item);
        // the calm line stays the card on screen; the page sees the idea in
        // the queue and asks for it when the owner is not typing there
        return pump();
      });
    return gen;
  }

  // Keeps the queue full: below 3 the next one is written, so showing one
  // starts the next at once, one generation at a time. A sharper idea the
  // owner asked for goes first.
  function pump() {
    pumpQuestions();
    pumpSuggestions();
    dropStale();
    // the owner answered or picked a number since this drafting began: what
    // it writes would not know that, so it stops and a fresh one starts
    if (state.gen && !state.gen.stopping && state.gen.key !== ownerStateKey()) state.gen.stop('the owner answered something new', 'starting over with your newest answer');
    if (state.pendingSharper) makeRoomFor();
    if (state.inFlight >= MAX_IN_FLIGHT) return state.gen && state.gen.done;
    if (state.pendingSharper) {
      const asked = state.pendingSharper;
      state.pendingSharper = null;
      const gen = startGeneration(asked);
      return gen && gen.done;
    }
    if (state.queue.length >= QUEUE_TARGET) return null;
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
  // later: not now on a yes card.
  function next({ sharper = false, later = false } = {}) {
    if (state.status === 'starting') return { ok: true, busy: true, ...view() };
    const onScreen = state.status === 'ready' && state.current ? state.current : null;
    // passed, skipped, or answered: the card after a yes is never another yes
    const afterYes = Boolean(state.current && state.current.kind === 'yes');
    if (onScreen && onScreen.kind && onScreen.kind !== 'bet') {
      passJob(onScreen, { later });
    } else if (onScreen) {
      record(onScreen.id, { status: 'passed', ...(sharper ? { note: 'asked for a sharper idea' } : {}) });
      log({ card: 'bet', choice: sharper ? 'sharper' : 'pass', command: null, ran: 'in process', exit_code: 0, bet_id: onScreen.id });
      // sharpening one a second look worried about: the new draft must answer the worry
      const worry = onScreen.bet.concern && onScreen.bet.skeptic && onScreen.bet.skeptic.reason;
      if (sharper) state.pendingSharper = { sharperOf: onScreen.bet.title, ...(worry ? { concern: worry } : {}) };
    } else {
      log({ card: 'bet', choice: 'think', command: null, ran: 'in process', exit_code: 0 });
    }
    dropStale();
    if (now() - state.jobs.at > 5000) pollJobs();
    const job = nextJobCard({ afterYes });
    const ask = job ? null : askCard();
    const checked = checkedReady();
    if (job) showJob(job);
    else if (ask) showAsk(ask);
    // two or more checked ideas ready: one card to pick from; one a second look worried about is never in it
    else if (deps.choices !== false && checked.length >= 2) {
      const items = checked.slice(0, CHOICE_MAX);
      state.queue = state.queue.filter(item => !items.includes(item));
      showChoice(items);
    } else if (state.queue.length) show(state.queue.splice(nextIndex(), 1)[0]);
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
    const startArgs = missionStartArgs(bet, pick, id, deps.workspaceRoot);
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
  // the writer reads it for every bet after this one. card: the id of the
  // card the page shows; a page that missed the next card names the old one,
  // and its answer is saved against nothing (answer ids repeat across questions)
  function answer({ choice, text, card } = {}) {
    const item = onJob('question');
    if (!item) return { ok: false, reason: 'gone', message: 'there is no question on screen' };
    if (card !== undefined && card !== item.id) return { ok: false, reason: 'gone', message: 'that card changed, so nothing was saved. tap the orb for the new one' };
    const picked = item.question.choices.find(c => c.id === choice);
    if (!picked) return { ok: false, reason: 'bad_choice', message: 'that is not one of the answers' };
    const q = item.question;
    if (q.key === 'scoreboard') {
      let name;
      let up;
      if (picked.other) {
        name = String(text || '').trim();
        if (!name) return { ok: false, reason: 'empty', message: 'say the number in a few words' };
        if (name.length > 60) return { ok: false, reason: 'too_long', message: 'keep it under 60 characters' };
        up = !LOWER_IS_BETTER.test(name);
      } else {
        const pick = q.numbers[Number(picked.id.slice(1)) - 1];
        name = pick.name;
        up = pick.up !== false;
      }
      // installs on a workspace with npm numbers are read on their own
      const source = /\b(installs?|downloads?)\b/i.test(name) && state.bundle && state.bundle.sources && state.bundle.sources.installs ? 'installs' : 'reported';
      appendLedger(scoreboardFile, { workspace: deps.workspaceRoot, kind: 'pick', name, up, source, at: iso() });
      log({ card: 'bet', choice: 'scoreboard', command: null, ran: 'in process', exit_code: 0, source });
      state.status = 'cleared';
      return { ok: true, ack: `got it: ${name}.` };
    }
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
    const startArgs = missionStartArgs(again, pick, row.id, deps.workspaceRoot);
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
  // A yes from the job deck names its key, and answers that job's yes
  // wherever it is; the card on the main screen clears only when it is the
  // same yes.
  // The yes or no a key names: the main screen's yes card when it is the
  // same request, else that job's card in the job deck. Without a key, the
  // yes on the main screen.
  function findYes({ key, job: jobId } = {}) {
    const shown = onJob('yes');
    let item = shown;
    if (key) {
      // a deck yes is bound to its job and its command: both must match
      const bound = y => y && y.key === key && y.mission_id === jobId;
      item = jobId && shown && bound(shown.job) ? shown : null;
      if (!item && jobId) {
        const found = deckCards().map(x => x.yes).find(bound);
        item = found ? { kind: 'yes', job: found } : null;
      }
    }
    return { shown, item };
  }

  async function answerYes({ key, job: jobId } = {}) {
    const { shown, item } = findYes({ key, job: jobId });
    if (!item) return { ok: false, reason: 'gone', message: key ? 'that question was already answered' : 'there is no question on screen' };
    const { job } = item;
    const clear = () => { if (shown && shown.job.key === job.key) state.status = 'cleared'; };
    if (job.lock_step) {
      // the yes releases only the command on this card (its hash), once
      const approved = require('./yes-lock').approveYesLock(lockDir, job.mission_id, job.lock_step, null, iso(), { hash: job.lock_hash || null });
      if (job.lock_hash && !approved) {
        state.seenYes.add(job.key);
      state.answeredYes.add(job.key);
        clear();
        pollJobs();
        return { ok: true, ack: 'that request was already answered.' };
      }
      const args = ['mission', 'ping', job.mission_id, `the owner said yes to step ${job.lock_step}: ${job.ask}. the guard lets it through now; run it again.`, '--from', 'gm-phone'];
      const res = await deps.runCli(args);
      log({ card: 'bet', choice: 'yes', command: require('./gm-phone').displayCommand(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id, step: job.lock_step });
      state.seenYes.add(job.key);
      state.answeredYes.add(job.key);
      if (job.bet_id) record(job.bet_id, { yes_answered: { mission_id: job.mission_id, step: job.lock_step, at: iso() } });
      clear();
      pollJobs();
      return { ok: true, ack: `${job.owner}: got your yes` };
    }
    const listed = await deps.runCli(['decide', '--json']);
    const open = (parseJsonOut(listed.stdout) || {}).decisions || [];
    const match = open.find(d => d && d.mission_id === job.mission_id && d.ask_index === job.ask_index);
    if (!match) {
      state.seenYes.add(job.key);
      state.answeredYes.add(job.key);
      clear();
      return { ok: true, ack: 'that question was already answered.' };
    }
    const args = ['decide', String(match.number), 'yes', '--json'];
    const res = await deps.runCli(args);
    log({ card: 'bet', choice: 'yes', command: require('./gm-phone').displayCommand(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id });
    if (res.code !== 0) return { ok: false, reason: 'answer_failed', message: 'your yes did not go through; try again' };
    state.seenYes.add(job.key);
      state.answeredYes.add(job.key);
    if (job.bet_id) record(job.bet_id, { yes_answered: { mission_id: job.mission_id, ask_index: job.ask_index, at: iso() } });
    clear();
    pollJobs();
    return { ok: true, ack: `${job.owner}: got your yes` };
  }

  // no: the one request on the card is told no, and the job goes on without
  // it. A held command is denied for good (asking again only hears the no)
  // and the job is pinged; a plain ask is answered no through atris decide,
  // matched by mission and ask, the way a yes is.
  async function answerNo({ key, job: jobId } = {}) {
    const { shown, item } = findYes({ key, job: jobId });
    if (!item) return { ok: false, reason: 'gone', message: key ? 'that question was already answered' : 'there is no question on screen' };
    const { job } = item;
    const display = args => require('./gm-phone').displayCommand(args);
    const told = `told ${job.owner} no. it goes on without it.`;
    const done = (ack) => {
      state.seenYes.add(job.key);
      state.answeredYes.add(job.key);
      if (shown && shown.job.key === job.key) state.status = 'cleared';
      pollJobs();
      return { ok: true, ack };
    };
    if (job.lock_step) {
      const denied = require('./yes-lock').denyYesLock(lockDir, job.mission_id, job.lock_step, { hash: job.lock_hash || null, at: iso() });
      if (!denied) return done('that request was already answered.');
      const args = ['mission', 'ping', job.mission_id, `the owner said no to step ${job.lock_step}: ${job.ask}. do not run it; leave that step undone and go on with the rest.`, '--from', 'gm-phone'];
      const res = await deps.runCli(args);
      log({ card: 'bet', choice: 'no', command: display(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id, step: job.lock_step });
      if (job.bet_id) record(job.bet_id, { no_answered: { mission_id: job.mission_id, step: job.lock_step, at: iso() } });
      return done(told);
    }
    const listed = await deps.runCli(['decide', '--json']);
    const open = (parseJsonOut(listed.stdout) || {}).decisions || [];
    const match = open.find(d => d && d.mission_id === job.mission_id && d.ask_index === job.ask_index);
    if (!match) return done('that question was already answered.');
    const args = ['decide', String(match.number), 'no', '--json'];
    const res = await deps.runCli(args);
    log({ card: 'bet', choice: 'no', command: display(args), exit_code: res.code, bet_id: job.bet_id, mission_id: job.mission_id });
    if (res.code !== 0) return { ok: false, reason: 'answer_failed', message: 'your no did not go through; try again' };
    if (job.bet_id) record(job.bet_id, { no_answered: { mission_id: job.mission_id, ask_index: job.ask_index, at: iso() } });
    return done(told);
  }

  // Two sentences for the owner: what is going on, and why it matters to
  // the business. Nothing about how the work was checked.
  function publicJob(item) {
    const j = item.job;
    const expect = item.kind === 'yes' ? j.expect : j.bet && j.bet.expect;
    const why = expect ? ` ${sentence(expect)}` : '';
    if (item.kind === 'yes') return { what: plainAsk(j.ask), why: `${j.owner} is waiting on your yes for this.${why}` };
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
      job: kind === 'yes' || kind === 'done' ? publicJob(cur) : (kind === 'wait' ? { ...WAIT_CARD } : (kind === 'missed' ? { ...MISSED_CARD } : null)),
      question: kind === 'question' ? { ask: cur.question.ask, line: cur.question.line, choices: cur.question.choices } : null,
      report: kind === 'report' ? {
        what: `${cur.board.name}: what is it this week?`,
        why: cur.last ? `last time it was ${commas(cur.last.value)}, on ${monthDay(cur.last.at)}.` : 'one number a week shows if this is going well.',
      } : null,
      // each option: its title, and one plain line of why, the result it expects
      choice: kind === 'choice' ? { options: cur.items.map(i => ({ id: i.id, title: i.bet.title, why: choiceWhy(i.bet.expect) })) } : null,
      working: state.jobs.working.map(j => ({ title: j.title, owner: j.owner, ...(j.left ? { left: j.left } : {}), ...(j.waiting ? { waiting: j.waiting } : {}) })),
      // the conversation on this card so far
      thread: cur && state.thread.id === cur.id ? state.thread.turns.slice() : [],
      // the footer count: only members really working
      team_working: statusTable().rows.filter(r => r.status === 'working').length,
      // the yeses still owed past the one on screen: the small need-you line
      needs_you: owedYes().filter(j => !(kind === 'yes' && cur.job && cur.job.key === j.key)).length,
      events: events.map(e => ({ i: e.i, kind: e.kind, line: e.line, ...(e.key ? { key: e.key } : {}), ...(e.n != null ? { n: e.n } : {}) })),
      error: state.error,
      queue: state.queue.length,
      mission: state.mission ? { owner: state.mission.owner, line: state.mission.line } : null,
    };
  }

  // ---- free text: each card is one turn in a conversation ----

  function threadFor(id) {
    if (state.thread.id !== id) state.thread = { id, turns: [] };
    return state.thread;
  }
  const endThread = () => { state.thread = { id: null, turns: [] }; };
  function addTurns(t, ...turns) {
    t.turns = [...t.turns, ...turns].slice(-THREAD_TURNS);
  }
  const plainReply = text => (text && !ownerWord(text) ? text : null);
  let ownerName;
  const you = label => toYou(label, ownerName === undefined ? (ownerName = ownerFirstName(deps.workspaceRoot, deps)) : ownerName);
  const sameLabel = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const plainSuggestions = list => (Array.isArray(list) ? list : [])
    .filter(x => typeof x === 'string' && x.trim() && x.length <= 40 && !ownerWord(x) && !PROCESS_TALK.test(x))
    .slice(0, 3);

  // a read, within its time; a slow or failed one is a failed read
  function readWithin(opts) {
    let timer;
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'the read took too long' }), deps.sayTimeoutMs || SAY_READ_MS);
      if (timer.unref) timer.unref();
    });
    return Promise.race([Promise.resolve().then(() => readFn(opts)).catch(err => ({ ok: false, reason: String((err && err.message) || err) })), slow])
      .finally(() => clearTimeout(timer));
  }

  // the card as the reader sees it
  function cardForReader(v) {
    if (v.kind === 'question') return { kind: 'question', title: v.question.ask, detail: v.question.line, buttons: v.question.choices.map(c => c.label) };
    if (v.kind === 'bet' && v.bet.concern) return { kind: 'idea', title: v.bet.title, detail: [v.bet.why_now, v.bet.expect, v.bet.concern].join(' '), buttons: ['go with it', 'sharpen it', 'something else'] };
    if (v.kind === 'bet') return { kind: 'idea', title: v.bet.title, detail: [v.bet.why_now, v.bet.expect].join(' '), buttons: ['do it', 'sharper idea', 'not now'] };
    if (v.kind === 'choice') return { kind: 'choice', title: 'which one next?', detail: v.choice.options.map(o => o.title).join(' / '), buttons: [] };
    if (v.kind === 'report') return { kind: 'number', title: v.report.what, detail: v.report.why, buttons: ['save', 'not now'] };
    return { kind: v.kind, title: v.job ? v.job.what : '', detail: v.job ? v.job.why : '', buttons: [] };
  }

  // Read first. A question back or an unclear message is answered on the
  // same card and saves nothing; an answer or an instruction is acted on.
  // A failed or slow read falls back to the plain line and saves nothing.
  const QUESTION_HINT = 'his message ends with a question mark: it is a question back, not an answer';
  async function readTurn(t, text, card) {
    const thread = t.turns.slice(-THREAD_TURNS);
    let read = await readWithin({ text, card, thread });
    // words that end in a question mark are never saved as an answer: ask once
    // more with that said, and if it still reads as an answer, fall back
    if (read && read.ok && read.kind === 'answer' && /\?\s*$/.test(text)) {
      read = await readWithin({ text, card, thread, hint: QUESTION_HINT });
      if (read && read.ok && read.kind === 'answer') read = { ok: false, reason: 'a question read as an answer' };
    }
    if (read && read.ok && (read.kind === 'answer' || read.kind === 'instruction')) return { act: read };
    const kind = read && read.ok ? read.kind : 'unclear';
    const reply = (read && read.ok && plainReply(read.reply)) || SAY_FALLBACK;
    const suggestions = read && read.ok && reply !== SAY_FALLBACK
      ? plainSuggestions((Array.isArray(read.suggestions) ? read.suggestions : []).map(you).filter(sug => !(card.buttons || []).some(b => sameLabel(b, sug))))
      : [];
    addTurns(t, { who: 'owner', text }, { who: 'orb', text: reply });
    return { stay: { ok: true, stay: true, kind: reply === SAY_FALLBACK ? 'unclear' : kind, reply, ...(suggestions.length ? { suggestions } : {}), thread: t.turns.slice() } };
  }

  // On a question it is the answer; on an idea, a note the writer reworks it
  // with (the rework is the next idea); on a choice or the plain card, the
  // next idea fits it; on a yes or a finished job, a word to that member.
  async function say({ text, confirm = false, note = false, card } = {}) {
    const said = String(text || '').trim();
    if (!said) return { ok: false, reason: 'empty', message: 'say something first' };
    if (said.length > SAY_MAX) return { ok: false, reason: 'too_long', message: `keep it under ${SAY_MAX} characters` };
    let cur = state.status === 'ready' ? state.current : null;
    if (!cur) return { ok: false, reason: 'gone', message: 'there is no card on screen' };
    // words said on a card the page no longer shows act on nothing
    if (card !== undefined && card !== cur.id) return { ok: false, reason: 'gone', message: 'that card changed, so nothing was done. tap the orb for the new one' };
    let kind = cur.kind || 'bet';
    log({ card: 'bet', choice: 'say', command: null, ran: 'in process', exit_code: 0, kind, chars: said.length });
    const t = threadFor(cur.id);
    let read = { kind: 'instruction', reply: '' };
    // a second tap or a note acts on what was already read
    if (!confirm && !note) {
      const turn = await readTurn(t, said, cardForReader(view()));
      // the card moved on while it was read (a tap, do it): drop the reply.
      // Not when a wait ended on its own (nothing came back): his words are
      // said on the try-again card that took its place, never dropped
      const replaced = kind === 'wait' && state.status === 'ready' && state.current && state.current.kind === 'missed' && state.current.after === cur.id;
      if (replaced) { cur = state.current; kind = 'missed'; }
      if (state.current !== cur || state.status !== 'ready') return { ok: false, reason: 'gone', message: 'that card changed, so nothing was done' };
      if (turn.stay) return turn.stay;
      read = turn.act;
    }
    if (kind === 'question') {
      const q = cur.question;
      if (read.kind === 'answer') {
        if (q.key === 'scoreboard') {
          const out = answer({ choice: 'other', text: said });
          if (out.ok) endThread();
          return out;
        }
        appendLedger(focusFile, { workspace: deps.workspaceRoot, key: q.key, answer: 'own', label: said, ask: q.ask, at: iso() });
        if (!LOCAL_QUESTIONS.has(q.key)) appendLedger(questionsFile, { id: q.key, workspace: deps.workspaceRoot, status: 'answered' });
        state.status = 'cleared';
        endThread();
        pumpQuestions();
        return { ok: true, ack: `got it: ${said.replace(/[.\s]+$/, '')}.` };
      }
      // an instruction on a question: a note for the next idea
      state.pendingSharper = { ownerNote: said };
      state.status = 'cleared';
      endThread();
      pump();
      return { ok: true, ack: plainReply(read.reply) || 'got it. the next idea will fit that.' };
    }
    // Words on the weekly number card are about that number, and the
    // reader says what they want. A plain number is this week's value. Stop
    // tracking this, or pick a different number, stops tracking it, and the
    // next card asks which number, if any. Ask me tomorrow is not now. Any
    // other answer or instruction gets a reply on the card and changes nothing.
    if (kind === 'report') {
      const stay = (reply) => {
        addTurns(t, { who: 'owner', text: said }, { who: 'orb', text: reply });
        return { ok: true, stay: true, kind: 'unclear', reply, thread: t.turns.slice() };
      };
      if (read.kind === 'answer') {
        const saved = report({ value: said });
        if (saved.ok) { endThread(); return saved; }
        return stay('type this week\'s number in the box, or say stop tracking this.');
      }
      if (read.intent === 'later') {
        passJob(cur);
        state.status = 'cleared';
        endThread();
        return { ok: true, ack: 'got it. i will ask tomorrow.' };
      }
      if (read.intent !== 'stop' && read.intent !== 'change') return stay(plainReply(read.reply) || 'this card keeps one number a week. say stop tracking this, or ask me tomorrow.');
      const name = cur.board.name;
      appendLedger(scoreboardFile, { workspace: deps.workspaceRoot, kind: 'clear', name, at: iso() });
      log({ card: 'bet', choice: 'scoreboard_clear', command: null, ran: 'in process', exit_code: 0 });
      state.status = 'cleared';
      endThread();
      return { ok: true, ack: `got it. i stopped tracking ${name}.` };
    }
    if (kind === 'yes' || kind === 'done') {
      const out = await steer({ member: cur.job.owner, text: said, confirm, note });
      if (out.ok) endThread();
      return out;
    }
    if (kind === 'bet') {
      record(cur.id, { status: 'passed', note: 'reworked with your note', owner_note: said });
      state.pendingSharper = { reworkOf: cur.bet.title, ownerNote: said };
      state.status = 'cleared';
      endThread();
      pump();
      return { ok: true, ack: plainReply(read.reply) || 'got it. reworking that idea with your note.' };
    }
    if (kind === 'choice') passJob(cur);
    state.pendingSharper = { ownerNote: said };
    state.status = 'cleared';
    endThread();
    pump();
    return { ok: true, ack: plainReply(read.reply) || 'got it. the next idea will fit that.' };
  }

  // The talk card with one member: the same conversation. A question back is
  // answered from what the table knows; an instruction steers them.
  async function talk({ member, text, confirm = false, note = false } = {}) {
    const name = String(member || '');
    if (!(team || []).some(m => m.name === name)) return { ok: false, reason: 'gone', message: 'there is no such member on the team' };
    const said = String(text || '').trim();
    if (!said) return { ok: false, reason: 'empty', message: 'say something first' };
    if (said.length > SAY_MAX) return { ok: false, reason: 'too_long', message: `keep it under ${SAY_MAX} characters` };
    const t = threadFor(`member:${name}`);
    if (!confirm && !note) {
      const row = statusTable().rows.find(r => r.member === name);
      const turn = await readTurn(t, said, { kind: 'member', title: name, detail: row ? `${row.status}: ${row.on}. ${row.time}.` : 'no work in the last day', buttons: [] });
      if (turn.stay) return turn.stay;
    }
    const out = await steer({ member: name, text: said, confirm, note });
    if (out.ok) endThread();
    return out;
  }

  // ---- the team table: who is on what, from real state ----

  // A member is working only when a process is really running its mission,
  // or the mission moved in the last few minutes. A handoff that no process
  // picked up is waiting to start. Members with nothing in the last day are
  // left out.
  const RECENT_MS = 24 * 60 * 60 * 1000;
  const MOVING_MS = 5 * 60 * 1000;
  const STATUS_ORDER = ['waiting for your yes', 'working', 'waiting to start', 'stopped', 'done', 'idle'];
  // One mission's row: what it is on, its status, and for how long, with
  // when it last moved; null when it has not moved in the last day or is
  // not a job.
  function missionRow(m, ideaTitle) {
    const moved = Math.max(...[m.last_tick_at, m.updated_at, m.created_at].map(t => Date.parse(t || '') || 0));
    const age = now() - moved;
    if (!moved || age > RECENT_MS) return null;
    const created = Date.parse(m.created_at || '') || moved;
    const on = ideaTitle.get(m.id) || missionTitle(m.objective);
    const status = String(m.status || '');
    if (status === 'complete') return { moved, row: { on, status: 'done', time: `finished ${spanWords(age)} ago` } };
    if (status === 'stopped') return { moved, row: { on, status: 'stopped', time: `stopped ${spanWords(age)} ago` } };
    if (!OPEN_MISSION.has(status)) return null;
    const asks = (Array.isArray(m.human_asks) ? m.human_asks : []).some(a => a && !(typeof a === 'object' && a.answered_at))
      || require('./yes-lock').askedYesLocks(lockDir, m.id).length > 0;
    if (asks) return { moved, row: { on, status: 'waiting for your yes', time: `waiting ${spanWords(age)}` } };
    if (driverAlive(m) || age <= MOVING_MS) {
      const wall = Number(m.max_wall_seconds) || Number(m.budget_contract && m.budget_contract.requested_seconds) || 0;
      const left = wall ? created + wall * 1000 - now() : 0;
      return { moved, row: { on, status: 'working', time: left > 0 ? leftWords(left) : `at it for ${spanWords(now() - created)}` } };
    }
    if (!m.last_tick_at) return { moved, row: { on, status: 'waiting to start', time: `waiting ${spanWords(now() - created)}` } };
    return { moved, row: { on, status: 'stopped', time: `stopped ${spanWords(age)} ago` } };
  }

  let teamCache = null;
  function statusTable() {
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
      const r = missionRow(m, ideaTitle);
      if (r) put(m.owner, r.row, r.moved);
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

  // The team page: every member on the team, one row each. role is a few
  // words from its MEMBER.md. ovr is the board's own rating (atris gm
  // --board): 60 to 99 from the share of finished jobs that landed in the
  // last 30 days, "new" with 1 or 2 finished, and two dots with none
  // finished in that window (a first claim alone is not a rating) or no
  // task list to read. engine is the tool and the exact model the roster
  // gives the member (atris engine roster), two dots when no model is
  // pinned; a person on the team (type: human) never runs on one, so it
  // says person. A parked member is left out unless it has work on.
  const ROSTER_MS = 60 * 1000;
  let rosterCache = null;
  function rosterFacts() {
    if (rosterCache && now() - rosterCache.at < ROSTER_MS) return rosterCache.facts;
    const season = require('./gm-season');
    let ratings = new Map();
    try {
      const loaded = (deps.loadSeason || (root => season.loadSeason(root, { now: now(), lastSeen: null })))(deps.workspaceRoot);
      if (loaded && !loaded.error) ratings = season.memberRatings(loaded.outcomes || []);
    } catch { ratings = new Map(); }
    let resolve = deps.resolveEngine;
    if (!resolve) {
      const reg = require('./engine-registry');
      const { resolveEngineForMember } = require('./member-engine');
      let rosterState = null;
      try { rosterState = reg.readRosterState(deps.workspaceRoot); } catch { rosterState = null; }
      resolve = name => resolveEngineForMember(name, deps.workspaceRoot, { quiet: true, ...(rosterState ? { rosterState } : {}) });
    }
    const facts = new Map();
    const { memberTypeOf } = require('./member-type');
    for (const m of team || []) {
      const card = memberCardFacts(deps.workspaceRoot, m.name);
      const kind = memberTypeOf({ type: card.type });
      let engine = kind.type === 'human' ? 'person' : NO_RATING;
      if (kind.runnable) {
        let picked = null;
        try { picked = resolve(m.name); } catch { picked = null; }
        engine = engineWords(picked);
      }
      const rated = ratings.get(m.name);
      facts.set(m.name, {
        role: memberRoleWords(m.name, card),
        ovr: !rated || !rated.finished ? NO_RATING : rated.ovr == null ? 'new' : String(rated.ovr),
        engine,
        parked: card.parked,
      });
    }
    rosterCache = { at: now(), facts };
    return facts;
  }

  function teamTable() {
    const facts = rosterFacts();
    const byName = new Map(statusTable().rows.map(r => [r.member, r]));
    const rows = [];
    for (const m of team || []) {
      const f = facts.get(m.name) || { role: NO_RATING, ovr: NO_RATING, engine: NO_RATING, parked: false };
      const st = byName.get(m.name) || { member: m.name, on: '', status: 'idle', time: '' };
      if (f.parked && !byName.has(m.name)) continue;
      rows.push({ member: m.name, role: f.role, ovr: f.ovr, engine: f.engine, status: st.status, sentence: statusSentence(st), on: st.on, time: st.time });
    }
    rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.member.localeCompare(b.member));
    return { rows };
  }

  // The engine card: what a member runs on now and every model this machine
  // offers that can do its work, read from local files only. A tap swaps
  // through the same code as atris engine roster set (lib/roster-swap.js);
  // the owner's tap is the approval, so there is no yes card. scope member
  // gives only this member the model, scope job swaps the lead of its job.
  function onTeam(name) { return (team || []).some(m => m.name === name); }
  const NOT_ON_TEAM = { ok: false, reason: 'gone', message: 'there is no such member on the team' };
  function engineCard({ member } = {}) {
    const name = String(member || '');
    if (!onTeam(name)) return NOT_ON_TEAM;
    try {
      const read = deps.engineChoices || ((root, who, o) => require('./roster-swap').memberEngineChoices(root, who, o));
      return { ok: true, ...read(deps.workspaceRoot, name, { now: new Date(now()) }) };
    } catch (err) {
      return { ok: false, reason: 'unreadable', message: String((err && err.message) || err) };
    }
  }

  function swapEngine({ member, engine, model, scope } = {}) {
    const name = String(member || '');
    if (!onTeam(name)) return NOT_ON_TEAM;
    const where = scope === 'job' ? 'job' : 'member';
    let out;
    try {
      const swapFn = deps.swapFromCard || ((...a) => require('./roster-swap').swapFromCard(...a));
      out = swapFn(deps.workspaceRoot, name, String(engine || ''), String(model || ''), where, { now: new Date(now()) });
    } catch (err) {
      const message = String((err && err.message) || err);
      log({ card: 'bet', choice: 'engine_swap', command: null, ran: 'in process', exit_code: 2, member: name, scope: where, reason: message.slice(0, 200) });
      return { ok: false, reason: 'refused', message };
    }
    rosterCache = null;
    log({ card: 'bet', choice: 'engine_swap', command: out.command, ran: 'in process', exit_code: 0, member: name, scope: where, changed: out.changed });
    return { ok: true, ack: out.line, rows: teamTable().rows };
  }

  // ---- the job deck: one card per running job, the ones waiting on the
  // owner's yes first. Each card is one divided row: done, work, member,
  // role, ovr, engine, and status. role, ovr, and engine are the team
  // table's own cells, so the deck and the table always agree. A card that
  // needs the owner carries its yes card's two lines and the key the page
  // sends back with the yes. Every word on it is plain: no command, flag,
  // or path.
  const DECK_COLUMNS = ['done', 'work', 'member', 'role', 'ovr', 'engine', 'status'];
  const DECK_STATUS = new Set(['waiting for your yes', 'working', 'waiting to start']);

  // The yes a running job waits on: the desk's own yes card for it when it
  // has one, else a step its guard holds, else its first open ask. The keys
  // are the desk's own, so a yes said on one is said on the other. A yes only
  // passed over on the main screen is still owed, so it stays on its card.
  function yesFor(mission) {
    const said = state.answeredYes;
    const owed = (state.jobs.yes || []).filter(j => j.mission_id === mission.id && !said.has(j.key));
    const own = owed.find(j => !state.skippedYes.has(j.key)) || owed[0];
    if (own) return own;
    const owner = mission.owner || 'the team';
    for (const lock of require('./yes-lock').askedYesLocks(lockDir, mission.id)) {
      const key = `${mission.id}:step-${lock.step}:${lock.hash || ''}`;
      if (!said.has(key)) return { kind: 'yes', bet_id: null, mission_id: mission.id, owner, ask: lock.text, command: lock.held_command || null, lock_step: lock.step, lock_hash: lock.hash || null, ask_index: null, key };
    }
    const job = jobState({ id: null }, mission, null, now());
    const ask = job.kind === 'yes' ? job.asks.find(x => !said.has(`${mission.id}:${x.index}`)) : null;
    return ask ? { kind: 'yes', bet_id: null, mission_id: mission.id, owner, ask: ask.text, ask_index: ask.index, key: `${mission.id}:${ask.index}` } : null;
  }

  // One card per job, never per member: a member with two jobs has two
  // cards, each with its own table and its own yes. A handoff no run has
  // picked up yet is a job waiting to start.
  function deckCards() {
    let missions;
    try { missions = (deps.readMissions || defaultReadMissions)(deps.workspaceRoot); } catch { missions = null; }
    const names = new Set((team || []).map(m => m.name));
    const facts = new Map(teamTable().rows.map(r => [r.member, r]));
    const titles = new Map(readLedger(deps.ledgerFile, deps.workspaceRoot).filter(r => r.mission_id && r.bet).map(r => [r.mission_id, r.bet.title]));
    const jobs = [];
    for (const m of missions instanceof Map ? missions.values() : Object.values(missions || {})) {
      if (!m || !m.id || !names.has(m.owner) || !OPEN_MISSION.has(String(m.status || ''))) continue;
      const r = missionRow(m, titles);
      if (r && DECK_STATUS.has(r.row.status)) jobs.push({ id: m.id, mission: m, member: m.owner, row: r.row, moved: r.moved });
    }
    for (const hnd of (deps.readHandoffs || defaultReadHandoffs)(deps.workspaceRoot)) {
      const at = Date.parse((hnd && hnd.created_at) || '') || 0;
      if (!hnd || hnd.status !== 'open' || !names.has(hnd.to) || !at || now() - at > RECENT_MS) continue;
      const on = clip(String(hnd.summary || '').replace(/^\[[^\]]*\]\s*/, ''), 100);
      jobs.push({ id: `handoff:${hnd.id || at}`, mission: null, member: hnd.to, row: { on, status: 'waiting to start', time: `waiting ${spanWords(now() - at)}` }, moved: at });
    }
    jobs.sort((x, y) => STATUS_ORDER.indexOf(x.row.status) - STATUS_ORDER.indexOf(y.row.status) || y.moved - x.moved || x.member.localeCompare(y.member));
    // a yes skipped with not now waits at the back of the ones that need the owner
    const skipRank = x => (x.yes && state.skippedYes.get(x.yes.key)) || 0;
    const needsFirst = x => (x.card.label === 'needs you' ? 0 : 1);
    return jobs.map((j) => {
      const needs = j.row.status === 'waiting for your yes';
      const yes = needs && j.mission ? yesFor(j.mission) : null;
      const f = facts.get(j.member) || { role: NO_RATING, ovr: NO_RATING, engine: NO_RATING };
      // a job whose yes was said here is back with its member, not waiting on the owner
      const label = needs ? (yes ? 'needs you' : 'you answered') : j.row.status;
      const card = {
        job_id: j.id,
        mission_id: j.mission ? j.mission.id : null,
        member: j.member,
        label,
        time: j.row.time,
        rows: [{ done: 'not yet', work: plainWork(j.row.on, j.member), member: j.member, role: f.role, ovr: f.ovr, engine: f.engine, status: label }],
      };
      if (yes) card.yes = { key: yes.key, ...(yes.lock_hash ? { hash: yes.lock_hash } : {}), ...publicJob({ kind: 'yes', job: yes }) };
      return { card, yes };
    }).map((x, i) => ({ x, i }))
      .sort((a, b) => needsFirst(a.x) - needsFirst(b.x) || (needsFirst(a.x) ? 0 : skipRank(a.x) - skipRank(b.x)) || a.i - b.i)
      .map(p => p.x);
  }

  function jobDeck() {
    return { columns: DECK_COLUMNS, cards: deckCards().map(x => x.card) };
  }

  // A word to a member from its talk card or a card on screen. The phone
  // never calls a steer that can start anyone: it uses --no-ignite, which
  // only reaches a live run and otherwise starts nothing, and then the page
  // offers a second tap or a note. A confirmed start runs in the background
  // (--detach) and reports started or not from that. The owner's words go
  // after --, behind "the owner says:", so they are never read as options.
  const SAY_MAX = 280;
  function steeringNote(name, said) {
    const file = path.join(deps.workspaceRoot, '.atris', 'state', 'steering.jsonl');
    appendLedger(file, { schema: 'atris.steering.v1', id: `steer-${crypto.randomBytes(4).toString('hex')}`, kind: 'preference', status: 'active', scope: { member: name }, raw: said, memory: [said], created_at: iso(), source: 'gm-phone' });
  }

  async function steer({ member, text, confirm = false, note = false } = {}) {
    const name = String(member || '');
    if (!(team || []).some(m => m.name === name)) return { ok: false, reason: 'gone', message: 'there is no such member on the team' };
    const said = String(text || '').trim();
    if (!said) return { ok: false, reason: 'empty', message: 'say something first' };
    if (said.length > SAY_MAX) return { ok: false, reason: 'too_long', message: `keep it under ${SAY_MAX} characters` };
    if (note) {
      steeringNote(name, said);
      log({ card: 'bet', choice: 'steer_note', command: null, ran: 'in process', exit_code: 0, member: name, chars: said.length });
      return { ok: true, ack: `saved for ${name}'s next run.` };
    }
    const words = `the owner says: ${said}`;
    const args = ['member', 'steer', name, confirm === true ? '--detach' : '--no-ignite', '--json', '--', words];
    const res = await deps.runCli(args);
    const out = parseJsonOut(res.stdout) || {};
    log({ card: 'bet', choice: confirm === true ? 'steer_start' : 'steer', command: `atris member steer ${name} ${args[3]} --json -- "<${said.length} characters>"`, exit_code: res.code, member: name, chars: said.length, action: out.action || null });
    teamCache = null;
    if (res.code === 0 && out.action === 'member_steered') return { ok: true, ack: `sent to ${name}.` };
    if (confirm === true) {
      if (res.code === 0 && out.action === 'member_run_detached') return { ok: true, ack: `${name} is starting on it.` };
      // refused before it began: say why, in its plain words
      if (out.action === 'member_run_not_started' && out.reason) return { ok: false, reason: 'not_started', message: `${name} did not start: ${String(out.reason).replace(/[.\s]+$/, '')}.` };
      return { ok: false, reason: 'not_started', message: `${name} did not start. try again in a minute.` };
    }
    if (out.action === 'member_not_running' || res.code === 3) return { ok: false, reason: 'needs_confirm', message: `tap again to start ${name} on this` };
    return { ok: false, reason: 'steer_failed', message: 'it did not reach them. try again in a minute.' };
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

  // ---- the one card on screen (lib/gm-card.js) ----
  //
  // The page draws exactly the card served here and nothing else. Over the
  // main card (the idea, question, yes, and the rest) can sit one layer: the
  // team, a member's talk card, the job deck, or a swap card. A reply to
  // words said on a card is its own card over that card. Every action names
  // the card it acts on and one option on it; anything else is refused.
  const gmCard = require('./gm-card');
  // layer: null | { kind: team|member|deck|swap, id, ... }; reply: null | { base, id, text, suggestions, confirm, thread }
  state.layer = null;
  state.reply = null;
  state.served = null;
  state.serial = 0;
  // ids made here carry this desk's own tag, so a page left open across a
  // restart never names a card this desk made
  const deskTag = crypto.randomBytes(3).toString('hex');
  const freshId = kind => `${kind}~${deskTag}${(state.serial += 1)}`;
  const betBody = b => [b.why_now, b.expect].map(sentence).join(' ');

  // the member's facts for a card about their job
  function jobFacts(name) {
    if (!onTeam(name)) return null;
    const f = rosterFacts().get(name) || {};
    return { member: name, role: f.role || NO_RATING, ovr: f.ovr || NO_RATING, engine: f.engine || NO_RATING };
  }

  function mainCard() {
    const cur = state.current;
    if (!cur) return null;
    const kind = cur.kind || 'bet';
    if (kind === 'bet' && (state.status === 'starting' || state.status === 'started')) {
      return gmCard.started({ id: `${cur.id}:started`, title: cur.bet.title, body: betBody(cur.bet), line: state.status === 'starting' ? 'starting now' : (state.mission && state.mission.line) });
    }
    if (state.status !== 'ready') return null;
    const v = view();
    // an idea no draft beat in time carries the second look's worry, in one plain line
    if (kind === 'bet') return gmCard.idea({ id: cur.id, title: cur.bet.title, body: betBody(cur.bet), ...(cur.bet.concern ? { concern: cur.bet.concern } : {}) });
    if (kind === 'question') return gmCard.question({ id: cur.id, title: v.question.ask, body: v.question.line, choices: v.question.choices });
    if (kind === 'report') return gmCard.report({ id: cur.id, title: v.report.what, body: v.report.why });
    if (kind === 'choice') return gmCard.choice({ id: cur.id, items: v.choice.options });
    if (kind === 'wait') return gmCard.wait({ id: cur.id, ...waitProgress(cur) });
    if (kind === 'missed') return gmCard.missed({ id: cur.id });
    if (kind === 'yes') {
      const j = cur.job;
      return gmCard.yes({ id: cur.id, title: v.job.what, body: v.job.why, job: jobFacts(j.owner), request: { job: j.mission_id, key: j.key, hash: j.lock_hash || null } });
    }
    if (kind === 'done') return gmCard.done({ id: cur.id, title: v.job.what, body: v.job.why, job: jobFacts(cur.job.owner) });
    return null;
  }

  function layerCard() {
    const l = state.layer;
    if (!l) return null;
    if (l.kind === 'team') {
      const rows = teamTable().rows;
      return gmCard.team({ id: l.id, rows, line: l.line || null, deck: rows.some(r => DECK_STATUS.has(r.status)) });
    }
    if (l.kind === 'member') {
      const row = teamTable().rows.find(r => r.member === l.name);
      return gmCard.member({ id: l.id, name: l.name, sentence: row ? sentence(row.sentence) : 'nothing in the last day.', job: jobFacts(l.name), line: l.line || null });
    }
    if (l.kind === 'deck') {
      const cards = deckCards().map(x => x.card);
      if (!cards.length) return null;
      const at = Math.min(l.at || 0, cards.length - 1);
      const c = { ...cards[at], said: (l.said && l.said[cards[at].job_id]) || null };
      const r = c.rows[0];
      // the deck card is about the job: its row without the rating and the model, which live on the team table
      const columns = DECK_COLUMNS.filter(k => k !== 'ovr' && k !== 'engine');
      return gmCard.deck({ id: l.id, at, total: cards.length, card: c, columns, job: { member: c.member, role: r.role, ovr: r.ovr, engine: r.engine } });
    }
    if (l.kind === 'swap') {
      if (!l.choices) {
        const out = engineCard({ member: l.name });
        if (!out.ok) return gmCard.member({ id: l.id, name: l.name, sentence: out.message || 'could not read the models on this machine.', job: jobFacts(l.name) });
        l.choices = out;
      }
      return gmCard.swap({ id: l.id, name: l.name, choices: l.choices, scope: l.scope, all: l.all, line: l.line || null });
    }
    return null;
  }

  // the card under a reply: the layer when one is open, else the main card
  function underCard() {
    return layerCard() || mainCard();
  }

  function currentCard() {
    const under = underCard();
    if (!under) return null;
    const r = state.reply;
    if (r && r.base === under.id) {
      return gmCard.reply({ id: r.id, base: under, text: r.text, thread: r.thread, suggestions: r.suggestions, confirm: r.confirm });
    }
    if (r) state.reply = null;
    return under;
  }

  function serve() {
    const card = currentCard();
    // served under a stamped id: options that change come with a new id, so a tap on the old one does nothing
    state.served = card ? gmCard.stamp(gmCard.enforce(card, problems => log({ card: 'bet', choice: 'card_problem', command: null, ran: 'in process', exit_code: 1, kind: card.kind, problems: problems.slice(0, 5) }))) : null;
    return state.served;
  }

  // what every answer carries: the card on screen and the small lines around it
  function envelope(extra = {}) {
    const card = serve();
    const v = view();
    return {
      ok: true,
      ...extra,
      card: gmCard.wire(card),
      status: v.status,
      queue: v.queue,
      team_working: v.team_working,
      needs_you: v.needs_you,
    };
  }

  function refuse(reason, message, status = 409) {
    return { status, body: { ...envelope(), ok: false, reason, message } };
  }
  const done200 = extra => ({ status: 200, body: envelope(extra) });

  // the page opened, or looked again: the card on screen now. A read starts
  // no work: the queue fills when the desk is made, on its timer, and on an act.
  function card() {
    return envelope();
  }

  // a word that came back as a reply: the reply is the next card
  function replied(out, baseId, text) {
    if (out.stay) {
      state.reply = { base: baseId, id: freshId(`${baseId}~r`), text: out.reply, suggestions: out.suggestions || [], confirm: null, thread: (out.thread || []).slice(0, -1) };
      return done200();
    }
    if (out.reason === 'needs_confirm') {
      state.reply = { base: baseId, id: freshId(`${baseId}~r`), text: out.message, suggestions: [], confirm: { text }, thread: [] };
      return done200();
    }
    return null;
  }

  // words said on the main card, a reply on it, or its something else
  async function sayOnMain(text, more = {}) {
    const under = underCard();
    const out = await say({ text, ...more });
    // a wait that ended on its own while the words were read: the reply sits on the card that took its place
    const stays = out.stay || out.reason === 'needs_confirm';
    const base = stays && under && under.kind === 'wait' && state.current && state.current.kind === 'missed' ? (underCard() || under) : under;
    const back = replied(out, base.id, text);
    if (back) return back;
    if (!out.ok) return refuse(out.reason || 'gone', out.message || 'that did not send. try again');
    state.reply = null;
    next();
    return done200({ ack: out.ack });
  }

  // words to the member on a talk card or a deck card
  async function talkOnLayer(text, more = {}) {
    const l = state.layer;
    const under = underCard();
    const name = l.kind === 'deck' ? under.member : l.name;
    const out = await talk({ member: name, text, ...more });
    const back = replied(out, under.id, text);
    if (back) return back;
    if (!out.ok) return refuse(out.reason || 'gone', out.message || 'that did not send. try again');
    state.reply = null;
    if (l.kind === 'deck') { l.said = { ...(l.said || {}), [under.deck_job]: out.ack }; l.id = freshId('deck'); } else { l.line = out.ack; l.id = freshId('member'); }
    return done200();
  }

  function open(kind, extra = {}) {
    state.reply = null;
    state.layer = { kind, id: freshId(kind), ...extra };
    if (kind === 'deck' && !layerCard()) state.layer = { kind: 'team', id: freshId('team') };
  }

  // One action from the page: { card_id, option_id } or { card_id, text } for
  // the card's box, or { orb: true } for the next card, or { open: team|deck }
  // from the footer. confirm: the second tap on an option that asks for one.
  async function act(body = {}) {
    const cardId = body.card_id == null || body.card_id === '' ? null : String(body.card_id);
    let shown = state.served;
    let stale = Boolean(cardId && (!shown || cardId !== shown.id));
    // words typed on a wait that ended on its own (nothing came back) still
    // count: they are said on the try-again card that took its place
    const cur = state.status === 'ready' ? state.current : null;
    if (stale && cur && cur.kind === 'missed' && cur.afterServed && cur.afterServed === cardId && typeof body.text === 'string' && body.text.trim() && body.option_id == null && !state.layer) {
      state.reply = null;
      shown = serve();
      stale = false;
    }
    // the big orb: the next card; a page that names an older card gets the one on screen, and nothing is passed
    if (body.orb === true) {
      if (stale && shown) return done200();
      state.layer = null;
      state.reply = null;
      const out = next({ sharper: false });
      return done200(out.busy ? { busy: true } : {});
    }
    if (body.open === 'team' || body.open === 'deck') {
      if (stale) return refuse('gone', 'that card changed. here is the one on screen now');
      open(body.open);
      return done200();
    }
    // an option or words always name the card they were for
    if (!shown || !cardId || stale) return refuse('gone', 'that card changed, so nothing was done. here is the one on screen now');
    const optionId = body.option_id == null ? null : String(body.option_id);
    const opt = optionId ? shown.options.find(o => o.id === optionId) : null;
    if (optionId && !opt) return refuse('bad_option', 'that is not on this card');
    if (!opt && !shown.input) return refuse('bad_option', 'this card has no box to type in');
    const typed = String(body.text == null ? '' : body.text).trim();
    if ((!opt || opt.type) && !typed) return refuse('empty', 'say something first');
    if (opt && opt.confirm && body.confirm !== true) return { status: 409, body: { ...envelope(), ok: false, reason: 'needs_confirm', message: opt.confirm } };
    const action = opt ? opt.action : shown.input.action;
    const b = (opt && opt.binds) || {};
    const onLayer = Boolean(state.layer);
    log({ card: 'bet', choice: 'act', command: null, ran: 'in process', exit_code: 0, kind: shown.kind, action, option: optionId });
    switch (action) {
      case 'do': {
        const out = await doIt();
        if (!out.ok) return refuse(out.reason, out.message);
        next();
        return done200({ ack: out.ack });
      }
      case 'sharper': next({ sharper: true }); return done200();
      case 'skip': {
        const out = skip();
        if (!out.ok) return refuse(out.reason, out.message);
        state.reply = null;
        return done200({ ack: out.ack, home: true });
      }
      case 'next': next(); return done200();
      case 'later': {
        if (onLayer && state.layer.kind === 'deck') {
          state.seenYes.add(b.key);
          state.skips += 1;
          state.skippedYes.set(b.key, state.skips);
          state.layer.id = freshId('deck');
          return done200();
        }
        state.reply = null;
        next({ later: true });
        return done200();
      }
      case 'yes':
      case 'no': {
        const out = await (action === 'yes' ? answerYes : answerNo)({ key: b.key, job: b.job });
        if (!out.ok) return refuse(out.reason, out.message);
        state.reply = null;
        if (onLayer && state.layer.kind === 'deck') {
          state.layer.said = { ...(state.layer.said || {}), [shown.deck_job]: out.ack };
          state.layer.id = freshId('deck');
          return done200();
        }
        next();
        return done200({ ack: out.ack });
      }
      case 'nice': {
        const out = nice();
        if (!out.ok) return refuse(out.reason, out.message);
        next();
        return done200({ ack: out.ack });
      }
      case 'answer': {
        const out = answer({ choice: b.choice });
        if (!out.ok) return refuse(out.reason, out.message);
        state.reply = null;
        next();
        return done200();
      }
      case 'pick': {
        const out = pick({ id: b.bet });
        if (!out.ok) return refuse(out.reason, out.message);
        return done200();
      }
      case 'report': {
        const raw = typed.replace(/,/g, '');
        if (/^-?\d+(\.\d+)?$/.test(raw)) {
          const out = report({ value: raw });
          if (!out.ok) return refuse(out.reason, out.message);
          state.reply = null;
          next();
          return done200({ ack: out.ack });
        }
        return sayOnMain(typed);
      }
      case 'say': return onLayer ? talkOnLayer(typed || b.text) : sayOnMain(typed || b.text);
      case 'talk': return talkOnLayer(typed);
      case 'start':
      case 'note': {
        const more = action === 'start' ? { confirm: true } : { note: true };
        return onLayer ? talkOnLayer(b.text, more) : sayOnMain(b.text, more);
      }
      case 'back': {
        if (state.reply) { state.reply = null; return done200(); }
        const l = state.layer;
        // a talk card, a swap card, and the job deck go back to the whole team; the team goes back to the card under it
        if (l && l.kind !== 'team') open('team');
        else state.layer = null;
        return done200();
      }
      case 'member': open('member', { name: b.member }); return done200();
      case 'swap': open('swap', { name: b.member, scope: 'member', all: false }); return done200();
      case 'deck': open('deck', { at: 0 }); return done200();
      case 'flip': {
        const n = deckCards().length;
        if (n) state.layer.at = (((state.layer.at || 0) + (Number(b.step) || 1)) % n + n) % n;
        state.layer.id = freshId('deck');
        return done200();
      }
      case 'scope': state.layer.scope = b.scope === 'job' ? 'job' : 'member'; state.layer.id = freshId('swap'); return done200();
      // more models: the same card, with every model on it
      case 'more': state.layer.all = true; return done200();
      case 'swap_to': {
        const out = swapEngine({ member: state.layer.name, engine: b.engine, model: b.model, scope: b.scope });
        if (!out.ok) return refuse(out.reason, out.message);
        open('team', { line: out.ack });
        return done200({ ack: out.ack });
      }
      default: return refuse('bad_option', 'that does nothing here');
    }
  }

  return { warm, next, pick, say, talk, report, teamTable, jobDeck, engineCard, swapEngine, steer, skip, doIt, nice, answerYes, answerNo, answer, pollJobs, settle, yesCards, recordYes, view, card, act, state };
}

module.exports = {
  plainAsk,
  BACKOFF_MS,
  FALLBACK_QUESTION,
  readScoreboard,
  readSaid,
  generateScoreboardChoices,
  scoreboardPath,
  choiceWhy,
  JOB_POLL_MS,
  readDeskMissions,
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
  stopWriters,
  scoreBets,
  skepticCommand,
  buildSkepticPrompt,
  writerCommand,
  WRITER_ANGLES,
  validateBet,
};
