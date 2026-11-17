'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// One synchronous git runner for commands that shell out to git.
// check: true throws on a non-zero exit; check: false hands back the raw result.
// input, when given, is written to git's stdin (for --stdin batch reads).
function runGit(args, { cwd = process.cwd(), check = true, maxBuffer, input } = {}) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', ...(maxBuffer ? { maxBuffer } : {}), ...(input !== undefined ? { input } : {}),
  });
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function gitStarts(bin, env) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', env, timeout: 10000 });
  if (result.status === 0) return { ok: true };
  const said = String(result.stderr || result.stdout || (result.error && result.error.message) || '').trim().split(/\r?\n/)[0];
  return { ok: false, detail: said || `git exited with code ${result.status}` };
}

// Cron starts with PATH=/usr/bin:/bin. On a Mac /usr/bin/git is a stub that
// starts the git inside Xcode, and the desktop app's background sandbox will
// not let it, so every git call failed and the lander read that as "no
// master/main branch" (2026-11-15). When the first git on PATH will not
// start, put the folder of one that does (ATRIS_TOOL_DIRS, then the usual
// package folders) first on PATH, so every git this process starts finds it.
// Checked once per process; a PATH whose git works is left alone.
let checked = null;
function ensureWorkingGit(env = process.env) {
  if (checked && env === process.env) return checked;
  const first = gitStarts('git', env);
  let outcome = { ok: true };
  if (!first.ok) {
    const named = String(env.ATRIS_TOOL_DIRS || '').split(path.delimiter).filter(Boolean);
    const dirs = [...named, '/opt/homebrew/bin', '/usr/local/bin'].filter((dir, i, all) => all.indexOf(dir) === i);
    outcome = { ok: false, detail: first.detail };
    for (const dir of dirs) {
      const bin = path.join(dir, 'git');
      if (!fs.existsSync(bin) || !gitStarts(bin, env).ok) continue;
      env.PATH = [dir, ...String(env.PATH || '').split(path.delimiter).filter((d) => d && d !== dir)].join(path.delimiter);
      outcome = { ok: true, moved: dir, detail: first.detail };
      break;
    }
  }
  if (env === process.env) checked = outcome;
  return outcome;
}

module.exports = { runGit, ensureWorkingGit };
