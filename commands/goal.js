'use strict';

const fs = require('fs');
const path = require('path');

const SCOREBOARD_FILE = path.join('.atris', 'state', 'scoreboard.json');
const TASK_PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function scoreboardPath(root = process.cwd()) {
  return path.join(root, SCOREBOARD_FILE);
}

function emptyScoreboard() {
  return { goal: null, metrics: [], updated_at: null };
}

function readScoreboard(root = process.cwd()) {
  const file = scoreboardPath(root);
  if (!fs.existsSync(file)) return emptyScoreboard();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      goal: normalizeText(parsed?.goal) || null,
      metrics: Array.isArray(parsed?.metrics)
        ? parsed.metrics
          .map((metric) => ({
            name: normalizeText(metric?.name),
            value: normalizeText(metric?.value),
          }))
          .filter((metric) => metric.name && metric.value)
        : [],
      updated_at: parsed?.updated_at || null,
    };
  } catch {
    return emptyScoreboard();
  }
}

function writeScoreboard(scoreboard, root = process.cwd()) {
  const file = scoreboardPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = {
    goal: normalizeText(scoreboard.goal),
    metrics: Array.isArray(scoreboard.metrics) ? scoreboard.metrics : [],
    updated_at: new Date().toISOString(),
  };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return next;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateKey(value) {
  const ms = timestampMs(value);
  if (ms === null) return null;
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function taskDoneTime(task) {
  if (task?.done_at) return task.done_at;
  const events = Array.isArray(task?.events) ? task.events : [];
  const done = [...events].reverse().find((event) => ['completed', 'done', 'accepted'].includes(
    normalizeText(event?.event_type),
  ));
  return done?.created_at || null;
}

function readTaskMovement(root = process.cwd(), now = new Date()) {
  const file = path.join(root, TASK_PROJECTION_FILE);
  if (!fs.existsSync(file)) return { available: false, landed: 0, review: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed?.tasks)) return { available: false, landed: 0, review: 0 };
    const today = localDateKey(now);
    return {
      available: true,
      landed: parsed.tasks.filter((task) => (
        normalizeText(task?.status) === 'done'
        && localDateKey(taskDoneTime(task)) === today
      )).length,
      review: parsed.tasks.filter((task) => normalizeText(task?.status) === 'review').length,
    };
  } catch {
    return { available: false, landed: 0, review: 0 };
  }
}

function readMissionMovement(root = process.cwd(), now = new Date()) {
  const file = path.join(root, '.atris', 'state', 'missions.jsonl');
  if (!fs.existsSync(file)) return { available: false, completed: 0 };
  try {
    const { listMissions } = require('./mission');
    const today = localDateKey(now);
    const completed = listMissions(root).filter((mission) => (
      ['complete', 'completed'].includes(normalizeText(mission?.status))
      && localDateKey(mission?.completed_at || mission?.updated_at) === today
    )).length;
    return { available: true, completed };
  } catch {
    return { available: false, completed: 0 };
  }
}

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function todayText(tasks, missions) {
  const parts = [];
  if (tasks.available) {
    parts.push(`${plural(tasks.landed, 'task')} landed`);
    parts.push(`${tasks.review} waiting for your ok`);
  }
  if (missions.available) parts.push(`${plural(missions.completed, 'mission')} completed`);
  return parts.length ? parts.join(', ') : 'no movement recorded today';
}

function buildGoalView(root = process.cwd(), now = new Date()) {
  const scoreboard = readScoreboard(root);
  const tasks = readTaskMovement(root, now);
  const missions = readMissionMovement(root, now);
  const today = todayText(tasks, missions);
  const next = tasks.review > 0
    ? 'atris task reviews'
    : scoreboard.goal
      ? 'atris task day'
      : 'atris goal set "<sentence>"';
  return {
    goal: scoreboard.goal,
    metrics: scoreboard.metrics,
    today,
    next,
  };
}

function row(label, value) {
  return `  ${label.padEnd(10)}${value}`;
}

function renderGoalView(view) {
  const goal = view.goal || 'goal not set. set it: atris goal set "<sentence>"';
  const lines = [row('goal', goal)];
  if (view.metrics.length > 0) {
    lines.push(row('distance', view.metrics.map((metric) => `${metric.name}: ${metric.value}`).join(' | ')));
  }
  lines.push(row('today', view.today));
  lines.push(row('next', view.next));
  return lines.join('\n');
}

function printHelp() {
  console.log('usage: atris goal [--json]');
  console.log('       atris goal set "<sentence>"');
  console.log('       atris goal metric <name> <value>');
  console.log('       atris goal metric <name> --rm');
}

function run(args = [], context = {}) {
  const root = context.cwd || process.cwd();
  const now = context.now || new Date();
  const command = args[0];

  try {
    if (args.includes('--help') || args.includes('-h') || command === 'help') {
      printHelp();
      return 0;
    }

    if (command === 'set') {
      const goal = normalizeText(args.slice(1).join(' '));
      if (!goal) {
        console.error('error: goal sentence is required');
        return 2;
      }
      const scoreboard = readScoreboard(root);
      writeScoreboard({ ...scoreboard, goal }, root);
      console.log('goal set.');
      return 0;
    }

    if (command === 'metric') {
      const name = normalizeText(args[1]);
      if (!name) {
        console.error('error: metric name is required');
        return 2;
      }
      const scoreboard = readScoreboard(root);
      const metrics = scoreboard.metrics.filter((metric) => metric.name !== name);
      if (args.includes('--rm')) {
        writeScoreboard({ ...scoreboard, metrics }, root);
        console.log(`metric ${name} removed.`);
        return 0;
      }
      const value = normalizeText(args.slice(2).join(' '));
      if (!value) {
        console.error('error: metric value is required');
        return 2;
      }
      metrics.push({ name, value });
      writeScoreboard({ ...scoreboard, metrics }, root);
      console.log(`metric ${name} set.`);
      return 0;
    }

    if (command && command !== '--json') {
      console.error(`error: unknown goal command: ${normalizeText(command)}`);
      return 2;
    }

    const view = buildGoalView(root, now);
    console.log(args.includes('--json') ? JSON.stringify(view, null, 2) : renderGoalView(view));
    return 0;
  } catch (error) {
    console.error(`error: ${normalizeText(error?.message || error)}`);
    return 2;
  }
}

module.exports = {
  run,
};
