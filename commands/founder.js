'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 28;
const TASK_PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');
const SCORECARD_FILE = path.join('.atris', 'state', 'founder', 'scorecard.jsonl');

function runGit(cwd, args) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !run.error && run.status === 0,
    stdout: run.stdout || '',
  };
}

function workspaceRoot(cwd = process.cwd()) {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  return top.ok && top.stdout.trim() ? path.resolve(top.stdout.trim()) : path.resolve(cwd);
}

function defaultScanRoot(cwd, currentWorkspace) {
  const commonDir = runGit(cwd, ['rev-parse', '--git-common-dir']);
  if (commonDir.ok && commonDir.stdout.trim()) {
    const absoluteCommonDir = path.resolve(cwd, commonDir.stdout.trim());
    if (path.basename(absoluteCommonDir) === '.git') {
      return path.dirname(path.dirname(absoluteCommonDir));
    }
  }
  return path.dirname(currentWorkspace);
}

function parseArgs(args = []) {
  let index = args[0] === 'score' ? 1 : 0;
  let root = null;
  let days = DEFAULT_DAYS;

  while (index < args.length) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      return { help: true, root, days };
    }
    if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg.startsWith('--root=') ? arg.slice('--root='.length) : args[++index];
      if (!value || String(value).startsWith('--')) throw new Error('--root needs a directory.');
      root = String(value);
      index += 1;
      continue;
    }
    if (arg === '--days' || arg.startsWith('--days=')) {
      const value = arg.startsWith('--days=') ? arg.slice('--days='.length) : args[++index];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--days must be a positive integer.');
      days = parsed;
      index += 1;
      continue;
    }
    throw new Error(`unknown founder option: ${arg}`);
  }

  return { help: false, root, days };
}

function founderNow(env = process.env) {
  const raw = String(env.ATRIS_FOUNDER_NOW || '').trim();
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
  const now = value ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('ATRIS_FOUNDER_NOW must be an ISO date.');
  return now;
}

function utcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoWeekStart(date) {
  const start = utcDayStart(date);
  const weekday = start.getUTCDay() || 7;
  return new Date(start.getTime() - (weekday - 1) * DAY_MS);
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function historyBounds(now, days) {
  const today = utcDayStart(now);
  const thisWeekStart = isoWeekStart(now);
  return {
    since: new Date(today.getTime() - (days - 1) * DAY_MS),
    until: now,
    thisWeekStart,
    lastWeekStart: new Date(thisWeekStart.getTime() - 7 * DAY_MS),
  };
}

function defaultBranch(repoRoot) {
  const remoteHead = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.ok && remoteHead.stdout.trim()) return remoteHead.stdout.trim();

  for (const name of ['main', 'master']) {
    if (runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name;
  }

  const current = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (current.ok && current.stdout.trim()) return current.stdout.trim();
  return runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok ? 'HEAD' : null;
}

function commitsByDay(repoRoot, branch, bounds) {
  if (!branch) return {};
  const history = runGit(repoRoot, [
    'log',
    branch,
    `--since=${bounds.since.toISOString()}`,
    `--until=${bounds.until.toISOString()}`,
    '--format=%cI',
  ]);
  if (!history.ok) return {};

  const daily = {};
  for (const line of history.stdout.split('\n')) {
    const day = dateKey(line.trim());
    if (day) daily[day] = (daily[day] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(daily).sort(([left], [right]) => left.localeCompare(right)));
}

function totalInRange(daily, start, end) {
  const startKey = dateKey(start);
  const endKey = dateKey(end);
  return Object.entries(daily).reduce((total, [day, count]) => (
    day >= startKey && day < endKey ? total + count : total
  ), 0);
}

function discoverRepos(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.agent-worktrees')
    .map((entry) => path.join(root, entry.name))
    .filter((repoRoot) => fs.existsSync(path.join(repoRoot, '.git')))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function collectRepoScorecards(root, bounds) {
  const nextWeekStart = new Date(bounds.thisWeekStart.getTime() + 7 * DAY_MS);
  return discoverRepos(root).map((repoRoot) => {
    const branch = defaultBranch(repoRoot);
    const perDay = commitsByDay(repoRoot, branch, bounds);
    return {
      repo: path.basename(repoRoot),
      commitsThisWeek: totalInRange(perDay, bounds.thisWeekStart, nextWeekStart),
      commitsLastWeek: totalInRange(perDay, bounds.lastWeekStart, bounds.thisWeekStart),
      perDay,
    };
  }).sort((left, right) => (
    right.commitsThisWeek - left.commitsThisWeek
    || right.commitsLastWeek - left.commitsLastWeek
    || left.repo.localeCompare(right.repo)
  ));
}

function taskRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.tasks) ? parsed.tasks : null;
}

function taskClosedAt(task) {
  const direct = task?.done_at || task?.closed_at || task?.completed_at;
  if (direct) return direct;
  const events = Array.isArray(task?.events) ? [...task.events].reverse() : [];
  const closedEvent = events.find((event) => {
    const eventName = String(event?.event_type || event?.type || event?.status || '').toLowerCase();
    return ['done', 'closed', 'completed'].includes(eventName);
  });
  return closedEvent?.created_at || closedEvent?.ts || null;
}

function readTaskScorecard(root, bounds) {
  const file = path.join(root, TASK_PROJECTION_FILE);
  if (!fs.existsSync(file)) return { available: false, thisWeek: null, lastWeek: null };

  try {
    const tasks = taskRows(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!tasks) return { available: false, thisWeek: null, lastWeek: null };

    const daily = {};
    for (const task of tasks) {
      const status = String(task?.status || '').trim().toLowerCase();
      if (!['done', 'closed'].includes(status)) continue;
      const day = dateKey(taskClosedAt(task));
      if (day && day >= dateKey(bounds.since) && day <= dateKey(bounds.until)) {
        daily[day] = (daily[day] || 0) + 1;
      }
    }

    const nextWeekStart = new Date(bounds.thisWeekStart.getTime() + 7 * DAY_MS);
    return {
      available: true,
      thisWeek: totalInRange(daily, bounds.thisWeekStart, nextWeekStart),
      lastWeek: totalInRange(daily, bounds.lastWeekStart, bounds.thisWeekStart),
    };
  } catch {
    return { available: false, thisWeek: null, lastWeek: null };
  }
}

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 100);
}

function buildFounderScorecard(root, { days = DEFAULT_DAYS, now = new Date() } = {}) {
  const bounds = historyBounds(now, days);
  const perRepo = collectRepoScorecards(root, bounds);
  const commitsThisWeek = perRepo.reduce((total, repo) => total + repo.commitsThisWeek, 0);
  const commitsLastWeek = perRepo.reduce((total, repo) => total + repo.commitsLastWeek, 0);
  const tasks = readTaskScorecard(root, bounds);

  return {
    ts: now.toISOString(),
    days,
    commitsThisWeek,
    commitsLastWeek,
    slopePct: percentChange(commitsThisWeek, commitsLastWeek),
    tasksThisWeek: tasks.thisWeek,
    tasksLastWeek: tasks.lastWeek,
    perRepo,
  };
}

function appendFounderScorecard(currentWorkspace, scorecard) {
  const file = path.join(currentWorkspace, SCORECARD_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(scorecard)}\n`, 'utf8');
  return file;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function slopeText(value) {
  return value > 0 ? `+${value}%` : `${value}%`;
}

function renderFounderScorecard(scorecard) {
  const activeProjects = scorecard.perRepo.filter((repo) => repo.commitsThisWeek > 0).length;
  const lines = [
    `this week: ${plural(scorecard.commitsThisWeek, 'commit')} landed across ${plural(activeProjects, 'project')}. last week: ${scorecard.commitsLastWeek}. slope: ${slopeText(scorecard.slopePct)}.`,
  ];

  for (const repo of scorecard.perRepo.filter((entry) => (
    entry.commitsThisWeek > 0 || entry.commitsLastWeek > 0
  )).slice(0, 5)) {
    lines.push(`${repo.repo}: ${repo.commitsThisWeek} this week, ${repo.commitsLastWeek} last week.`);
  }

  if (scorecard.tasksThisWeek === null) lines.push('no task data.');
  else lines.push(`tasks closed: ${scorecard.tasksThisWeek} this week, ${scorecard.tasksLastWeek} last week.`);
  return lines.join('\n');
}

function showFounderHelp() {
  console.log('usage: atris founder [score] [--days n] [--root dir]');
  console.log('shows this week against last week from git and task receipts.');
}

function founderCommand(args = [], options = {}) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
  if (parsed.help) {
    showFounderHelp();
    return 0;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const currentWorkspace = workspaceRoot(cwd);
  const root = parsed.root
    ? path.resolve(cwd, parsed.root)
    : defaultScanRoot(cwd, currentWorkspace);
  const now = founderNow(options.env || process.env);
  const scorecard = buildFounderScorecard(root, { days: parsed.days, now });
  appendFounderScorecard(currentWorkspace, scorecard);
  console.log(renderFounderScorecard(scorecard));
  return 0;
}

module.exports = { founderCommand };
