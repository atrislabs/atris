'use strict';

const path = require('path');

// The mission guard (lib/mission-protected-lane.js) puts a folder of
// wrappers for git, npm, gh, and atris first on a job's PATH. Anything that
// adds a folder ahead of it, or starts a login shell that rebuilds PATH from
// the profile, must put that folder back first, or a git or npm inside it
// skips the wrappers and the job's yes-lock.
const GUARD_DIR_PREFIX = 'atris-mission-git-';

function guardDirs(pathValue) {
  return String(pathValue || '').split(path.delimiter).filter(dir => dir && path.basename(dir).startsWith(GUARD_DIR_PREFIX));
}

// The PATH with any guard folder moved back to the front.
function guardFirst(pathValue) {
  const guards = guardDirs(pathValue);
  if (!guards.length) return String(pathValue || '');
  const rest = String(pathValue || '').split(path.delimiter).filter(dir => !guards.includes(dir));
  return [...guards, ...rest].join(path.delimiter);
}

// A first line for a shell script that puts the guard folder back first
// after the profile has run. Empty outside a guarded job.
function shellGuardLine(env = process.env) {
  const guards = guardDirs(env.PATH);
  if (!guards.length) return '';
  return `export PATH=${guards.map(d => `'${d.replace(/'/g, `'\\''`)}'`).join(':')}:"$PATH"\n`;
}

// Autonomously launched runtimes (cron, launchd, pulse ticks) carry a minimal
// PATH without node's directory, so any shell command that may invoke
// `node ...` fails only in the one environment nobody is watching. Three
// subsystems hit this on 2026-07-07 alone (experiment applies, atris2 relayed
// ops, always-on mission verifiers). Prepend the directory of the node that
// runs this CLI before spawning shell commands from autonomous paths, behind
// a guard folder if there is one.
function envWithNodeDir(base = process.env) {
  const nodeDir = path.dirname(process.execPath);
  const basePath = String(base.PATH || '');
  if (basePath.split(path.delimiter).includes(nodeDir)) return base;
  return { ...base, PATH: guardFirst(`${nodeDir}${path.delimiter}${basePath}`) };
}

module.exports = { GUARD_DIR_PREFIX, envWithNodeDir, shellGuardLine };
