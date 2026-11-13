'use strict';

const path = require('path');

const VALID_SLICES = ['full', 'code', 'exhaust', 'staged'];

/**
 * Parse CLI arguments for `atris restore`.
 */
function parseRestoreArgs(args = []) {
  const listArgs = Array.isArray(args) ? args : [];

  // Help takes precedence over operational flags (unless after `--`).
  const sepIndex = listArgs.indexOf('--');
  const optionSlice = sepIndex === -1 ? listArgs : listArgs.slice(0, sepIndex);
  if (
    optionSlice[0] === 'help'
    || optionSlice.includes('--help')
    || optionSlice.includes('-h')
  ) {
    return {
      help: true,
      list: false,
      json: false,
      dryRun: false,
      force: false,
      worktree: false,
      slice: 'full',
      sliceExplicit: false,
      agent: null,
      vaultId: null,
      paths: [],
      error: null,
    };
  }

  let list = false;
  let json = false;
  let dryRun = false;
  let force = false;
  let worktree = false;
  let slice = 'full';
  let sliceExplicit = false;
  let agent = null;
  let error = null;
  const positionals = [];
  let afterSeparator = false;

  const setError = (msg) => {
    if (!error) error = msg;
  };

  for (let i = 0; i < listArgs.length; i += 1) {
    const arg = String(listArgs[i]);
    if (afterSeparator) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg === '--list' || arg === '-l') {
      list = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      force = true;
      continue;
    }
    if (arg === '--worktree' || arg === '-w') {
      worktree = true;
      continue;
    }
    if (arg === '--slice' || arg.startsWith('--slice=')) {
      let val = '';
      if (arg.startsWith('--slice=')) {
        val = arg.slice('--slice='.length);
      } else if (i + 1 < listArgs.length && !String(listArgs[i + 1]).startsWith('-')) {
        val = String(listArgs[i + 1]);
        i += 1;
      }
      if (!val) {
        setError(`--slice requires a value (${VALID_SLICES.join('|')}).`);
      } else if (!VALID_SLICES.includes(val)) {
        setError(`Invalid --slice "${val}". Expected one of: ${VALID_SLICES.join(', ')}.`);
      } else {
        slice = val;
        sliceExplicit = true;
      }
      continue;
    }
    if (arg === '--agent' || arg.startsWith('--agent=')) {
      let val = '';
      if (arg.startsWith('--agent=')) {
        val = arg.slice('--agent='.length);
      } else if (i + 1 < listArgs.length && !String(listArgs[i + 1]).startsWith('-')) {
        val = String(listArgs[i + 1]);
        i += 1;
      }
      if (!val) {
        setError('--agent requires a value.');
      } else {
        agent = val;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      setError(`Unknown option: ${arg}`);
      continue;
    }
    positionals.push(arg);
  }

  const vaultId = positionals[0] || null;
  const paths = positionals.slice(1);

  if (!error && !list && !vaultId) {
    if (worktree || sliceExplicit || force || dryRun || agent) {
      setError('Missing <vault-id>. Run "atris restore --list" to see available snapshots.');
    } else {
      list = true;
    }
  }

  return {
    help: false,
    list,
    json,
    dryRun,
    force,
    worktree,
    slice,
    sliceExplicit,
    agent,
    vaultId,
    paths,
    error,
  };
}

/**
 * Print usage help for `atris restore`.
 */
function showRestoreHelp() {
  console.log('');
  console.log('Usage: atris restore [--list] [--json]');
  console.log('       atris restore <vault-id> [paths...] [--slice full|code|exhaust|staged] [--dry-run] [--force] [--json]');
  console.log('       atris restore <vault-id> --slice code --worktree [--agent <name>]');
  console.log('');
  console.log('Description:');
  console.log('  List and restore files saved in the Atris hygiene vault.');
  console.log('  Running with no <vault-id> lists available snapshots.');
  console.log('');
  console.log('Options:');
  console.log('  --list, -l           List available vault snapshots (default when no <vault-id>).');
  console.log('  --slice <name>       Snapshot slice to restore: full (default), code, exhaust, or staged.');
  console.log('  --worktree, -w       Restore into a new isolated agent worktree instead of cwd.');
  console.log('  --agent <name>       Agent name for the new worktree (used with --worktree).');
  console.log('  --dry-run, -n        Preview files that would be restored without writing.');
  console.log('  --force, -f          Overwrite existing dirty or conflicting local files.');
  console.log('  --json               Print machine-readable output.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('Examples:');
  console.log('  atris restore --list');
  console.log('  atris restore 20261112-204500-a1b2c3 --slice code --worktree');
  console.log('  atris restore 20261112-204500-a1b2c3 backend/services/trace_capture.py');
  console.log('');
  return 0;
}

function resolveVaultLib(options = {}) {
  if (options.vaultLib) return options.vaultLib;
  return require('../lib/hygiene-vault');
}

function extractSnapshots(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.snapshots)) return raw.snapshots;
  if (raw && Array.isArray(raw.vaults)) return raw.vaults;
  return [];
}

function emitError(message, { json = false, action = 'restore', conflicts = [] } = {}) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      action,
      error: message,
      ...(conflicts.length ? { conflicts } : {}),
    }, null, 2));
    return;
  }
  console.error(`✗ ${message}`);
  if (conflicts.length) {
    for (const file of conflicts.slice(0, 10)) {
      console.error(`  • ${file}`);
    }
    if (conflicts.length > 10) {
      console.error(`  ... and ${conflicts.length - 10} more`);
    }
    console.error('Pass --force to overwrite existing local files.');
  }
}

function formatSnapshotLine(snap) {
  const id = snap.id || snap.vaultId || '(unknown)';
  const at = snap.at || snap.createdAt || snap.timestamp || '';
  const counts = snap.counts_by_class || snap.countsByClass || snap.counts || null;
  const codeFiles = snap.code_files || snap.codeFiles || [];
  const slices = snap.refs ? Object.keys(snap.refs) : (Array.isArray(snap.slices) ? snap.slices : []);
  const parts = [];
  if (counts && typeof counts === 'object') {
    const codeCount = counts.UNFINISHED_CODE ?? counts.code ?? codeFiles.length ?? 0;
    const exhaustCount = counts.AGENT_EXHAUST ?? counts.exhaust ?? 0;
    const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    if (codeCount) parts.push(`code: ${codeCount}`);
    if (exhaustCount) parts.push(`exhaust: ${exhaustCount}`);
    if (total && !codeCount && !exhaustCount) parts.push(`files: ${total}`);
  } else if (codeFiles.length) {
    parts.push(`code: ${codeFiles.length}`);
  }
  if (slices.length) parts.push(`slices: ${slices.join(',')}`);
  const summary = parts.length ? ` (${parts.join(', ')})` : '';
  return `  • ${id}${at ? `  ${at}` : ''}${summary}`;
}

function renderVaultList(snapshots, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'restore_list',
      count: snapshots.length,
      snapshots,
    }, null, 2));
    return 0;
  }
  if (!snapshots.length) {
    console.log('No vault snapshots found.');
    console.log('Run "atris clean --apply" to vault dirty workspace files.');
    return 0;
  }
  console.log(`Vault snapshots (${snapshots.length}):`);
  for (const snap of snapshots) {
    console.log(formatSnapshotLine(snap));
    const quarantine = snap.quarantine_path || snap.quarantineDir || null;
    if (quarantine) {
      console.log(`    quarantine: ${quarantine}`);
    }
  }
  console.log('');
  console.log('Restore code slice to worktree: atris restore <vault-id> --slice code --worktree');
  console.log('Restore specific path:         atris restore <vault-id> <path>');
  return 0;
}

function renderRestoreResult(out, parsed) {
  const isDryRun = Boolean(out.dryRun ?? parsed.dryRun);
  const restoredFiles = (isDryRun && Array.isArray(out.paths) && out.paths.length ? out.paths : null)
    || (Array.isArray(out.restored) && out.restored.length ? out.restored : null)
    || out.restoredFiles
    || out.files
    || out.paths
    || [];
  const quarantinedFiles = out.quarantinedRestored || out.quarantineFiles || out.quarantined || [];
  const skippedFiles = out.skipped || out.skippedFiles || [];
  const worktreePath = out.worktreePath
    || out.worktree_path
    || (typeof out.worktree === 'string' ? out.worktree : out.worktree?.path)
    || null;
  const branch = out.branch || out.worktreeBranch || out.worktree?.branch || null;
  const resolvedSlice = out.slice || parsed.slice;
  const resolvedVaultId = out.vaultId || out.vault_id || out.id || parsed.vaultId;

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'restore',
      dry_run: isDryRun,
      vault_id: resolvedVaultId,
      slice: resolvedSlice,
      worktree: parsed.worktree || Boolean(worktreePath),
      agent: parsed.agent || null,
      force: parsed.force,
      requested_paths: parsed.paths,
      restored_count: restoredFiles.length,
      restored_files: restoredFiles,
      quarantined_files: quarantinedFiles,
      skipped_files: skippedFiles,
      worktree_path: worktreePath,
      branch,
    }, null, 2));
    return 0;
  }

  const verb = isDryRun ? 'Would restore' : 'Restored';
  const count = restoredFiles.length;
  const targetSuffix = worktreePath || parsed.worktree ? ' into worktree' : '';
  console.log(`✓ ${verb} ${count} ${count === 1 ? 'file' : 'files'} from ${resolvedVaultId} (slice: ${resolvedSlice})${targetSuffix}`);

  for (const file of restoredFiles.slice(0, 20)) {
    console.log(`  • ${file}`);
  }
  if (restoredFiles.length > 20) {
    console.log(`  ... and ${restoredFiles.length - 20} more`);
  }
  if (quarantinedFiles.length > 0) {
    const qVerb = isDryRun ? 'Would restore' : 'Restored';
    console.log(`✓ ${qVerb} ${quarantinedFiles.length} quarantined ${quarantinedFiles.length === 1 ? 'file' : 'files'}`);
  }
  if (skippedFiles.length > 0) {
    console.log(`⚠ Skipped ${skippedFiles.length} ${skippedFiles.length === 1 ? 'file' : 'files'}`);
  }
  if (worktreePath) {
    console.log(`  worktree: ${worktreePath}`);
    if (branch) console.log(`  branch:   ${branch}`);
    console.log(`  next:     cd ${worktreePath}`);
  }
  return 0;
}

/**
 * CLI entrypoint for `atris restore`.
 * Returns numeric exit code (0 success, 1 failure, 2 usage error).
 */
function restoreCommand(args = [], options = {}) {
  const parsed = parseRestoreArgs(args);
  if (parsed.help) {
    return showRestoreHelp();
  }
  if (parsed.error) {
    emitError(parsed.error, {
      json: parsed.json,
      action: parsed.list ? 'restore_list' : 'restore',
    });
    if (!parsed.json) {
      console.error('Run "atris restore --help" for usage.');
    }
    return 2;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  let vaultLib;
  try {
    vaultLib = resolveVaultLib(options);
  } catch (err) {
    emitError(err.message || 'Hygiene vault library is unavailable.', {
      json: parsed.json,
      action: parsed.list ? 'restore_list' : 'restore',
    });
    return 1;
  }

  if (parsed.list) {
    try {
      const raw = vaultLib.listVaultSnapshots(cwd);
      const snapshots = extractSnapshots(raw);
      return renderVaultList(snapshots, { json: parsed.json });
    } catch (err) {
      emitError(err.message || 'Failed to list vault snapshots.', {
        json: parsed.json,
        action: 'restore_list',
      });
      return 1;
    }
  }

  let out;
  try {
    out = vaultLib.restoreFromVault(cwd, {
      vaultId: parsed.vaultId,
      paths: parsed.paths,
      slice: parsed.slice,
      worktree: parsed.worktree,
      agent: parsed.agent,
      dryRun: parsed.dryRun,
      force: parsed.force,
    });
  } catch (err) {
    const conflicts = Array.isArray(err?.conflicts) ? err.conflicts : [];
    emitError(err?.message || 'Failed to restore from vault.', {
      json: parsed.json,
      action: 'restore',
      conflicts,
    });
    return Number.isInteger(err?.exitCode) ? err.exitCode : 1;
  }

  if (!out || out.ok === false || out.error) {
    const conflicts = Array.isArray(out?.conflicts) ? out.conflicts : [];
    emitError((out && out.error) || 'Failed to restore from vault.', {
      json: parsed.json,
      action: 'restore',
      conflicts,
    });
    return 1;
  }

  return renderRestoreResult(out, parsed);
}

module.exports = {
  restoreCommand,
  parseRestoreArgs,
  showRestoreHelp,
};
