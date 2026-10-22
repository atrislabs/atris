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
// how many past weeks the normal swing is measured over
const SWING_WEEKS = 8;
// a target must clear twice the biggest week-over-week change
const SWING_MULTIPLE = 2;
// a bet whose number cannot be read yet (npm lags a few days) is tried again
// for this many days past its check date, then marked unreadable
const SCORE_GRACE_DAYS = 7;
const BRIEF_COUNT = 3;
const BRIEF_LINES = 40;
const NOW_LINES = 60;
const OUTPUT_MAX = 2 * 1024 * 1024;
const MIN_STEPS = 2;
const MAX_STEPS = 5;
// the card has to fit one phone screen with do it visible
const WHY_MAX = 160;
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
const METRIC_SOURCES = ['npm', 'install', 'download', 'git', 'master', 'landed', 'commit', 'task', 'target', 'season', 'gm', 'ledger', 'bet', 'now.md', 'brief', 'mission'];
// The numbers a bet's target can name: each one we can read again on the
// check date, from the same place, the same way.
const METRICS = {
  installs: { name: 'installs', what: 'npm installs in a week', now: 'installs last week' },
  landed: { name: 'changes merged', what: 'changes merged on master in a week', now: 'changes merged this week' },
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

// ---- normal swing: how much a number moves in a week with nothing special done

// The biggest change from one week to the next. totals are newest first.
function weeklySwing(totals) {
  const t = (totals || []).filter(n => Number.isFinite(n)).slice(0, SWING_WEEKS);
  if (t.length < 2) return null;
  let swing = 0;
  for (let i = 0; i + 1 < t.length; i += 1) swing = Math.max(swing, Math.abs(t[i] - t[i + 1]));
  return { swing, weeks: t.length };
}

// npm days, oldest first, cut into full 7-day blocks from the newest day back.
// Days before the package had any installs are not weeks it existed.
function installTotals(body, weeks = SWING_WEEKS) {
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

// Commit times (unix seconds) counted into 7-day blocks ending at nowMs,
// newest first. A block that starts before the first commit is left out.
function countWeeks(times, nowMs, { weeks = SWING_WEEKS, since = null } = {}) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const totals = [];
  for (let k = 0; k < weeks; k += 1) {
    const end = nowMs - k * WEEK;
    const start = end - WEEK;
    if (since !== null && start < since) break;
    totals.push(times.filter(t => t * 1000 > start && t * 1000 <= end).length);
  }
  return totals;
}

function defaultLandedWeeks(workspaceRoot, nowMs = Date.now()) {
  const ref = mainRef(workspaceRoot);
  if (!ref) return null;
  const out = gitOut(workspaceRoot, ['log', ref, '--first-parent', `--since=${SWING_WEEKS * 7 + 1} days ago`, '--format=%ct']);
  if (out === null) return null;
  const roots = gitOut(workspaceRoot, ['rev-list', '--first-parent', '--max-parents=0', ref]);
  const root = roots && roots.trim().split('\n')[0];
  const born = root ? Number(gitOut(workspaceRoot, ['log', '-1', '--format=%ct', root])) * 1000 : null;
  const times = out.split('\n').map(Number).filter(Number.isFinite).filter(n => n > 0);
  return countWeeks(times, nowMs, { since: Number.isFinite(born) ? born : null });
}

function swingFact(metric, s) {
  return `normal weekly swing in ${METRICS[metric].name}: up to ${commas(s.swing)} over the last ${plural(s.weeks, 'week')}`;
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

// Reads one metric over the 7 days that end on `end` (inclusive), from the
// same place the bundle reads it. Resolves { value } or { error, transient };
// transient means try again later (npm has not counted the days yet, or the
// network is down), not transient means it can never be read here.
async function defaultReadMetricWeek(metric, { workspaceRoot, start, end, deps = {} }) {
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
  if (metric === 'landed') {
    const ref = mainRef(workspaceRoot);
    if (!ref) return { error: 'could not read master here', transient: true };
    const out = gitOut(workspaceRoot, ['log', ref, '--first-parent', `--since=${start} 00:00:00`, `--until=${end} 23:59:59`, '--format=%H']);
    if (out === null) return { error: 'could not read the git history', transient: true };
    return { value: out.split('\n').filter(l => l.trim()).length };
  }
  return { error: `there is no way to read "${metric}"`, transient: false };
}

// Scores every bet the team is doing whose check date has passed: reads its
// target number over the 7 days ending on the check date and records won or
// lost with the real number. Proposed bets are never scored. A number that
// can never be read is marked unreadable with why; one that is only late
// (npm lags) waits up to SCORE_GRACE_DAYS before it is.
async function scoreBets(workspaceRoot, { ledgerFile = ledgerPath(), today = dayKey(Date.now()), deps = {}, emit = () => {} } = {}) {
  const due = readLedger(ledgerFile, workspaceRoot).filter(b => b.status === 'doing' && b.bet && /^\d{4}-\d{2}-\d{2}$/.test(String(b.bet.check_date || '')) && b.bet.check_date < today);
  const read = deps.readMetricWeek || defaultReadMetricWeek;
  const scored = [];
  for (const b of due) {
    const t = b.bet.target;
    const row = { id: b.id, workspace: workspaceRoot, at: new Date().toISOString(), scored_on: today };
    const end = b.bet.check_date;
    const start = addDays(end, -6);
    let out;
    if (!t || !METRICS[t.metric] || !Number.isFinite(t.goal)) {
      out = { error: t && t.metric && !METRICS[t.metric] ? `there is no way to read "${t.metric}"` : 'the bet has no target number to read', transient: false };
    } else {
      try {
        out = await read(t.metric, { workspaceRoot, start, end, deps });
      } catch (err) {
        out = { error: String((err && err.message) || err), transient: true };
      }
    }
    if (!out || !Number.isFinite(out.value)) {
      const why = (out && out.error) || 'the number could not be read';
      if (out && out.transient && daysBetween(end, today) <= SCORE_GRACE_DAYS) continue;
      Object.assign(row, { status: 'unreadable', why });
    } else {
      Object.assign(row, { status: out.value >= t.goal ? 'won' : 'lost', actual: out.value, window: `${start} to ${end}` });
    }
    appendLedger(ledgerFile, row);
    scored.push({ ...row, title: b.bet.title });
    const line = row.status === 'unreadable' ? `could not score a past bet: ${clip(b.bet.title, 60)} (${row.why})` : `scored a past bet: ${row.status}, ${clip(b.bet.title, 60)} (goal ${commas(t.goal)}, got ${commas(row.actual)})`;
    emit({ kind: 'score', key: 'score', line });
  }
  return scored;
}

// The readable numbers in this bundle: today's value and its normal swing.
function bundleMetrics(bundle) {
  const s = (bundle && bundle.sources) || {};
  const out = {};
  if (s.installs) out.installs = { baseline: s.installs.data.last_week, swing: s.installs.swing ? s.installs.swing.swing : null };
  if (s.landed && Number.isFinite(s.landed.count)) out.landed = { baseline: s.landed.count, swing: s.landed.swing ? s.landed.swing.swing : null };
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
  if (landed) add('landed', `changes merged this week: ${commas(landed.length)}`, { subjects: landed.slice(0, 40), count: landed.length });
  else skip('landed', 'could not read what landed on master, left out');
  if (landed) {
    let swing = null;
    try {
      swing = weeklySwing((deps.landedWeeks || defaultLandedWeeks)(workspaceRoot));
    } catch {
      swing = null;
    }
    if (swing) {
      bundle.sources.landed.swing = swing;
      add('landed_swing', swingFact('landed', swing), { metric: 'landed', ...swing });
    } else {
      skip('landed_swing', 'not enough weeks of history to know the normal swing in changes merged');
    }
  }

  const pkg = deps.packageName !== undefined ? deps.packageName : packageName(workspaceRoot);
  const fetchJson = deps.fetchJson || defaultFetchJson;
  let installs = null;
  let installBody = null;
  if (pkg) {
    try {
      // a year of days: last week, the week before, and 8 full weeks of swing
      installBody = await fetchJson(`https://api.npmjs.org/downloads/range/last-year/${npmName(pkg)}`);
      installs = installWeeks(installBody);
    } catch {
      installs = null;
    }
  }
  if (installs) {
    const before = installs.week_before == null ? '' : ` (week before: ${commas(installs.week_before)})`;
    add('installs', `installs last week: ${commas(installs.last_week)}${before}`, { package: pkg, data: installs });
    const swing = weeklySwing(installTotals(installBody));
    if (swing) {
      bundle.sources.installs.swing = swing;
      add('installs_swing', swingFact('installs', swing), { metric: 'installs', ...swing });
    } else {
      skip('installs_swing', 'not enough weeks of installs to know the normal swing');
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
  if (s.now) parts.push('', '## atris/now.md', s.now.text);
  if (s.landed && s.landed.subjects.length) parts.push('', '## changes merged on master in the last 7 days', ...s.landed.subjects.map(x => `- ${x}`));
  if (s.installs) parts.push('', `## npm installs for ${s.installs.package}`, `last week: ${s.installs.data.last_week}`, `week before: ${s.installs.data.week_before == null ? 'unknown' : s.installs.data.week_before}`, `through: ${s.installs.data.through}`);
  if (s.release) parts.push('', '## release', `published on npm: ${s.release.version}`, `changes on master not in it: ${s.release.unpublished == null ? 'unknown' : s.release.unpublished}`);
  if (s.briefs) for (const b of s.briefs.briefs) parts.push('', `## research brief: ${b.name}`, b.text);
  if (s.ledger && s.ledger.bets.length) parts.push('', '## past bets', ...s.ledger.bets.map(pastBetLine));
  return parts.join('\n');
}

// ---- the prompt ----------------------------------------------------------------------

function metricChoices(bundle) {
  const m = bundleMetrics(bundle);
  return Object.keys(m).map((k) => {
    const swing = m[k].swing == null ? 'normal swing unknown' : `normal weekly swing up to ${commas(m[k].swing)}, so the goal must be at least ${commas(m[k].baseline + SWING_MULTIPLE * m[k].swing)}`;
    return `"${k}" (${METRICS[k].what}; baseline ${m[k].baseline}; ${swing})`;
  });
}

function buildPrompt(bundle, { today, previousTitle = null, reason = null, previousAnswer = null, avoidTitles = [] } = {}) {
  const choices = metricChoices(bundle);
  const lines = [
    'You are the strategist for a small software business. Below is everything we can read about it right now.',
    'Propose exactly ONE bet: the most ambitious move this team can start this week, one that would move a number visibly past its normal weekly swing if it works. It must be new, not already written down in these sources. Small safe bets get rejected.',
    '',
    'Answer with strict JSON only, no prose and no code fence, in this shape:',
    '{"title": "...", "why_now": "...", "expect": "...", "target": {"metric": "installs", "baseline": 0, "goal": 0}, "check_in_days": 7, "metric_source": "...", "cost": "...", "steps": [{"text": "...", "detail": "...", "who": "team", "public": false}]}',
    '',
    'Rules:',
    '- title: one sentence that starts with an action verb and names a concrete deliverable (a page, a command, a post, an email, a demo, a price). Under 120 characters.',
    `- never use these as the whole action: ship it, improve, optimize, leverage, enhance, boost, streamline, grow, scale, explore.`,
    `- why_now: at most two short sentences, under ${WHY_MAX} characters in all, that quote at least one exact fact from the facts list below, with its number.`,
    '- expect: the prediction in plain words with its number, for example "400 more installs in the week before the check date".',
    `- target: the one number this bet moves, read over the 7 days that end on the check date. metric is one of: ${choices.length ? choices.join('; ') : 'none can be read right now'}. baseline is that number exactly as it is today. goal is the number you expect, and goal minus baseline must be at least ${SWING_MULTIPLE} times the normal weekly swing.`,
    `- check_in_days: a whole number from ${MIN_CHECK_DAYS} to ${CHECK_WINDOW_DAYS}, how many days from today until we read the number. we work out the date.`,
    '- metric_source: where we will read that number, in plain words (npm installs, or what landed on master).',
    '- cost: team time and money, for example "about 6 hours of agent time, $0".',
    `- steps: ${MIN_STEPS} to ${MAX_STEPS} steps in order. text is one plain line under ${STEP_MAX} characters, with no file paths, no commands, and no flags. detail (optional, under ${DETAIL_MAX} characters) holds the exact how: files, commands, numbers. who is "team" for work the agents can do alone and "you" for anything the owner must approve. public is true when the step is visible outside the company.`,
    '- any step that publishes, posts, releases, sends, launches, spends money, or cannot be undone must be who "you". at least one step must be who "team".',
    '- check what has to be true first. if the move shows people something that is merged but not published yet (see the release fact), add a step for "you" to release it before anything goes out.',
    '- past bets marked won or lost are real results, read from the same numbers. lean toward moves like the winners and away from the losers, and when you do, say so in why_now.',
    '- write in plain lowercase-friendly words, no hype, no em dashes.',
  ];
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
// starting from today's real value, and far enough past normal swing that
// a win or a loss actually says something. Each reason states the numbers so
// the retry can fix them.
function targetProblems(target, bundle) {
  const m = bundleMetrics(bundle);
  const names = Object.keys(m);
  if (!target || typeof target !== 'object' || Array.isArray(target)) return ['target is missing; give {"metric", "baseline", "goal"}'];
  if (!names.length) return ['there is no number we can read here for a target (no npm installs and no git history)'];
  if (!m[target.metric]) return [`target metric must be one we can read here: ${names.join(' or ')}, got ${JSON.stringify(target.metric)}`];
  const { baseline: real, swing } = m[target.metric];
  const label = METRICS[target.metric].now;
  const out = [];
  if (!Number.isFinite(target.baseline)) out.push(`target baseline must be a number: ${label} is ${commas(real)}`);
  else if (target.baseline !== real) out.push(`target baseline ${commas(target.baseline)} does not match the real number: ${label} is ${commas(real)}`);
  if (!Number.isFinite(target.goal)) out.push('target goal must be a number');
  else if (target.goal <= real) out.push(`target goal ${commas(target.goal)} must be above the baseline ${commas(real)}`);
  else if (swing !== null && target.goal - real < SWING_MULTIPLE * swing) {
    out.push(`target is inside normal swing: goal ${commas(target.goal)} is ${commas(target.goal - real)} over the baseline ${commas(real)}, but ${METRICS[target.metric].name} already swing up to ${commas(swing)} in a normal week, so the goal must be at least ${commas(real + SWING_MULTIPLE * swing)}`);
  }
  return out;
}

function validateBet(bet, { bundle, today, previousTitle = null, avoidTitles = [] } = {}) {
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
    else {
      const close = [previousTitle, ...avoidTitles].filter(Boolean).find(t => nearDuplicate(str('title'), t));
      if (close) reasons.push(`the title is too close to a bet already shown or waiting: "${clip(close, 80)}"`);
    }
  }
  if (str('why_now') && bundle && !citesBundle(str('why_now'), bundle)) reasons.push('why_now does not quote a fact from the sources');
  if (str('why_now').length > WHY_MAX) reasons.push(`why_now is ${str('why_now').length} characters, over ${WHY_MAX}`);
  if (sentenceCount(str('why_now')) > 2) reasons.push('why_now is more than two sentences');
  if (str('expect') && !(/\d/.test(str('expect')) && /[a-z]{3,}/i.test(str('expect')))) reasons.push('expect needs a number and a metric');
  // the model picks a number of days; the date is ours, so a time zone or a
  // clock change can never push it out of the window. Out of range is a
  // reject with the reason, never a clamp.
  if (bet.check_in_days === undefined || bet.check_in_days === null) reasons.push('check_in_days is missing');
  else if (!Number.isInteger(bet.check_in_days) || bet.check_in_days < MIN_CHECK_DAYS || bet.check_in_days > CHECK_WINDOW_DAYS) {
    reasons.push(`check_in_days must be a whole number from ${MIN_CHECK_DAYS} to ${CHECK_WINDOW_DAYS}, got ${JSON.stringify(bet.check_in_days)}`);
  }
  if (bundle) reasons.push(...targetProblems(bet.target, bundle));
  if (str('metric_source') && !METRIC_SOURCES.some(k => str('metric_source').toLowerCase().includes(k))) reasons.push('metric_source is not a source we can read');
  if (str('cost').length > 200) reasons.push('cost is longer than 200 characters');
  const steps = Array.isArray(bet.steps) ? bet.steps : null;
  if (!steps) reasons.push('steps is missing');
  else if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) reasons.push(`steps must have ${MIN_STEPS} to ${MAX_STEPS} items`);
  else {
    steps.forEach((s, i) => {
      const n = i + 1;
      if (!s || typeof s.text !== 'string' || !s.text.trim()) reasons.push(`step ${n} has no text`);
      else {
        const problem = stepProblem(s.text);
        if (problem) reasons.push(`step ${n} ${problem}`);
      }
      if (s && s.detail != null && (typeof s.detail !== 'string' || s.detail.length > DETAIL_MAX)) reasons.push(`step ${n} detail must be text under ${DETAIL_MAX} characters`);
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

function cleanBet(bet, today, bundle) {
  const target = { metric: bet.target.metric, baseline: bet.target.baseline, goal: bet.target.goal };
  const known = bundleMetrics(bundle)[target.metric];
  const swing = known && known.swing !== null ? known.swing : null;
  return {
    title: bet.title.trim(),
    why_now: bet.why_now.trim(),
    expect: bet.expect.trim(),
    target,
    ...(swing !== null ? { swing } : {}),
    // the one short line under expect on the card
    goal_line: `goal ${commas(target.goal)} from ${commas(target.baseline)}${swing !== null ? `, normal swing ${commas(swing)}` : ''}`,
    check_in_days: bet.check_in_days,
    check_date: addDays(today, bet.check_in_days),
    metric_source: bet.metric_source.trim(),
    cost: bet.cost.trim(),
    steps: bet.steps.map(s => ({ text: s.text.trim(), ...(s.detail && s.detail.trim() ? { detail: s.detail.trim() } : {}), who: s.who, public: s.public })),
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
    '- moves_metric: if every step is done, would it actually move the target number (target.metric, read over the 7 days that end on the check date) from the baseline to the goal? a post does not move installs if the thing it shows is not installable yet, and work nobody outside sees does not move installs at all.',
    '- missing_first: what must be true first and is not, and is not already a step: an unpublished feature (see the release fact), a page or command that does not exist, no audience that would see it. write "nothing" when nothing is missing.',
    '- would a sharp founder reading this find it obviously wrong, padded, or a waste of the week?',
    'verdict is "pass" only when moves_metric is true, nothing is missing that the steps do not cover, and it is not obviously wrong. otherwise "fail".',
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

function skepticReason(v) {
  const missing = v.missing_first && !/^(nothing|none|n\/a)\.?$/i.test(v.missing_first.trim()) ? ` missing first: ${v.missing_first.replace(/[.\s]+$/, '')}.` : '';
  const moves = v.moves_metric ? '' : ' it would not move the target number.';
  return `a skeptic turned it down: ${v.reason.replace(/[.\s]+$/, '')}.${moves}${missing} if the missing piece is something we can do, add it as a step (a release, or anything public, is a step for "you")`;
}

async function generateBet({ workspaceRoot, today, previousTitle = null, avoidTitles = [], emit = () => {}, deps = {}, ledgerFile, attemptsFile } = {}) {
  const bundle = await readBundle(workspaceRoot, { deps, emit, ledgerFile, today });
  const run = deps.runModel || runModel;
  // tests pass runSkeptic; a stubbed runModel without one is also used for the
  // skeptic, so a test can never reach the real model by accident
  const judge = deps.runSkeptic || deps.runModel || ((prompt, opts) => runModel(prompt, { ...opts, command: skepticCommand() }));
  const clock = deps.now || Date.now;
  let reason = null;
  let previousAnswer = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    emit({ kind: 'model', line: attempt === 1 ? 'asking the model for one bet' : 'asking again with the reasons' });
    const prompt = buildPrompt(bundle, { today, previousTitle, reason, previousAnswer, avoidTitles });
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
    const base = { at: new Date(clock()).toISOString(), workspace: workspaceRoot, today, attempt, previous_title: previousTitle, avoid_titles: avoidTitles.length, ms };
    if (!answer.ok) {
      saveAttempt(attemptsFile, { ...base, kind: 'writer', model_ok: false, raw: null, parse: null, passed: false, reasons: [answer.reason] });
      return { ok: false, reason: answer.reason, bundle };
    }
    const parsed = parseBet(answer.text);
    const check = parsed.error ? { ok: false, reasons: [parsed.error] } : validateBet(parsed.bet, { bundle, today, previousTitle, avoidTitles });
    saveAttempt(attemptsFile, {
      ...base,
      kind: 'writer',
      model_ok: true,
      raw: String(answer.text).slice(0, 20000),
      parse: parsed.error || 'ok',
      passed: check.ok,
      reasons: check.reasons,
    });
    previousAnswer = parsed.error ? null : JSON.stringify(parsed.bet);
    if (!check.ok) {
      reason = check.reasons.slice(0, 4).join('; ');
      emit({ kind: 'reject', line: attempt === 1 ? `first answer turned down: ${reason}` : `second answer turned down too: ${reason}` });
      continue;
    }

    // the code checks passed; now a second model judges whether it makes sense
    const bet = cleanBet(parsed.bet, today, bundle);
    emit({ kind: 'skeptic', line: 'a second model is checking that it makes sense' });
    const judgedAt = clock();
    const said = await judge(buildSkepticPrompt(bet, bundle, { today }), { cwd: workspaceRoot, onProgress: () => {} });
    const skepticBase = { ...base, kind: 'skeptic', at: new Date(clock()).toISOString(), ms: clock() - judgedAt, title: bet.title };
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
    emit({ kind: 'reject', line: attempt === 1 ? `first answer turned down: ${reason}` : `second answer turned down too: ${reason}` });
  }
  return { ok: false, reason: `the model's answer was turned down twice (${reason})`, bundle };
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
  const steps = bet.steps.map((s, i) => `${i + 1}. [${s.who === 'you' ? 'your yes' : 'team'}] ${s.text}${s.detail ? ` (${s.detail})` : ''}`);
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

// ---- the desk: a queue of ready bets, one shown at a time --------------------------------

const QUEUE_TARGET = 3;
const REFILL_BELOW = 2;
// one generation at a time; the cap of 3 calls in flight per session is never reached
const MAX_IN_FLIGHT = 1;
const SESSION_IN_FLIGHT_CAP = 3;
const STALE_MS = 6 * 60 * 60 * 1000;
const RECENT_TITLES = 20;
// two failed background generations in a row stop the prefetch until the next tap
const MAX_BACKGROUND_FAILURES = 2;

// deps:
//   workspaceRoot, ledgerFile, attemptsFile   where
//   generate(opts)                            -> generateBet result (tests stub)
//   runCli(args)                              -> Promise<{ code, stdout, stderr }>
//   log(row)                                  receipt row for gm-phone-actions.jsonl
//   now()                                     clock
function createBetDesk(deps) {
  const now = deps.now || Date.now;
  const generate = deps.generate || (opts => generateBet({ ...opts, deps: deps.generatorDeps || {}, ledgerFile: deps.ledgerFile, attemptsFile: deps.attemptsFile }));
  const log = deps.log || (() => {});
  const state = {
    status: 'idle',
    current: null,
    queue: [],
    inFlight: 0,
    maxInFlight: 0,
    gen: null,
    waiting: null,
    pendingSharper: null,
    topping: false,
    failures: 0,
    run: 0,
    error: null,
    lastFailed: null,
    mission: null,
    started: [],
  };

  const iso = () => new Date(now()).toISOString();
  const record = (id, patch) => appendLedger(deps.ledgerFile, { id, workspace: deps.workspaceRoot, at: iso(), ...patch });
  const newId = () => `bet-${dayKey(now())}-${crypto.randomBytes(4).toString('hex')}`;

  // queued bets live in the ledger, so a restart or a reload wastes nothing
  for (const row of readLedger(deps.ledgerFile, deps.workspaceRoot)) {
    if (row.status !== 'queued' || !row.bet) continue;
    state.queue.push({ id: row.id, bet: row.bet, created_at: Date.parse(row.created_at) || 0 });
  }

  function dropStale() {
    const keep = [];
    for (const item of state.queue) {
      if (now() - item.created_at > STALE_MS) record(item.id, { status: 'stale' });
      else keep.push(item);
    }
    state.queue = keep;
  }

  // every title the next bet must differ from: the one on screen, the queue,
  // the one being made, and the newest ones in the ledger
  function avoidTitles() {
    const titles = [];
    if (state.current) titles.push(state.current.bet.title);
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
      started = Promise.resolve(generate({ workspaceRoot: deps.workspaceRoot, today: dayKey(now()), previousTitle: sharperOf, avoidTitles: avoidTitles(), emit }));
    } catch (err) {
      started = Promise.reject(err);
    }
    gen.done = started
      .catch(err => ({ ok: false, reason: String((err && err.message) || err) }))
      .then((out) => {
        state.inFlight -= 1;
        if (state.gen === gen) state.gen = null;
        const waited = state.waiting === gen;
        if (!out.ok) {
          log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 1, error: clip(out.reason, 200) });
          emit({ kind: 'failed', line: out.reason });
          if (waited) {
            state.waiting = null;
            state.lastFailed = gen.events;
            state.status = 'failed';
            state.error = out.reason;
          } else {
            state.failures += 1;
          }
          return pump();
        }
        state.failures = 0;
        const item = { id: newId(), bet: out.bet, created_at: now() };
        record(item.id, { created_at: iso(), status: 'queued', bet: out.bet, previous_title: sharperOf });
        log({ card: 'bet', choice: 'generate', command: null, ran: 'in process', exit_code: 0, bet_id: item.id });
        emit({ kind: 'done', line: 'bet ready' });
        if (waited) {
          state.waiting = null;
          show(item);
        } else {
          state.queue.push(item);
        }
        return pump();
      });
    return gen;
  }

  // Keeps the queue topped up: below 2 it refills to 3, one generation at a
  // time. A tap that is waiting, or a sharper idea, goes first.
  function pump() {
    dropStale();
    if (state.inFlight >= MAX_IN_FLIGHT) return state.gen && state.gen.done;
    if (state.pendingSharper && state.status === 'thinking') {
      const sharperOf = state.pendingSharper;
      state.pendingSharper = null;
      state.waiting = startGeneration({ sharperOf });
      return state.waiting && state.waiting.done;
    }
    if (state.status === 'thinking' && !state.waiting) {
      state.waiting = startGeneration();
      return state.waiting && state.waiting.done;
    }
    if (state.queue.length < REFILL_BELOW) state.topping = true;
    if (state.queue.length >= QUEUE_TARGET) state.topping = false;
    if (!state.topping || state.failures >= MAX_BACKGROUND_FAILURES) return null;
    const gen = startGeneration();
    return gen && gen.done;
  }

  // The page opened: start filling the queue so the first tap does not wait.
  function warm() {
    pump();
    return view();
  }

  // A tap on the orb: the bet on screen is passed over, the next one in the
  // queue shows at once, or the page waits on the generation in flight.
  function next({ sharper = false } = {}) {
    if (state.status === 'thinking' || state.status === 'starting') return { ok: true, busy: true, ...view() };
    state.failures = 0;
    if (state.status === 'ready' && state.current) {
      record(state.current.id, { status: 'passed', ...(sharper ? { note: 'asked for a sharper idea' } : {}) });
      log({ card: 'bet', choice: sharper ? 'sharper' : 'pass', command: null, ran: 'in process', exit_code: 0, bet_id: state.current.id });
    } else {
      log({ card: 'bet', choice: 'think', command: null, ran: 'in process', exit_code: 0 });
    }
    dropStale();
    if (sharper) {
      state.pendingSharper = state.current ? state.current.bet.title : null;
      state.current = null;
      state.status = 'thinking';
      state.waiting = null;
      pump();
      return { ok: true, ...view() };
    }
    if (state.queue.length) {
      show(state.queue.shift());
      pump();
      return { ok: true, ...view() };
    }
    state.current = null;
    state.status = 'thinking';
    state.error = null;
    // the generation already running is the one this tap waits on
    state.waiting = state.gen || null;
    pump();
    return { ok: true, ...view() };
  }

  function skip() {
    if (state.status !== 'ready' || !state.current) return { ok: false, reason: 'gone', message: 'there is no bet to skip' };
    record(state.current.id, { status: 'skipped' });
    log({ card: 'bet', choice: 'skip', command: null, ran: 'in process', exit_code: 0, bet_id: state.current.id });
    state.status = 'skipped';
    return { ok: true, ack: 'not now. all clear.' };
  }

  async function doIt() {
    if (state.status !== 'ready' || !state.current) return { ok: false, reason: 'gone', message: 'there is no bet to start' };
    const { id, bet } = state.current;
    const pick = pickOwner(bet, deps.workspaceRoot);
    const startArgs = missionStartArgs(bet, pick);
    state.status = 'starting';
    const display = args => require('./gm-phone').displayCommand(args);
    let res = await deps.runCli(startArgs);
    log({ card: 'bet', choice: 'do', command: display(startArgs), exit_code: res.code, bet_id: id });
    const started = parseJsonOut(res.stdout);
    const missionId = started && (started.mission ? started.mission.id : started.mission_id);
    if (res.code !== 0 || !missionId) {
      state.status = 'ready';
      const why = clip((res.stderr || res.stdout || '').trim().split('\n').pop(), 160);
      return { ok: false, reason: 'start_failed', message: `the mission did not start${why ? `: ${why}` : ''}` };
    }
    const owner = (started.mission && started.mission.owner) || pick.owner;
    record(id, { status: 'doing', mission_id: missionId, owner });
    const runArgs = missionRunArgs(missionId);
    res = await deps.runCli(runArgs);
    log({ card: 'bet', choice: 'do', command: display(runArgs), exit_code: res.code, bet_id: id, mission_id: missionId });
    const ran = parseJsonOut(res.stdout) || {};
    let line;
    if (res.code === 0 && ran.action === 'mission_run_detached') line = `${owner} has it. the mission is running now.`;
    else if (ran.reason === 'human_asks_open') line = `${owner} has it, and is waiting on your yes before it starts.`;
    else line = `${owner} has the mission, but it did not start running (exit code ${res.code}). run it from the mac: atris mission run ${missionId}`;
    state.status = 'started';
    state.mission = { id: missionId, owner, line, commands: [display(startArgs), display(runArgs)] };
    state.started.push({ bet_id: id, mission_id: missionId, owner, steps: bet.steps, yes: {} });
    return { ok: true, ack: line, mission: state.mission };
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
  }

  function view() {
    const events = state.waiting ? state.waiting.events : (state.status === 'failed' && state.lastFailed ? state.lastFailed : []);
    return {
      status: state.status,
      id: state.current ? state.current.id : null,
      bet: state.current ? state.current.bet : null,
      events: events.map(e => ({ i: e.i, kind: e.kind, line: e.line, ...(e.key ? { key: e.key } : {}), ...(e.n != null ? { n: e.n } : {}) })),
      error: state.error,
      queue: state.queue.length,
      mission: state.mission ? { owner: state.mission.owner, line: state.mission.line } : null,
    };
  }

  return { warm, next, skip, doIt, yesCards, recordYes, view, state };
}

module.exports = {
  MODEL_TIMEOUT_MS,
  STALE_MS,
  YES_RULE,
  buildPrompt,
  addDays,
  attemptsPath,
  bundleText,
  citesBundle,
  claudeArgs,
  countWeeks,
  createBetDesk,
  defaultReleaseGap,
  generateBet,
  installTotals,
  installWeeks,
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
  weeklySwing,
};
