'use strict';

// atris scoreboard: today's GitHub contributions as a small game.
// Data comes from `gh api graphql` (the contribution calendar) and `git log`
// for this repo. Node built-ins only.

const { execFileSync } = require('child_process');

const QUERY = 'query { viewer { contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }';
const MEMBER_TRAILER = 'atris-builder[bot]@users.noreply.github.com';
const BAR_WIDTH = 20;
const CHEER_STEP = 50;

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fetchDays() {
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const weeks = JSON.parse(out).data.viewer.contributionsCollection.contributionCalendar.weeks;
  return weeks.flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function score(days, today = localDate()) {
  const todayDay = days.find((d) => d.date === today) || { date: today, count: 0 };
  const year = today.slice(0, 4);
  let best = null;
  for (const d of days) {
    if (d.date === today || !d.date.startsWith(year)) continue;
    if (!best || d.count > best.count) best = d;
  }
  // A streak survives a quiet morning: if today is still zero, count from yesterday.
  const past = days.filter((d) => d.date <= today);
  if (past.length && past[past.length - 1].date === today && todayDay.count === 0) past.pop();
  let streak = 0;
  for (let i = past.length - 1; i >= 0 && past[i].count > 0; i--) streak++;
  return { today: todayDay.count, best, streak };
}

function bar(count, target) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((count / target) * BAR_WIDTH)));
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

function repoCommits(cwd = process.cwd(), now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  try {
    const out = execFileSync('git', ['log', `--since=${midnight.toISOString()}`, '--format=%B%x1e'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const bodies = out.split('\x1e').map((b) => b.trim()).filter(Boolean);
    const members = bodies.filter((b) => b.includes(MEMBER_TRAILER)).length;
    return { total: bodies.length, you: bodies.length - members, members };
  } catch {
    return null;
  }
}

function render(s, commits) {
  const lines = [`today: ${s.today} contribution${s.today === 1 ? '' : 's'}`];
  if (s.best) {
    const target = s.best.count + 1;
    const note = s.today >= target ? 'new best day this year' : `${target - s.today} to beat your best`;
    lines.push(`${bar(s.today, target)} ${note}`);
    lines.push(`best day this year: ${s.best.date}, ${s.best.count}`);
  } else {
    lines.push('best day this year: none yet, today sets it');
  }
  lines.push(`streak: ${s.streak} day${s.streak === 1 ? '' : 's'}`);
  lines.push(commits
    ? `this repo today: ${commits.total} commit${commits.total === 1 ? '' : 's'}, you ${commits.you}, members ${commits.members}`
    : 'this repo today: not a git repo');
  return lines.join('\n');
}

// One cheer line per multiple of 50 crossed between two readings.
function cheers(prev, next) {
  const out = [];
  for (let m = (Math.floor(prev / CHEER_STEP) + 1) * CHEER_STEP; m <= next; m += CHEER_STEP) {
    out.push(`nice, you passed ${m} today. keep pushing.`);
  }
  return out;
}

function snapshot() {
  const s = score(fetchDays());
  const commits = repoCommits();
  return { s, commits, text: render(s, commits) };
}

// Same numbers as the board, as one object for scripts.
function toJson(s, commits, date = localDate()) {
  return { date, today: s.today, best: s.best, streak: s.streak, repo: commits };
}

async function scoreboardCommand(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: atris scoreboard [--watch | --json]');
    console.log('  today\'s github contributions, your best day this year, your streak, and this repo\'s commits');
    console.log('  --watch   refresh every 60 seconds and cheer at every 50');
    console.log('  --json    print the same numbers once as one json object');
    return 0;
  }
  let snap;
  try {
    snap = snapshot();
  } catch {
    console.error('could not read your github contributions. check that gh is installed and logged in (gh auth status).');
    return 1;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(toJson(snap.s, snap.commits), null, 2));
    return 0;
  }
  console.log(snap.text);
  if (!args.includes('--watch')) return 0;

  const intervalMs = Number(process.env.ATRIS_SCOREBOARD_INTERVAL_MS) || 60000;
  const maxTicks = Number(process.env.ATRIS_SCOREBOARD_TICKS) || Infinity;
  let last = snap.s.today;
  for (let tick = 0; tick < maxTicks; tick++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      snap = snapshot();
    } catch {
      console.log('refresh failed, trying again next minute');
      continue;
    }
    console.log('');
    console.log(snap.text);
    for (const line of cheers(last, snap.s.today)) console.log(line);
    last = snap.s.today;
  }
  return 0;
}

module.exports = { scoreboardCommand, score, render, toJson, cheers, bar, localDate };
