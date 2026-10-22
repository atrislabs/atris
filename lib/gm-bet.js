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
const MODEL_TIMEOUT_MS = 120000;
const CHECK_WINDOW_DAYS = 14;
const BRIEF_COUNT = 3;
const BRIEF_LINES = 40;
const NOW_LINES = 60;
const OUTPUT_MAX = 2 * 1024 * 1024;
const MIN_STEPS = 2;
const MAX_STEPS = 8;

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
const METRIC_SOURCES = ['npm', 'install', 'download', 'git', 'master', 'landed', 'commit', 'task', 'target', 'season', 'gm', 'ledger', 'bet', 'now.md', 'brief', 'mission'];

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

function defaultGitLanded(workspaceRoot) {
  const { spawnSync } = require('child_process');
  for (const ref of ['origin/master', 'origin/main']) {
    const res = spawnSync('git', ['log', ref, '--first-parent', '--since=7 days ago', '--format=%s%x1f%b%x1e'], { cwd: workspaceRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (res.status === 0) return landedRows(res.stdout);
  }
  return null;
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

// Reads every source, in a fixed order, and emits one event per source with
// a real fact (or says it was left out). A missing source is omitted, never
// invented.
async function readBundle(workspaceRoot, { deps = {}, emit = () => {}, ledgerFile } = {}) {
  const bundle = { workspace: workspaceRoot, sources: {}, facts: [] };
  const add = (key, fact, data) => {
    bundle.sources[key] = { fact, ...data };
    bundle.facts.push(fact);
    emit({ kind: 'source', key, line: fact });
  };
  const skip = (key, why) => emit({ kind: 'skip', key, line: why });

  const now = (deps.readNow || readNow)(workspaceRoot);
  if (now) add('now', now.fact, { text: now.text });
  else skip('now', 'no atris/now.md, left out');

  let season = null;
  try {
    season = (deps.seasonFacts || defaultSeasonFacts)(workspaceRoot);
  } catch {
    season = null;
  }
  if (season) add('season', seasonFact(season), { data: season });
  else skip('season', 'could not read the task list, left out');

  let landed = null;
  try {
    landed = (deps.gitLanded || defaultGitLanded)(workspaceRoot);
  } catch {
    landed = null;
  }
  if (landed) add('landed', `changes merged this week: ${commas(landed.length)}`, { subjects: landed.slice(0, 40) });
  else skip('landed', 'could not read what landed on master, left out');

  const pkg = deps.packageName !== undefined ? deps.packageName : packageName(workspaceRoot);
  let installs = null;
  if (pkg) {
    try {
      installs = installWeeks(await (deps.fetchJson || defaultFetchJson)(`https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(pkg).replace('%40', '@')}`));
    } catch {
      installs = null;
    }
  }
  if (installs) {
    const before = installs.week_before == null ? '' : ` (week before: ${commas(installs.week_before)})`;
    add('installs', `installs last week: ${commas(installs.last_week)}${before}`, { package: pkg, data: installs });
  } else {
    skip('installs', pkg ? 'could not reach npm for installs, left out' : 'no published package here, installs left out');
  }

  const briefs = (deps.readBriefs || readBriefs)(workspaceRoot);
  if (briefs && briefs.length) add('briefs', `read ${plural(briefs.length, 'research brief')}, newest: ${briefs[0].title}`, { briefs });
  else skip('briefs', 'no research briefs in atris/wiki/briefs, left out');

  const bets = readLedger(ledgerFile || ledgerPath(), workspaceRoot);
  add('ledger', ledgerLine(bets), { bets: bets.slice(-10).map(b => ({ title: b.bet && b.bet.title, status: b.status, expect: b.bet && b.bet.expect, check_date: b.bet && b.bet.check_date })) });
  return bundle;
}

function bundleText(bundle) {
  const s = bundle.sources;
  const parts = ['## facts', ...bundle.facts.map(f => `- ${f}`)];
  if (s.now) parts.push('', '## atris/now.md', s.now.text);
  if (s.landed && s.landed.subjects.length) parts.push('', '## changes merged on master in the last 7 days', ...s.landed.subjects.map(x => `- ${x}`));
  if (s.installs) parts.push('', `## npm installs for ${s.installs.package}`, `last week: ${s.installs.data.last_week}`, `week before: ${s.installs.data.week_before == null ? 'unknown' : s.installs.data.week_before}`, `through: ${s.installs.data.through}`);
  if (s.briefs) for (const b of s.briefs.briefs) parts.push('', `## research brief: ${b.name}`, b.text);
  if (s.ledger && s.ledger.bets.length) parts.push('', '## past bets', ...s.ledger.bets.map(b => `- ${b.title} (${b.status}; expected ${b.expect}; check ${b.check_date})`));
  return parts.join('\n');
}

// ---- the prompt ----------------------------------------------------------------------

function buildPrompt(bundle, { today, previousTitle = null, reason = null } = {}) {
  const lines = [
    'You are the strategist for a small software business. Below is everything we can read about it right now.',
    'Propose exactly ONE bet: a new, specific business move that is not already written down in these sources, that this team can start this week.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"title": "...", "why_now": "...", "expect": "...", "check_in_days": 7, "metric_source": "...", "cost": "...", "steps": [{"text": "...", "who": "team", "public": false}]}',
    '',
    'Rules:',
    '- title: one sentence that starts with an action verb and names a concrete deliverable (a page, a command, a post, an email, a demo, a price). Under 120 characters.',
    `- never use these as the whole action: ship it, improve, optimize, leverage, enhance, boost, streamline, grow, scale, explore.`,
    '- why_now: one or two sentences that quote at least one exact fact from the facts list below, with its number.',
    '- expect: a number and a metric, for example "300 more installs in the week after".',
    `- check_in_days: a whole number from 1 to ${CHECK_WINDOW_DAYS}, how many days from today until we read the number. we work out the date.`,
    '- metric_source: where we will read that number, and it must be one of the sources below (npm installs, what landed on master, the weekly target and season, the bets ledger).',
    '- cost: team time and money, for example "about 6 hours of agent time, $0".',
    `- steps: ${MIN_STEPS} to ${MAX_STEPS} exact steps in order. who is "team" for work the agents can do alone and "you" for anything the owner must approve. public is true when the step is visible outside the company.`,
    '- any step that publishes, posts, releases, sends, launches, spends money, or cannot be undone must be who "you". at least one step must be who "team".',
    '- write in plain lowercase-friendly words, no hype, no em dashes.',
  ];
  if (previousTitle) lines.push('', `Make it sharper, more specific, and different from: ${previousTitle}`);
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

function validateBet(bet, { bundle, today, previousTitle = null } = {}) {
  const reasons = [];
  if (!bet || typeof bet !== 'object' || Array.isArray(bet)) return { ok: false, reasons: ['the answer was not one JSON object'] };
  const str = k => (typeof bet[k] === 'string' ? bet[k].trim() : '');
  for (const k of ['title', 'why_now', 'expect', 'metric_source', 'cost']) {
    if (!str(k)) reasons.push(`${k} is missing`);
  }
  if (str('title')) {
    const p = titleProblem(str('title'));
    if (p) reasons.push(p);
    if (previousTitle && normTitle(str('title')) === normTitle(previousTitle)) reasons.push('the title repeats the previous bet');
  }
  if (str('why_now') && bundle && !citesBundle(str('why_now'), bundle)) reasons.push('why_now does not quote a fact from the sources');
  if (str('expect') && !(/\d/.test(str('expect')) && /[a-z]{3,}/i.test(str('expect')))) reasons.push('expect needs a number and a metric');
  // the model picks a number of days; the date is ours, so a time zone or a
  // clock change can never push it out of the window. Out of range is a
  // reject with the reason, never a clamp.
  if (bet.check_in_days === undefined || bet.check_in_days === null) reasons.push('check_in_days is missing');
  else if (!Number.isInteger(bet.check_in_days) || bet.check_in_days < 1 || bet.check_in_days > CHECK_WINDOW_DAYS) {
    reasons.push(`check_in_days must be a whole number from 1 to ${CHECK_WINDOW_DAYS}, got ${JSON.stringify(bet.check_in_days)}`);
  }
  if (str('metric_source') && !METRIC_SOURCES.some(k => str('metric_source').toLowerCase().includes(k))) reasons.push('metric_source is not a source we can read');
  if (str('cost').length > 200) reasons.push('cost is longer than 200 characters');
  const steps = Array.isArray(bet.steps) ? bet.steps : null;
  if (!steps) reasons.push('steps is missing');
  else if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) reasons.push(`steps must have ${MIN_STEPS} to ${MAX_STEPS} items`);
  else {
    steps.forEach((s, i) => {
      const n = i + 1;
      if (!s || typeof s.text !== 'string' || !s.text.trim()) reasons.push(`step ${n} has no text`);
      else if (s.text.length > 240) reasons.push(`step ${n} is longer than 240 characters`);
      if (!s || (s.who !== 'team' && s.who !== 'you')) reasons.push(`step ${n} who must be "team" or "you"`);
      if (!s || typeof s.public !== 'boolean') reasons.push(`step ${n} public must be true or false`);
      if (s && s.who === 'team' && (s.public === true || ownerOnlyAction(s.text))) reasons.push(`step ${n} reaches the outside world or cannot be undone, so it must be who "you"`);
    });
    if (!steps.some(s => s && s.who === 'team')) reasons.push('no step is for the team');
  }
  return { ok: reasons.length === 0, reasons };
}

// The owner's local calendar date n days after today (YYYY-MM-DD), counted
// in calendar days so a clock change never shifts it.
function addDays(today, n) {
  const [y, m, d] = String(today).split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12, 0, 0).getTime());
}

function cleanBet(bet, today) {
  return {
    title: bet.title.trim(),
    why_now: bet.why_now.trim(),
    expect: bet.expect.trim(),
    check_in_days: bet.check_in_days,
    check_date: addDays(today, bet.check_in_days),
    metric_source: bet.metric_source.trim(),
    cost: bet.cost.trim(),
    steps: bet.steps.map(s => ({ text: s.text.trim(), who: s.who, public: s.public })),
  };
}

// ---- one generation ----------------------------------------------------------------------

// Reads the sources, asks the model, checks the answer, and retries once with
// the reasons. Resolves { ok, bet, bundle } or { ok: false, reason }.
// Every model attempt is kept (raw answer, parse result, reasons, timing), so
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

async function generateBet({ workspaceRoot, today, previousTitle = null, emit = () => {}, deps = {}, ledgerFile, attemptsFile } = {}) {
  const bundle = await readBundle(workspaceRoot, { deps, emit, ledgerFile });
  const run = deps.runModel || runModel;
  const clock = deps.now || Date.now;
  let reason = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    emit({ kind: 'model', line: attempt === 1 ? 'asking the model for one bet' : 'asking again with the reasons' });
    const prompt = buildPrompt(bundle, { today, previousTitle, reason });
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
    const ms = clock() - started;
    const base = { at: new Date(clock()).toISOString(), workspace: workspaceRoot, today, attempt, previous_title: previousTitle, ms };
    if (!answer.ok) {
      saveAttempt(attemptsFile, { ...base, model_ok: false, raw: null, parse: null, passed: false, reasons: [answer.reason] });
      return { ok: false, reason: answer.reason, bundle };
    }
    const parsed = parseBet(answer.text);
    const check = parsed.error ? { ok: false, reasons: [parsed.error] } : validateBet(parsed.bet, { bundle, today, previousTitle });
    saveAttempt(attemptsFile, {
      ...base,
      model_ok: true,
      raw: String(answer.text).slice(0, 20000),
      parse: parsed.error || 'ok',
      passed: check.ok,
      reasons: check.reasons,
    });
    if (check.ok) {
      emit({ kind: 'check', line: 'checked the bet: every rule passed' });
      return { ok: true, bet: cleanBet(parsed.bet, today), bundle, attempts: attempt };
    }
    reason = check.reasons.slice(0, 4).join('; ');
    emit({ kind: 'reject', line: attempt === 1 ? `first answer turned down: ${reason}` : `second answer turned down too: ${reason}` });
  }
  return { ok: false, reason: `the model's answer broke the rules twice (${reason})`, bundle };
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
  // the title decides first, then the steps
  for (const [re, pick] of [[code, asCode], [launch, asLaunch]]) if (re.test(title) && exists(pick.owner)) return pick;
  for (const [re, pick] of [[code, asCode], [launch, asLaunch]]) if (re.test(text) && exists(pick.owner)) return pick;
  return { owner: 'mission-lead', lane: 'workspace' };
}

const YES_RULE = 'rule: a step marked "your yes" must stop and ask the owner before anything happens; never do it yourself. file a decision card for it and wait until the owner\'s yes reaches you as a ping from gm-phone.';

function missionObjective(bet) {
  const steps = bet.steps.map((s, i) => `${i + 1}. [${s.who === 'you' ? 'your yes' : 'team'}] ${s.text}`);
  return [
    `${bet.title.replace(/[.\s]+$/, '')}.`,
    `why now: ${bet.why_now}`,
    `we expect ${bet.expect}, read from ${bet.metric_source} on ${bet.check_date}.`,
    `steps: ${steps.join(' ')}`,
    YES_RULE,
  ].join(' ');
}

const MISSION_VERIFY = 'git diff --check';
const MISSION_STOP = 'every team step is done with proof, and every your-yes step was asked, not done';

function missionStartArgs(bet, { owner, lane }) {
  return ['mission', 'start', missionObjective(bet), '--owner', owner, '--runner', 'claude', '--lane', lane, '--verify', MISSION_VERIFY, '--stop', MISSION_STOP, '--budget', 'long', '--json'];
}

function missionRunArgs(missionId) {
  return ['mission', 'run', missionId, '--detach', '--json'];
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

// ---- the desk: one bet at a time, shared by the page ------------------------------------------

// deps:
//   workspaceRoot, ledgerFile         where
//   generate(opts)                    -> generateBet result (tests stub)
//   runCli(args)                      -> Promise<{ code, stdout, stderr }>
//   log(row)                          receipt row for gm-phone-actions.jsonl
//   now()                             clock
function createBetDesk(deps) {
  const now = deps.now || Date.now;
  const generate = deps.generate || (opts => generateBet({ ...opts, deps: deps.generatorDeps || {}, ledgerFile: deps.ledgerFile, attemptsFile: deps.attemptsFile }));
  const log = deps.log || (() => {});
  const state = { status: 'idle', run: 0, events: [], bet: null, id: null, error: null, mission: null, previous: null, lastTitle: null, yes: {} };

  const record = (patch) => {
    appendLedger(deps.ledgerFile, { id: state.id, workspace: deps.workspaceRoot, at: new Date(now()).toISOString(), ...patch });
  };

  function think({ sharper = false } = {}) {
    if (state.status === 'thinking' || state.status === 'starting') return { ok: false, reason: 'busy', message: 'already working on it' };
    const previousTitle = sharper ? state.lastTitle : null;
    if (sharper && state.bet && state.status === 'ready') {
      record({ status: 'skipped', note: 'asked for a sharper idea' });
    }
    state.run += 1;
    const run = state.run;
    Object.assign(state, { status: 'thinking', events: [], bet: null, id: null, error: null, mission: null, previous: previousTitle, yes: {} });
    const emit = (ev) => {
      if (run !== state.run) return;
      state.events.push({ i: state.events.length, at: now(), ...ev });
    };
    log({ card: 'bet', choice: sharper ? 'sharper' : 'think', command: null, ran: 'in process', exit_code: 0 });
    state.done = Promise.resolve()
      .then(() => generate({ workspaceRoot: deps.workspaceRoot, today: dayKey(now()), previousTitle, emit }))
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        if (run !== state.run) return;
        if (!out.ok) {
          state.status = 'failed';
          state.error = out.reason;
          emit({ kind: 'failed', line: out.reason });
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 1, error: clip(out.reason, 200) });
          return;
        }
        state.id = `bet-${dayKey(now())}-${crypto.randomBytes(4).toString('hex')}`;
        state.bet = out.bet;
        state.lastTitle = out.bet.title;
        state.status = 'ready';
        record({ created_at: new Date(now()).toISOString(), status: 'proposed', bet: out.bet, previous_title: previousTitle });
        emit({ kind: 'done', line: 'bet ready' });
        log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 0, bet_id: state.id });
      });
    return { ok: true };
  }

  function skip() {
    if (state.status !== 'ready') return { ok: false, reason: 'gone', message: 'there is no bet to skip' };
    record({ status: 'skipped' });
    log({ card: 'bet', choice: 'skip', command: null, ran: 'in process', exit_code: 0, bet_id: state.id });
    state.status = 'skipped';
    return { ok: true, ack: 'not now. all clear.' };
  }

  async function doIt() {
    if (state.status !== 'ready') return { ok: false, reason: 'gone', message: 'there is no bet to start' };
    const bet = state.bet;
    const pick = pickOwner(bet, deps.workspaceRoot);
    const startArgs = missionStartArgs(bet, pick);
    state.status = 'starting';
    const display = args => require('./gm-phone').displayCommand(args);
    let res = await deps.runCli(startArgs);
    log({ card: 'bet', choice: 'do', command: display(startArgs), exit_code: res.code, bet_id: state.id });
    const started = parseJsonOut(res.stdout);
    const missionId = started && (started.mission ? started.mission.id : started.mission_id);
    if (res.code !== 0 || !missionId) {
      state.status = 'ready';
      const why = clip((res.stderr || res.stdout || '').trim().split('\n').pop(), 160);
      return { ok: false, reason: 'start_failed', message: `the mission did not start${why ? `: ${why}` : ''}` };
    }
    const owner = (started.mission && started.mission.owner) || pick.owner;
    record({ status: 'doing', mission_id: missionId, owner });
    const runArgs = missionRunArgs(missionId);
    res = await deps.runCli(runArgs);
    log({ card: 'bet', choice: 'do', command: display(runArgs), exit_code: res.code, bet_id: state.id, mission_id: missionId });
    const ran = parseJsonOut(res.stdout) || {};
    let line;
    if (res.code === 0 && ran.action === 'mission_run_detached') line = `${owner} has it. the mission is running now.`;
    else if (ran.reason === 'human_asks_open') line = `${owner} has it, and is waiting on your yes before it starts.`;
    else line = `${owner} has the mission, but it did not start running (exit code ${res.code}). run it from the mac: atris mission run ${missionId}`;
    state.status = 'started';
    state.mission = { id: missionId, owner, line, commands: [display(startArgs), display(runArgs)] };
    return { ok: true, ack: line, mission: state.mission };
  }

  // Decision cards for the steps that need the owner's yes, once the mission
  // exists. Saying yes tells the mission with a ping; it runs nothing public.
  function yesCards() {
    if (state.status !== 'started' || !state.mission) return [];
    return state.bet.steps.map((step, i) => ({ step, i })).filter(x => x.step.who === 'you' && !state.yes[x.i]).map(({ step, i }) => ({
      id: `yes-${i}`,
      text: `your yes: ${step.text}`,
      moves: null,
      bet_step: i,
      choices: [
        {
          id: 'yes',
          label: 'yes, tell the mission',
          effect: 'records your yes. nothing goes out until the mission does this step.',
          member: state.mission.owner,
          ack: `${state.mission.owner}: got your yes`,
          confirm: true,
          steps: [yesPingArgs(state.mission.id, step)],
        },
        { id: 'later', label: 'later' },
      ],
    }));
  }

  function recordYes(i) {
    state.yes[i] = now();
    record({ yes: { ...state.yes } });
  }

  function view() {
    return {
      status: state.status,
      id: state.id,
      events: state.events.map(e => ({ i: e.i, kind: e.kind, line: e.line, ...(e.n != null ? { n: e.n } : {}) })),
      bet: state.bet,
      error: state.error,
      previous: state.previous,
      mission: state.mission ? { owner: state.mission.owner, line: state.mission.line } : null,
    };
  }

  return { think, skip, doIt, yesCards, recordYes, view, state };
}

module.exports = {
  MODEL_TIMEOUT_MS,
  YES_RULE,
  buildPrompt,
  addDays,
  attemptsPath,
  bundleText,
  citesBundle,
  claudeArgs,
  createBetDesk,
  generateBet,
  installWeeks,
  ledgerPath,
  makeCliRunner,
  missionObjective,
  modelEnv,
  pickOwner,
  readBundle,
  readLedger,
  runModel,
  validateBet,
};
