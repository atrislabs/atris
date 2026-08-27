'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isFreshWorkspace, speakFirstMinute } = require('../lib/first-minute');

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
  let json = false;
  let global = false;

  while (index < args.length) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      return { help: true, root, days, json, global };
    }
    if (arg === '--json') {
      json = true;
      index += 1;
      continue;
    }
    if (arg === '--global' || arg === '-g') {
      global = true;
      index += 1;
      continue;
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

  return { help: false, root, days, json, global };
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

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function historyBounds(now, days) {
  const today = utcDayStart(now);
  const historyStart = new Date(today.getTime() - (days - 1) * DAY_MS);
  const currentWindowStart = new Date(now.getTime() - 7 * DAY_MS);
  const priorWindowStart = new Date(currentWindowStart.getTime() - 7 * DAY_MS);
  return {
    since: historyStart < priorWindowStart ? historyStart : priorWindowStart,
    until: now,
    currentWindowStart,
    priorWindowStart,
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

function commitHistory(repoRoot, branch, bounds) {
  if (!branch) return { perDay: {}, timestamps: [] };
  const history = runGit(repoRoot, [
    'log',
    branch,
    `--since=${bounds.since.toISOString()}`,
    `--until=${bounds.until.toISOString()}`,
    '--format=%cI',
  ]);
  if (!history.ok) return { perDay: {}, timestamps: [] };

  const daily = {};
  const timestamps = [];
  for (const line of history.stdout.split('\n')) {
    const timestamp = new Date(line.trim());
    if (!Number.isFinite(timestamp.getTime())) continue;
    timestamps.push(timestamp);
    const day = dateKey(timestamp);
    if (day) daily[day] = (daily[day] || 0) + 1;
  }
  return {
    perDay: Object.fromEntries(Object.entries(daily).sort(([left], [right]) => left.localeCompare(right))),
    timestamps,
  };
}

function totalInRange(timestamps, start, end, includeEnd = false) {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return timestamps.reduce((total, timestamp) => {
    const time = timestamp.getTime();
    const inside = time >= startTime && (includeEnd ? time <= endTime : time < endTime);
    return inside ? total + 1 : total;
  }, 0);
}

function discoverRepos(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.agent-worktrees')
    .map((entry) => path.join(root, entry.name))
    .filter((repoRoot) => fs.existsSync(path.join(repoRoot, '.git')))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function scoreOneRepo(repoRoot, bounds) {
  const branch = defaultBranch(repoRoot);
  const history = commitHistory(repoRoot, branch, bounds);
  return {
    repo: path.basename(repoRoot),
    commitsThisWeek: totalInRange(history.timestamps, bounds.currentWindowStart, bounds.until, true),
    commitsLastWeek: totalInRange(history.timestamps, bounds.priorWindowStart, bounds.currentWindowStart),
    perDay: history.perDay,
  };
}

function collectRepoScorecards(root, bounds, { singleRepo = false, workspace = null } = {}) {
  if (singleRepo) {
    const target = workspace || root;
    if (fs.existsSync(path.join(target, '.git')) || runGit(target, ['rev-parse', '--is-inside-work-tree']).ok) {
      return [scoreOneRepo(target, bounds)];
    }
    return [];
  }
  return discoverRepos(root).map((repoRoot) => scoreOneRepo(repoRoot, bounds)).sort((left, right) => (
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

    const timestamps = [];
    for (const task of tasks) {
      const status = String(task?.status || '').trim().toLowerCase();
      if (!['done', 'closed'].includes(status)) continue;
      const timestamp = new Date(taskClosedAt(task));
      if (Number.isFinite(timestamp.getTime())) timestamps.push(timestamp);
    }

    return {
      available: true,
      thisWeek: totalInRange(timestamps, bounds.currentWindowStart, bounds.until, true),
      lastWeek: totalInRange(timestamps, bounds.priorWindowStart, bounds.currentWindowStart),
    };
  } catch {
    return { available: false, thisWeek: null, lastWeek: null };
  }
}

function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 100);
}

function buildFounderScorecard(root, {
  days = DEFAULT_DAYS,
  now = new Date(),
  singleRepo = false,
  workspace = null,
} = {}) {
  const bounds = historyBounds(now, days);
  const perRepo = collectRepoScorecards(root, bounds, { singleRepo, workspace });
  const commitsThisWeek = perRepo.reduce((total, repo) => total + repo.commitsThisWeek, 0);
  const commitsLastWeek = perRepo.reduce((total, repo) => total + repo.commitsLastWeek, 0);
  const taskRoot = singleRepo ? (workspace || root) : root;
  const tasks = readTaskScorecard(taskRoot, bounds);

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
    `last 7 days: ${plural(scorecard.commitsThisWeek, 'commit')} landed across ${plural(activeProjects, 'project')}. prior 7 days: ${scorecard.commitsLastWeek}. slope: ${slopeText(scorecard.slopePct)}.`,
  ];

  for (const repo of scorecard.perRepo.filter((entry) => (
    entry.commitsThisWeek > 0 || entry.commitsLastWeek > 0
  )).slice(0, 5)) {
    lines.push(`${repo.repo}: ${repo.commitsThisWeek} last 7 days, ${repo.commitsLastWeek} prior 7 days.`);
  }

  if (scorecard.tasksThisWeek === null) lines.push('no task data.');
  else lines.push(`tasks closed: ${scorecard.tasksThisWeek} last 7 days, ${scorecard.tasksLastWeek} prior 7 days.`);
  return lines.join('\n');
}

function showFounderHelp() {
  console.log('usage: atris founder [score] [--days n] [--root dir] [--json] [--global]');
  console.log('shows the last 7 days against the prior 7 days from git and task receipts.');
  console.log('default scope is this workspace. pass --global to scan sibling repos.');
  console.log('supported flags: --days, --root, --json, --global, --help, -h');
}

function founderCommand(args = [], options = {}) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error('supported flags: --days, --root, --json, --global, --help, -h');
    return 2;
  }
  if (parsed.help) {
    showFounderHelp();
    return 0;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const currentWorkspace = workspaceRoot(cwd);

  // Empty folder talks like bare atris. Do not write scorecard.jsonl.
  // After init, founder still lists and scores.
  if (isFreshWorkspace(cwd) || isFreshWorkspace(currentWorkspace)) {
    return speakFirstMinute({
      root: cwd,
      fresh: true,
      asJson: parsed.json,
    });
  }

  const root = parsed.root
    ? path.resolve(cwd, parsed.root)
    : (parsed.global ? defaultScanRoot(cwd, currentWorkspace) : currentWorkspace);
  const now = founderNow(options.env || process.env);
  const scorecard = buildFounderScorecard(root, {
    days: parsed.days,
    now,
    singleRepo: !parsed.global && !parsed.root,
    workspace: currentWorkspace,
  });
  appendFounderScorecard(currentWorkspace, scorecard);
  if (parsed.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(renderFounderScorecard(scorecard));
  }
  return 0;
}

module.exports = { founderCommand };
