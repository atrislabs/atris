'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runGit,
  trackedTreeIsClean,
} = require('../lib/checkout-sync');

function refuse(message) {
  console.log(message);
  return 1;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// 2026-11-12-134655, local time, so a backup sorts and reads like a date.
function backupStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Saves the checkout's tracked edits as a patch under ~/.atris/backups/<repo>/.
// Untracked files are only listed (in a sibling .untracked.txt), never copied.
// Returns { patchPath, untrackedPath } or null when nothing could be saved.
function writeBackup(cwd) {
  const topResult = runGit(['rev-parse', '--show-toplevel'], cwd);
  const top = topResult.status === 0 ? topResult.stdout.trim() : cwd;
  const repoName = path.basename(top) || 'checkout';

  const dir = path.join(os.homedir(), '.atris', 'backups', repoName);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = backupStamp();
  let patchPath = null;
  for (let attempt = 0; attempt < 100 && !patchPath; attempt += 1) {
    const candidate = path.join(dir, `${stamp}${attempt === 0 ? '' : `-${attempt}`}.patch`);
    if (!fs.existsSync(candidate)) patchPath = candidate;
  }
  if (!patchPath) return null;

  // Diff against HEAD so staged and unstaged edits land in one patch. Git
  // writes the file itself, so the bytes are exact even for odd encodings.
  const diffResult = runGit(
    ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', `--output=${patchPath}`],
    cwd
  );
  const written = diffResult.status === 0 && fs.existsSync(patchPath) && fs.statSync(patchPath).size > 0;
  if (!written) {
    fs.rmSync(patchPath, { force: true });
    return null;
  }

  const untrackedResult = runGit(['ls-files', '--others', '--exclude-standard'], top);
  const untracked = untrackedResult.status === 0
    ? untrackedResult.stdout.split('\n').filter(Boolean)
    : [];
  let untrackedPath = null;
  if (untracked.length > 0) {
    untrackedPath = patchPath.replace(/\.patch$/, '.untracked.txt');
    fs.writeFileSync(untrackedPath, `${untracked.join('\n')}\n`);
  }

  return { patchPath, untrackedPath };
}

function syncCheckoutCommand(args = [], cwd = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris sync-checkout [--backup].');
    return 0;
  }
  const backup = args.includes('--backup');

  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (branchResult.status !== 0) {
    return refuse('this checkout is not on a git branch; sync-checkout refused to touch it.');
  }

  const dirty = !trackedTreeIsClean(cwd);
  if (dirty && !backup) {
    console.log('this checkout has tracked changes; sync-checkout refused to touch it.');
    console.log('run: atris sync-checkout --backup   (saves your edits as a patch, then syncs)');
    return 1;
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

  if (dirty) {
    // Check the sync can succeed before touching anything, so a sync that
    // was never going to work does not cost anyone their edits.
    const canFastForward = runGit(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], cwd);
    if (canFastForward.status !== 0) {
      return refuse('this checkout could not fast-forward; sync-checkout refused to change it.');
    }
    const behindResult = runGit(['rev-list', '--count', 'HEAD..@{upstream}'], cwd);
    if (behindResult.status === 0 && behindResult.stdout.trim() === '0') {
      console.log(`this checkout is up to date with ${upstream}; your edits were left in place.`);
      return 0;
    }

    let saved;
    try {
      saved = writeBackup(cwd);
    } catch (error) {
      saved = null;
    }
    if (!saved) {
      return refuse('could not save your edits as a patch; sync-checkout refused to touch it.');
    }
    const resetResult = runGit(['reset', '--hard', '--quiet', 'HEAD'], cwd);
    if (resetResult.status !== 0) {
      return refuse(`could not set your edits aside; they are saved at ${saved.patchPath}`);
    }
    console.log(`saved your edits to ${saved.patchPath}`);
    if (saved.untrackedPath) {
      console.log(`untracked files were left in place; their names are in ${saved.untrackedPath}`);
    }
    console.log(`to restore them: git apply ${saved.patchPath}`);
  }

  const mergeResult = runGit(['merge', '--ff-only', '@{upstream}'], cwd);
  if (mergeResult.status !== 0) {
    return refuse('this checkout could not fast-forward; sync-checkout refused to change it.');
  }

  console.log(`this checkout is up to date with ${upstream}.`);
  return 0;
}

module.exports = { syncCheckoutCommand };
