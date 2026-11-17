'use strict';

// Where the scheduled jobs find their tools.
//
// launchd and cron start a job with PATH=/usr/bin:/bin. gh lives in
// /opt/homebrew/bin (or /usr/local/bin), so every gh call from the hourly
// landing job failed with "gh is not installed" while gh worked in every
// shell (2026-11-15 to 2026-11-17, backend and atris-cli). This module is the
// one list of folders those jobs search, and the one place that says a tool
// is really missing.

const fs = require('fs');
const path = require('path');

// The PATH a generated LaunchAgent carries: package folders first, then the
// system folders.
const SCHEDULE_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const SCHEDULE_PATH = SCHEDULE_PATH_DIRS.join(':');
// The folders a short PATH misses.
const PACKAGE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function pathDirs(value) {
  return String(value || '').split(path.delimiter).filter(Boolean);
}

// Folders to search after the caller's PATH: ATRIS_TOOL_DIRS, the folder of
// the node running now, then the package folders. ATRIS_TOOL_PACKAGE_DIRS
// replaces the package folders (a machine with tools elsewhere, or a test
// that needs a machine without gh).
function extraDirs(env = process.env, { execPath = process.execPath } = {}) {
  const packages = env.ATRIS_TOOL_PACKAGE_DIRS !== undefined ? pathDirs(env.ATRIS_TOOL_PACKAGE_DIRS) : PACKAGE_DIRS;
  const dirs = [...pathDirs(env.ATRIS_TOOL_DIRS), path.dirname(execPath), ...packages];
  return dirs.filter((dir, i, all) => all.indexOf(dir) === i);
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The full path of a tool, searching PATH and then the extra folders, or ''.
function findTool(name, env = process.env, opts = {}) {
  const dirs = [...pathDirs(env.PATH), ...extraDirs(env, opts)];
  for (const dir of dirs.filter((d, i, all) => all.indexOf(d) === i)) {
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return '';
}

// Add the extra folders that exist to the end of env.PATH, in place, so every
// child this process starts finds gh, npm and git. A PATH that already finds a
// tool still wins. Returns the folders added.
function ensureToolPath(env = process.env, opts = {}) {
  const current = pathDirs(env.PATH);
  const added = extraDirs(env, opts).filter((dir) => !current.includes(dir) && fs.existsSync(dir));
  if (added.length) env.PATH = [...current, ...added].join(path.delimiter);
  return added;
}

// The tools in `names` that cannot be found anywhere.
function missingTools(names, env = process.env, opts = {}) {
  return names.filter((name) => !findTool(name, env, opts));
}

// One plain line for a tool that is missing.
function missingToolLine(names, env = process.env, opts = {}) {
  if (!names.length) return '';
  const looked = [...pathDirs(env.PATH), ...extraDirs(env, opts)].filter((d, i, all) => all.indexOf(d) === i);
  const list = names.join(' and ');
  return `autoland tick: ${list} not found (looked in ${looked.join(', ')}), so this run could not check or land work that needs it. Install it or name its folder in ATRIS_TOOL_DIRS.`;
}

// A plist PATH that misses a package folder, given the PATH string it holds.
function schedulePathLacksTools(value) {
  const dirs = pathDirs(value);
  return PACKAGE_DIRS.some((dir) => !dirs.includes(dir));
}

// The PATH string with the schedule folders it lacks added, in schedule
// order first, then whatever else it had.
function repairedSchedulePath(value) {
  const dirs = pathDirs(value);
  const merged = [...SCHEDULE_PATH_DIRS, ...dirs].filter((d, i, all) => all.indexOf(d) === i);
  return merged.join(':');
}

module.exports = {
  SCHEDULE_PATH,
  SCHEDULE_PATH_DIRS,
  PACKAGE_DIRS,
  findTool,
  ensureToolPath,
  missingTools,
  missingToolLine,
  schedulePathLacksTools,
  repairedSchedulePath,
};
