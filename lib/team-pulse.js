'use strict';

const fs = require('fs');
const path = require('path');

const RECENT_WORK_MS = 24 * 60 * 60 * 1000;

function readTasks(root) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  try {
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    return Array.isArray(projection?.tasks) ? projection.tasks : [];
  } catch {
    return [];
  }
}

function timestampMs(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentTimestamp(task, nowMs, windowMs, completed = false) {
  const stamp = timestampMs(completed ? task?.done_at || task?.updated_at : task?.updated_at);
  return stamp > 0 && stamp <= nowMs && nowMs - stamp <= windowMs ? stamp : 0;
}

function briefWork(value, max = 96) {
  const clean = String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  if (!clean) return '';
  const named = clean.includes(':') ? clean.split(':', 1)[0].trim() : clean;
  if (named.length <= max) return named.toLowerCase();
  const cut = named.slice(0, max + 1);
  const boundary = cut.lastIndexOf(' ');
  return named.slice(0, boundary > 0 ? boundary : max).replace(/[,;:]+$/, '').toLowerCase();
}

function collectEarnedTeamPulse(root = process.cwd(), options = {}) {
  const tasks = Array.isArray(options.tasks) ? options.tasks : readTasks(root);
  const nowMs = typeof options.now === 'function' ? options.now() : options.now || Date.now();
  const windowMs = options.windowMs || RECENT_WORK_MS;

  const active = tasks
    .map((task) => ({ task, stamp: recentTimestamp(task, nowMs, windowMs) }))
    .filter(({ task, stamp }) => stamp && String(task?.status || '').toLowerCase() === 'claimed' && task?.claimed_by)
    .sort((a, b) => b.stamp - a.stamp)[0]?.task;
  if (active) {
    const work = briefWork(active.title);
    if (work) return `team pulse: ${String(active.claimed_by).trim().toLowerCase()} is moving ${work}. keep going.`;
  }

  const completed = tasks
    .map((task) => ({ task, stamp: recentTimestamp(task, nowMs, windowMs, true) }))
    .filter(({ task, stamp }) => stamp && String(task?.status || '').toLowerCase() === 'done' && task?.result)
    .sort((a, b) => b.stamp - a.stamp)[0]?.task;
  if (!completed) return null;

  const result = briefWork(completed.result);
  if (!result) return null;
  const owner = String(completed.claimed_by || '').trim().toLowerCase();
  return owner
    ? `team pulse: ${owner} finished ${result}. nice work.`
    : `team pulse: ${result} is done. nice work.`;
}

module.exports = {
  RECENT_WORK_MS,
  briefWork,
  collectEarnedTeamPulse,
};
