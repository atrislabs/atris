'use strict';

const { spawnSync } = require('child_process');

// One synchronous git runner for commands that shell out to git.
// check: true throws on a non-zero exit; check: false hands back the raw result.
function runGit(args, { cwd = process.cwd(), check = true, maxBuffer } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...(maxBuffer ? { maxBuffer } : {}) });
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

module.exports = { runGit };
