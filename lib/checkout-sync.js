'use strict';

const { spawnSync } = require('node:child_process');

function runGit(args, cwd = process.cwd()) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function checkoutBehind(cwd = process.cwd()) {
  const countResult = runGit(['rev-list', '--count', 'HEAD..@{upstream}'], cwd);
  if (countResult.status !== 0) return null;

  const count = Number.parseInt(countResult.stdout.trim(), 10);
  if (!Number.isInteger(count) || count < 1) return null;

  const upstreamResult = runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd
  );
  const upstream = upstreamResult.status === 0
    ? upstreamResult.stdout.trim()
    : 'origin';
  const remote = upstream.includes('/') ? upstream.split('/')[0] : upstream;

  return { count, upstream, remote };
}

function checkoutBehindMessage(cwd = process.cwd()) {
  const behind = checkoutBehind(cwd);
  if (!behind) return null;
  const unit = behind.count === 1 ? 'commit' : 'commits';
  return `this checkout is ${behind.count} ${unit} behind ${behind.remote}; run atris sync-checkout`;
}

function trackedTreeIsClean(cwd = process.cwd()) {
  const unstaged = runGit(['diff', '--quiet', '--'], cwd);
  if (unstaged.status !== 0) return false;

  const staged = runGit(['diff', '--cached', '--quiet', '--'], cwd);
  return staged.status === 0;
}

module.exports = {
  checkoutBehind,
  checkoutBehindMessage,
  runGit,
  trackedTreeIsClean,
};
