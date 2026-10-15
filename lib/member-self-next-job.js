'use strict';

// When a member's job list is empty, it writes its own next job from its
// standing mission (atris/team/<member>/MISSION.md) and keeps working. The
// job is a normal open task: the North Star is the goal, and the mission's
// `## Check` section names the command that proves a run. A mission with no
// runnable check writes nothing, so the member stays idle as before. At most
// one self-written job is open per member, and at most MAX_PER_DAY are
// written per member per local day, so an idle team cannot spin forever.

const fs = require('fs');
const path = require('path');
const { skipReason, taskCheck } = require('./member-task-pick');

const MAX_PER_DAY = 3;
const TITLE_MAX = 120;

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// The body of one `## <name>` section, up to the next `## ` heading.
function section(text, name) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

// The job a mission file asks for next: its North Star as the goal and its
// check command. null when either is missing.
function missionNextJob(text) {
  const northStar = oneLine(section(text, 'north star').split(/\n\s*\n/)[0]);
  const checkBlock = section(text, 'check');
  const tick = checkBlock.match(/`([^`\n]+)`/);
  const check = oneLine(tick ? tick[1] : checkBlock.split(/\r?\n/).find((line) => line.trim()));
  if (!northStar || !check) return null;
  const goal = northStar.length > TITLE_MAX ? `${northStar.slice(0, TITLE_MAX - 3).trim()}...` : northStar;
  return { title: `next step toward: ${goal}`, objective: northStar, check };
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Write the member's next job from its mission. Returns { task } with the
// new open task, or { skip } with a plain reason. dryRun returns the task it
// would write without writing it.
function writeSelfNextJob(taskDb, db, { root, workspaceRoot, member, job, now = Date.now(), dryRun = false }) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'atris', 'team', member, 'MISSION.md'), 'utf8');
  } catch {
    return { skip: 'no mission file' };
  }
  const next = missionNextJob(text);
  if (!next) return { skip: 'mission names no north star or no check' };
  const metadata = {
    verify: next.check,
    objective: next.objective,
    written_by: member,
    source: 'member mission',
  };
  const probe = { status: 'open', title: next.title, tag: job, metadata };
  if (!taskCheck(probe).runnable) return { skip: 'mission check cannot be run here' };
  const held = skipReason(probe, job, { requireCheck: true, member });
  if (held) return { skip: `the job it would write is not one it can take (${held})` };

  const prefix = `self-next:${member}:`;
  const mine = db.prepare(
    'SELECT id, status, source_key FROM tasks WHERE workspace_root = ? AND source_key LIKE ?'
  ).all(workspaceRoot, `${prefix}%`);
  if (mine.some((row) => row.status === 'open' || row.status === 'claimed')) {
    return { skip: 'its last self-written job is still open' };
  }
  const day = localDay(now);
  const today = mine.filter((row) => String(row.source_key).startsWith(`${prefix}${day}:`)).length;
  if (today >= MAX_PER_DAY) return { skip: `already wrote ${MAX_PER_DAY} jobs for itself today` };

  if (dryRun) return { task: { id: null, ...probe } };
  const added = taskDb.addTask(db, {
    title: next.title,
    tag: job,
    workspaceRoot,
    sourceKey: `${prefix}${day}:${today + 1}`,
    metadata,
  });
  return { task: taskDb.getTask(db, added.id) };
}

module.exports = {
  MAX_PER_DAY,
  missionNextJob,
  writeSelfNextJob,
};
