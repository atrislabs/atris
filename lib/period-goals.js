'use strict';

// Dated planning goals: one goal per local day and one per local week (keyed
// by that week's Monday). They live in their own file beside the overarching
// project goal (.atris/state/scoreboard.json) and never replace it. Each period is its own
// key, so setting today never touches yesterday or next week, and a day with
// no goal reads as empty instead of inheriting an older one.
//
// These are planning context only: no calendar events, tasks or invitations.

const fs = require('fs');
const path = require('path');

const PERIOD_GOALS_FILE = path.join('.atris', 'state', 'period_goals.json');
const PERIODS = ['day', 'week'];
const TEXT_MAX = 280;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

class PeriodGoalError extends Error {}

function periodGoalsPath(root = process.cwd()) {
  return path.join(root, PERIOD_GOALS_FILE);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A YYYY-MM-DD string that names a real calendar date, as a local Date.
function parseDate(value) {
  const raw = String(value == null ? '' : value).trim();
  const match = DATE_RE.exec(raw);
  if (!match) throw new PeriodGoalError(`date must look like 2026-11-16, got "${raw}"`);
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new PeriodGoalError(`${raw} is not a real date`);
  }
  return date;
}

function mondayOf(date) {
  const offset = (date.getDay() + 6) % 7; // Monday = 0
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

// The period key for a day or week. No date means the current local one; a
// week date may be any day of that week and resolves to its Monday.
function periodKey(period, date, now = new Date()) {
  if (!PERIODS.includes(period)) throw new PeriodGoalError(`period must be day or week, got "${period}"`);
  const base = date == null || date === '' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : parseDate(date);
  return dateKey(period === 'week' ? mondayOf(base) : base);
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { text, set_by: entry.set_by || null, updated_at: entry.updated_at || null };
}

function readPeriodGoals(root = process.cwd()) {
  const empty = { day: {}, week: {} };
  const file = periodGoalsPath(root);
  if (!fs.existsSync(file)) return empty;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  const out = { day: {}, week: {} };
  for (const period of PERIODS) {
    const bucket = parsed && typeof parsed[period] === 'object' && parsed[period] ? parsed[period] : {};
    for (const [key, entry] of Object.entries(bucket)) {
      if (!DATE_RE.test(key)) continue;
      const clean = cleanEntry(entry);
      if (clean) out[period][key] = clean;
    }
  }
  return out;
}

function writePeriodGoals(goals, root = process.cwd()) {
  const file = periodGoalsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ day: goals.day || {}, week: goals.week || {} }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function view(period, key, entry) {
  return {
    period,
    [period === 'week' ? 'week_of' : 'date']: key,
    text: entry ? entry.text : null,
    set_by: entry ? entry.set_by : null,
    updated_at: entry ? entry.updated_at : null,
  };
}

function getPeriodGoal(root, period, { date = null, now = new Date() } = {}) {
  const key = periodKey(period, date, now);
  return view(period, key, readPeriodGoals(root)[period][key] || null);
}

function setPeriodGoal(root, period, text, { date = null, now = new Date(), setBy = null } = {}) {
  const key = periodKey(period, date, now);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new PeriodGoalError(`the ${period} goal needs some words`);
  if (clean.length > TEXT_MAX) throw new PeriodGoalError(`keep the ${period} goal under ${TEXT_MAX} characters`);
  const goals = readPeriodGoals(root);
  goals[period][key] = { text: clean, set_by: setBy, updated_at: new Date().toISOString() };
  writePeriodGoals(goals, root);
  return view(period, key, goals[period][key]);
}

function clearPeriodGoal(root, period, { date = null, now = new Date() } = {}) {
  const key = periodKey(period, date, now);
  const goals = readPeriodGoals(root);
  const had = Boolean(goals[period][key]);
  if (had) {
    delete goals[period][key];
    writePeriodGoals(goals, root);
  }
  return { ...view(period, key, null), cleared: had };
}

// Current day and week goals, for read-only surfaces like the feed theme.
function currentPeriodGoals(root, now = new Date()) {
  return {
    day: getPeriodGoal(root, 'day', { now }),
    week: getPeriodGoal(root, 'week', { now }),
  };
}

module.exports = {
  PERIODS,
  PeriodGoalError,
  clearPeriodGoal,
  currentPeriodGoals,
  getPeriodGoal,
  periodKey,
  readPeriodGoals,
  setPeriodGoal,
};
