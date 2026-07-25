'use strict';

const {
  runGit,
  trackedTreeIsClean,
} = require('../lib/checkout-sync');

function refuse(message) {
  console.log(message);
  return 1;
}

function syncCheckoutCommand(args = [], cwd = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris sync-checkout.');
    return 0;
  }

  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (branchResult.status !== 0) {
    return refuse('this checkout is not on a git branch; sync-checkout refused to touch it.');
  }

  if (!trackedTreeIsClean(cwd)) {
    return refuse('this checkout has tracked changes; sync-checkout refused to touch it.');
  }

  const upstreamResult = runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd
  );
  if (upstreamResult.status !== 0) {
    return refuse('this checkout has no upstream; sync-checkout refused to touch it.');
  }
  const upstream = upstreamResult.stdout.trim();

  const fetchResult = runGit(['fetch'], cwd);
  if (fetchResult.status !== 0) {
    return refuse('this checkout could not sync because git fetch failed.');
  }

  const mergeResult = runGit(['merge', '--ff-only', '@{upstream}'], cwd);
  if (mergeResult.status !== 0) {
    return refuse('this checkout could not fast-forward; sync-checkout refused to change it.');
  }

  console.log(`this checkout is up to date with ${upstream}.`);
  return 0;
}

module.exports = { syncCheckoutCommand };
