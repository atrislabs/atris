// atris campaign schedule: a person says yes once, and the campaign starts on
// its own at set times until its budget is spent. The schedule lives beside the
// campaign's other files, not in its events, so other surfaces fold unchanged.
// `atris campaign wake` (the keep timer) and `atris campaign tick` fire it.
// Spec: atris/features/campaign/schedule.md.

'use strict';

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_SETS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
const DEFAULT_STEPS = 4;

const HOW = 'say when like "weekdays 09:00", "daily 18:30", "mon,thu 07:00", or "30m" / "2h"';

// "30m", "2h", "daily 09:00", "weekdays 09:00", "mon,wed 14:30", or "09:00"
// (every day). Clock times are local to the computer that runs the timer.
function parseEvery(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return { error: `a schedule needs a time: ${HOW}` };
  const interval = /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(value);
  if (interval) {
    const ms = Number(interval[1]) * (interval[2].startsWith('h') ? 60 : 1) * MIN;
    if (ms < MIN) return { error: 'a schedule runs at most once a minute' };
    return { rule: { kind: 'interval', ms }, every: value };
  }
  const parts = value.split(/\s+/);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(parts[parts.length - 1]);
  if (!clock || parts.length > 2) return { error: `cannot read "${text}": ${HOW}` };
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59) return { error: `"${parts[parts.length - 1]}" is not a time of day` };
  let days = DAY_SETS.daily;
  if (parts.length === 2) {
    days = DAY_SETS[parts[0]];
    if (!days) {
      days = [];
      for (const name of parts[0].split(',')) {
        const day = DAY_NAMES.indexOf(name.slice(0, 3));
        if (day < 0 || (name.length > 3 && !name.startsWith(DAY_NAMES[day]))) return { error: `"${name}" is not a day: ${HOW}` };
        if (!days.includes(day)) days.push(day);
      }
      days.sort();
    }
  }
  return { rule: { kind: 'clock', days, hour, minute }, every: value };
}

// The next slot after `after` (epoch ms), on a whole minute so it is due at the
// minute it is shown, and the one-minute timer never runs it a minute late.
function nextAt(rule, after) {
  if (rule.kind === 'interval') return Math.floor((after + rule.ms) / MIN) * MIN;
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setHours(rule.hour, rule.minute);
  for (let i = 0; i < 8; i++) {
    if (at.getTime() > after && rule.days.includes(at.getDay())) return at.getTime();
    at.setDate(at.getDate() + 1);
    at.setHours(rule.hour, rule.minute, 0, 0);
  }
  return null;
}

function scheduleFile(home, campaignId) {
  return path.join(home, 'campaigns', campaignId, 'schedule.json');
}

function readSchedule(home, campaignId) {
  if (!home) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(scheduleFile(home, campaignId), 'utf8'));
    return saved && saved.rule && Number.isFinite(saved.next_at) ? saved : null;
  } catch {
    return null;
  }
}

function writeSchedule(home, campaignId, schedule) {
  const file = scheduleFile(home, campaignId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(schedule, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return schedule;
}

function saveSchedule(home, campaignId, { every, rule, steps = DEFAULT_STEPS, by, now }) {
  return writeSchedule(home, campaignId, {
    campaign_id: campaignId, every, rule, steps, approved_by: by,
    approved_at: new Date(now).toISOString(), last_fired_at: null, next_at: nextAt(rule, now),
  });
}

function removeSchedule(home, campaignId) {
  const file = scheduleFile(home, campaignId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function isDue(schedule, now) {
  return Boolean(schedule) && now >= schedule.next_at;
}

// Use up the slot before the run starts, so a run that crashes does not fire
// again every minute. A slot missed while the computer slept fires once.
function markFired(home, campaignId, schedule, now) {
  return writeSchedule(home, campaignId, { ...schedule, last_fired_at: new Date(now).toISOString(), next_at: nextAt(schedule.rule, now) });
}

function whenText(ms) {
  const at = new Date(ms);
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function describe(schedule) {
  return `${schedule.every}, up to ${schedule.steps} step${schedule.steps === 1 ? '' : 's'} each time; next ${whenText(schedule.next_at)}`;
}

module.exports = { DEFAULT_STEPS, describe, isDue, markFired, nextAt, parseEvery, readSchedule, removeSchedule, saveSchedule, scheduleFile, whenText };
