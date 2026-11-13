'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runGit,
  trackedTreeIsClean,
} = require('../lib/checkout-sync');
const {
  DEFAULT_GRACE_MS,
  scanGitHygiene,
  vaultAndCleanCheckout,
} = require('../lib/hygiene-vault');

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

function parseSyncOptions(args) {
  const backup = args.includes('--backup');
  const vault = args.includes('--vault');
  let graceMinutes = null;
  let invalidGrace = false;
  let hasGraceArg = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--grace-minutes') {
      hasGraceArg = true;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        invalidGrace = true;
        break;
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        invalidGrace = true;
        break;
      }
      graceMinutes = parsed;
      i += 1;
    } else if (arg.startsWith('--grace-minutes=')) {
      hasGraceArg = true;
      const raw = arg.slice('--grace-minutes='.length);
      const parsed = Number(raw);
      if (!raw || !Number.isFinite(parsed) || parsed < 0) {
        invalidGrace = true;
        break;
      }
      graceMinutes = parsed;
    }
  }

  return {
    backup,
    vault,
    invalidGrace,
    hasGraceArg,
    graceMs: graceMinutes === null ? DEFAULT_GRACE_MS : graceMinutes * 60 * 1000,
  };
}

function resolveRepoRoot(cwd) {
  const topResult = runGit(['rev-parse', '--show-toplevel'], cwd);
  return topResult.status === 0 && topResult.stdout.trim()
    ? topResult.stdout.trim()
    : cwd;
}

function countBehindUpstream(cwd) {
  const behindResult = runGit(['rev-list', '--count', 'HEAD..@{upstream}'], cwd);
  if (behindResult.status !== 0) return null;
  const count = Number.parseInt(behindResult.stdout.trim(), 10);
  return Number.isInteger(count) ? count : null;
}

function runVaultBeforeSync(cwd, upstream, graceMs) {
  // Check the sync can succeed before vaulting or touching anything.
  const canFastForward = runGit(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], cwd);
  if (canFastForward.status !== 0) {
    return { ok: false, code: refuse('this checkout could not fast-forward; sync-checkout refused to change it.') };
  }

  const behindCount = countBehindUpstream(cwd);
  const isBehind = behindCount !== null && behindCount > 0;
  const repoRoot = resolveRepoRoot(cwd);

  const preScan = scanGitHygiene(repoRoot, { graceMs });
  let vaultResult = null;
  if (isBehind || preScan.actionableCount > 0) {
    try {
      vaultResult = vaultAndCleanCheckout(repoRoot, { graceMs });
    } catch (error) {
      return {
        ok: false,
        code: refuse(`could not vault checkout changes: ${error.message}`),
      };
    }
  }

  if (vaultResult && vaultResult.vaultId) {
    const vaultedCount = vaultResult.receipt && Array.isArray(vaultResult.receipt.vaulted_files)
      ? vaultResult.receipt.vaulted_files.length
      : 0;
    const quarantinedCount = vaultResult.receipt && Array.isArray(vaultResult.receipt.quarantine_files)
      ? vaultResult.receipt.quarantine_files.length
      : 0;
    console.log(
      `vaulted ${vaultedCount} file(s) to ${vaultResult.refs.full} (${vaultResult.vaultId}); catalog at .atris/state/vault-catalog.md`
    );
    if (quarantinedCount > 0 && vaultResult.quarantineDir) {
      console.log(`quarantined ${quarantinedCount} sensitive or large file(s) to ${vaultResult.quarantineDir}`);
    }
    console.log(`to restore them: atris restore ${vaultResult.vaultId}`);
    const skipped = vaultResult.resetStats && vaultResult.resetStats.skippedConcurrentEdit;
    if (Array.isArray(skipped) && skipped.length > 0) {
      console.log(`left ${skipped.length} concurrently modified file(s) in place.`);
    }
  }

  const scan = (vaultResult && vaultResult.scan) ? vaultResult.scan : preScan;
  const activeCount = (scan.byClass && scan.byClass.ACTIVE_IN_FLIGHT) || 0;
  const unprovableCount = (scan.byClass && scan.byClass.UNPROVABLE_KEEP) || 0;
  const preservedCount = activeCount + unprovableCount;

  if (!isBehind) {
    if (preservedCount > 0 || !trackedTreeIsClean(repoRoot)) {
      const shownCount = preservedCount > 0 ? `${preservedCount} ` : '';
      console.log(`this checkout is up to date with ${upstream}; ${shownCount}active or protected file(s) were left in place.`);
    } else {
      console.log(`this checkout is up to date with ${upstream}.`);
    }
    return { ok: true, done: true, code: 0, preservedCount, gitCwd: repoRoot };
  }

  if (!trackedTreeIsClean(repoRoot)) {
    const reasons = [];
    if (activeCount > 0) reasons.push(`${activeCount} active in-flight`);
    if (unprovableCount > 0) reasons.push(`${unprovableCount} unprovable`);
    const detail = reasons.length ? ` (${reasons.join(', ')})` : '';
    return {
      ok: false,
      code: refuse(
        `this checkout still has protected tracked changes${detail}; sync-checkout left them in place and did not fast-forward.`
      ),
    };
  }

  return { ok: true, done: false, preservedCount, gitCwd: repoRoot };
}

function syncCheckoutCommand(args = [], cwd = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris sync-checkout [--backup | --vault [--grace-minutes <N>]].');
    return 0;
  }

  const opts = parseSyncOptions(args);
  if (opts.backup && opts.vault) {
    return refuse('choose either --backup or --vault, not both.');
  }
  if (opts.invalidGrace) {
    return refuse('invalid --grace-minutes value; expected a non-negative number.');
  }
  if (opts.hasGraceArg && !opts.vault) {
    return refuse('--grace-minutes requires --vault.');
  }

  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (branchResult.status !== 0) {
    return refuse('this checkout is not on a git branch; sync-checkout refused to touch it.');
  }

  const dirty = !trackedTreeIsClean(cwd);
  if (dirty && !opts.backup && !opts.vault) {
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

  let preservedCount = 0;
  let gitCwd = cwd;
  if (opts.vault) {
    const vaultOutcome = runVaultBeforeSync(cwd, upstream, opts.graceMs);
    if (!vaultOutcome.ok) return vaultOutcome.code;
    if (vaultOutcome.done) return vaultOutcome.code;
    preservedCount = vaultOutcome.preservedCount || 0;
    gitCwd = vaultOutcome.gitCwd || cwd;
  } else if (dirty) {
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

  const mergeResult = runGit(['merge', '--ff-only', '@{upstream}'], gitCwd);
  if (mergeResult.status !== 0) {
    if (preservedCount > 0) {
      return refuse(
        'this checkout could not fast-forward because active or protected files remain in place; sync-checkout refused to delete them.'
      );
    }
    return refuse('this checkout could not fast-forward; sync-checkout refused to change it.');
  }

  if (preservedCount > 0) {
    console.log(`left ${preservedCount} active or protected file(s) in place.`);
  }
  console.log(`this checkout is up to date with ${upstream}.`);
  return 0;
}

module.exports = { syncCheckoutCommand };
