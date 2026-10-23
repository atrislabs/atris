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

// The guard's script shell for npm, yarn, and pnpm. It puts the wrappers
// first, then runs the shell the project or user configured
// (ATRIS_SCRIPT_SHELL), or /bin/sh when none is. For a POSIX shell it also
// puts them first inside the command, since a shell like zsh can rebuild
// PATH as it starts.
function scriptShellSource(dir) {
  const q = `'${String(dir).replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    // every guard folder on PATH goes back first, in order, so nested guards
    // each still check (a guarded job whose tests make their own guard)
    `G=${q}`,
    'OWN="$G"; G=""',
    'IFS=:; for d in $PATH; do case "${d##*/}" in atris-mission-git-*) G="${G:+$G:}$d" ;; esac; done; unset IFS',
    '[ -z "$OWN" ] || case ":$G:" in *":$OWN:"*) ;; *) G="$OWN${G:+:$G}" ;; esac',
    'PATH="$G:$PATH"; export PATH',
    'shell="${ATRIS_SCRIPT_SHELL:-/bin/sh}"',
    // a guard's own script shell is never the configured one
    'case "$shell" in */atris-mission-git-*/script-shell) shell=/bin/sh ;; esac',
    'if [ "$1" = "-c" ] && [ $# -ge 2 ]; then',
    '  case "${shell##*/}" in',
    '    sh|bash|zsh|dash|ksh|mksh|ash)',
    '      cmd=$2; shift 2',
    `      exec "$shell" -c "PATH='$G':\\"\\$PATH\\"; export PATH; $cmd" "$@" ;;`,
    '  esac',
    'fi',
    'exec "$shell" "$@"',
    '',
  ].join('\n');
}

// The environment npm, yarn, or pnpm runs with under a guard: scripts go
// through the guard's shell, which then runs the configured one. The tool
// says which shell is configured (project, user, or global config, or the
// environment), asked with the same config-file and folder options the
// command was given; a nested call keeps what the outer one found.
const CONFIG_FLAGS = {
  npm: ['--userconfig', '--globalconfig', '--prefix', '-C'],
  pnpm: ['--userconfig', '--globalconfig', '--dir', '-C'],
  yarn: ['--use-yarnrc', '--cwd'],
};

function configFlags(tool, args = []) {
  const names = CONFIG_FLAGS[tool] || [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--') break;
    if (names.includes(a.split('=')[0]) && a.includes('=')) out.push(a);
    else if (names.includes(a) && args[i + 1] !== undefined) { out.push(a, String(args[i + 1])); i += 1; }
  }
  return out;
}

const inGuard = p => path.basename(path.dirname(String(p || ''))).startsWith(GUARD_DIR_PREFIX);
const isGuardShell = p => path.basename(String(p || '')) === 'script-shell' && inGuard(p);

// The real tool behind a wrapper, and behind a wrapper inside another guard:
// each wrapper records the tool it runs.
function realTool(bin) {
  let b = String(bin || '');
  for (let i = 0; i < 5 && inGuard(b); i += 1) {
    let next = null;
    try { const m = require('fs').readFileSync(b, 'utf8').match(/^const config = (.*);$/m); next = m && JSON.parse(m[1]).realBin; } catch { /* not a wrapper */ }
    if (!next) break;
    b = next;
  }
  return b;
}

function packageScriptEnv({ tool, realBin, scriptShell }, env = process.env, cwd = process.cwd(), args = []) {
  const out = { ...env, npm_config_script_shell: scriptShell };
  // .yarnrc beats npm_config_*, and YARN_SCRIPT_SHELL beats .yarnrc
  if (tool === 'yarn') out.YARN_SCRIPT_SHELL = scriptShell;
  if (tool === 'pnpm') out.npm_config_shell_emulator = 'false';
  if (env.npm_config_script_shell === scriptShell) return out;
  const { spawnSync } = require('child_process');
  // asked of the real tool, with any guard's shell out of the way, so the
  // project's or user's own setting shows through
  const askEnv = { ...env };
  for (const k of ['npm_config_script_shell', 'YARN_SCRIPT_SHELL']) if (isGuardShell(askEnv[k])) delete askEnv[k];
  const res = spawnSync(realTool(realBin), [...configFlags(tool, args), 'config', 'get', 'script-shell'], { cwd, env: askEnv, encoding: 'utf8', timeout: 10000 });
  const value = res.status === 0 ? String(res.stdout || '').trim().split('\n').pop().trim() : '';
  if (value && !/^(null|undefined)$/.test(value) && value !== scriptShell && !isGuardShell(value)) out.ATRIS_SCRIPT_SHELL = value;
  else delete out.ATRIS_SCRIPT_SHELL;
  return out;
}

module.exports = { GUARD_DIR_PREFIX, envWithNodeDir, shellGuardLine, scriptShellSource, packageScriptEnv };
