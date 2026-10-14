'use strict';

const { spawnSync } = require('node:child_process');

function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  return { command: `git ${args.join(' ')}`, status: result.status, passed: result.status === 0,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || result.error?.message || '').slice(-4000) };
}

// Pin before the worker starts, so committing its edits cannot hide whitespace.
function captureBase(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.passed) return /not a git repository/i.test(inside.stderr)
    ? { skipped: true, reason: 'no git repo' } : { error: inside };
  if (inside.stdout.trim() !== 'true') return { error: inside };
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.passed) return { head: head.stdout.trim() };
  // An unborn repo has no HEAD yet. Git computes its own empty tree id.
  const unborn = git(cwd, ['symbolic-ref', '-q', 'HEAD']);
  if (!unborn.passed || !/needed a single revision|unknown revision|bad revision/i.test(head.stderr)) {
    return { error: head };
  }
  const empty = git(cwd, ['hash-object', '-t', 'tree', '--stdin'], '');
  return empty.passed ? { head: empty.stdout.trim() } : { error: empty };
}

function checkRepo(cwd, base) {
  if (base.skipped) return { passed: true, skipped: true, reason: base.reason, checks: [] };
  const checks = base.error ? [base.error] : [
    git(cwd, ['diff', '--check', base.head]),
    git(cwd, ['diff', '--cached', '--check']),
    git(cwd, ['diff', '--check']),
  ];
  return { passed: checks.every((check) => check.passed), checks,
    stdout: checks.map((check) => check.stdout).filter(Boolean).join('\n'),
    stderr: checks.map((check) => check.stderr).filter(Boolean).join('\n') };
}

module.exports = { captureBase, checkRepo };
