const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const escapeRegExp = require('../lib/escape-regexp');
const { localDay } = require('../lib/local-day');
const { wikiMetabolismNudge } = require('../lib/wiki');

const PRESERVED_HYGIENE_CLASSES = new Set(['ACTIVE_IN_FLIGHT', 'UNPROVABLE_KEEP']);

/**
 * Parse CLI arguments for `atris clean`.
 */
function parseCleanArgs(args = []) {
  const list = Array.isArray(args) ? args : [];
  let dryRun = false;
  let json = false;
  let apply = false;
  let vaultOnly = false;
  let graceMinutes = 30;
  let error = null;

  const setError = (msg) => {
    if (!error) error = msg;
  };

  for (let i = 0; i < list.length; i += 1) {
    const arg = String(list[i]);
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--apply' || arg === '--vault') {
      apply = true;
      continue;
    }
    if (arg === '--vault-only') {
      vaultOnly = true;
      continue;
    }
    if (arg === '--grace-minutes' || arg.startsWith('--grace-minutes=')) {
      let raw = '';
      if (arg.startsWith('--grace-minutes=')) {
        raw = arg.slice('--grace-minutes='.length);
      } else if (i + 1 < list.length && !String(list[i + 1]).startsWith('--')) {
        raw = String(list[i + 1]);
        i += 1;
      }
      const parsed = raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('--grace-minutes requires a non-negative number.');
      } else {
        graceMinutes = parsed;
      }
      continue;
    }
  }

  return { dryRun, json, apply, vaultOnly, graceMinutes, error };
}

function resolveGraceMinutes(options = {}) {
  if (options.graceMinutes === undefined || options.graceMinutes === null) return 30;
  const n = Number(options.graceMinutes);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function preservedHygieneEntries(gitHygiene) {
  return (gitHygiene?.entries || []).filter((e) => PRESERVED_HYGIENE_CLASSES.has(e.cls));
}

function gitClassSuffix(cls) {
  if (PRESERVED_HYGIENE_CLASSES.has(cls)) return ' (preserved)';
  if (cls === 'SECRET_OR_FAT_QUARANTINE') return ' (quarantine)';
  return '';
}

function collectPermissionLocked(vaultOutcome, recoveredVaults = []) {
  const fromVault = vaultOutcome?.resetStats?.skippedPermissionLocked || [];
  const fromRecovered = (recoveredVaults || []).flatMap((r) => r.resetStats?.skippedPermissionLocked || []);
  return [...new Set([...fromVault, ...fromRecovered])];
}

function renderGitHygieneText(gitHygiene, vaultOutcome, options = {}, recoveredVaults = []) {
  if (!gitHygiene || !gitHygiene.isGitRepo) return;

  const preserved = preservedHygieneEntries(gitHygiene);
  const replayLocked = (recoveredVaults || []).flatMap((r) => r.resetStats?.skippedPermissionLocked || []);
  if (vaultOutcome && vaultOutcome.applied && vaultOutcome.vaultId) {
    const vaultedFiles = vaultOutcome.receipt?.vaulted_files || [];
    const quarantinedFiles = vaultOutcome.receipt?.quarantine_files || [];
    const slices = Object.keys(vaultOutcome.refs || {});
    const sliceText = slices.length ? ` (slices: ${slices.join(', ')})` : '';
    console.log(`✓ Vaulted ${vaultedFiles.length} dirty git ${vaultedFiles.length === 1 ? 'file' : 'files'} to ${vaultOutcome.vaultId}${sliceText}`);
    if (quarantinedFiles.length > 0 && vaultOutcome.quarantineDir) {
      console.log(`✓ Quarantined ${quarantinedFiles.length} secret/fat ${quarantinedFiles.length === 1 ? 'file' : 'files'} to ${vaultOutcome.quarantineDir}`);
    }
    const stats = vaultOutcome.resetStats;
    if (stats) {
      console.log(`  reset ${stats.resetCount || 0} tracked, removed ${stats.unlinkedCount || 0} untracked`);
      if ((stats.skippedConcurrentEdit || []).length > 0) {
        console.log(`⚠ Skipped ${stats.skippedConcurrentEdit.length} concurrently modified ${stats.skippedConcurrentEdit.length === 1 ? 'file' : 'files'}:`);
        stats.skippedConcurrentEdit.slice(0, 5).forEach((p) => console.log(`   • ${p}`));
        if (stats.skippedConcurrentEdit.length > 5) {
          console.log(`   ... and ${stats.skippedConcurrentEdit.length - 5} more`);
        }
      }
      if ((stats.skippedPermissionLocked || []).length > 0) {
        console.log(`⚠ Skipped ${stats.skippedPermissionLocked.length} permission-locked ${stats.skippedPermissionLocked.length === 1 ? 'file' : 'files'} (EPERM/EACCES):`);
        stats.skippedPermissionLocked.slice(0, 5).forEach((p) => console.log(`   • ${p}`));
        if (stats.skippedPermissionLocked.length > 5) {
          console.log(`   ... and ${stats.skippedPermissionLocked.length - 5} more`);
        }
      }
    }
    if (preserved.length > 0) {
      console.log(`⚠ Preserved ${preserved.length} in-flight/unprovable ${preserved.length === 1 ? 'file' : 'files'} on disk:`);
      preserved.slice(0, 5).forEach((e) => console.log(`   • ${e.relPath} (${e.cls})`));
      if (preserved.length > 5) {
        console.log(`   ... and ${preserved.length - 5} more`);
      }
    }
    if (gitHygiene.remainingDirty === 0) {
      console.log('✓ Working tree is clean (0 dirty git files)');
    }
    console.log('');
    return;
  }

  if (gitHygiene.dirtyCount === 0) {
    console.log('✓ Working tree is clean (0 dirty git files)');
    return;
  }

  const preservedCount = preserved.length;
  const modeHint = options.apply && options.dryRun && gitHygiene.actionableCount > 0
    ? '; dry-run would vault actionable files'
    : '';
  console.log(`⚠ ${gitHygiene.dirtyCount} dirty git ${gitHygiene.dirtyCount === 1 ? 'file' : 'files'} (${gitHygiene.actionableCount} actionable, ${preservedCount} preserved${modeHint}):`);
  const entriesByClass = Object.entries(gitHygiene.byClass || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [cls, count] of entriesByClass) {
    console.log(`   • ${cls}: ${count}${gitClassSuffix(cls)}`);
  }
  if ((gitHygiene.topBundles || []).length > 0) {
    const bundleSummary = gitHygiene.topBundles
      .slice(0, 3)
      .map((b) => `${b.bundle} (${b.count})`)
      .join(', ');
    console.log(`   top bundles: ${bundleSummary}`);
  }
  if (preserved.length > 0) {
    console.log('   preserved on disk:');
    preserved.slice(0, 5).forEach((e) => console.log(`     • ${e.relPath} (${e.cls})`));
    if (preserved.length > 5) {
      console.log(`     ... and ${preserved.length - 5} more`);
    }
  }
  if (replayLocked.length > 0) {
    console.log(`⚠ Skipped ${replayLocked.length} permission-locked ${replayLocked.length === 1 ? 'file' : 'files'} during WAL replay (EPERM/EACCES):`);
    replayLocked.slice(0, 5).forEach((p) => console.log(`   • ${p}`));
    if (replayLocked.length > 5) {
      console.log(`   ... and ${replayLocked.length - 5} more`);
    }
  }
  console.log('');
}

/**
 * atris clean - Workspace housekeeping with auto-heal
 *
 * - Detect and FIX broken MAP.md refs (auto-heal)
 * - Detect stale tasks (claimed but never completed)
 * - Archive old journal files (>30 days)
 * - Clean empty sections
 */
function cleanAtris(options = {}) {
  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');

  if (!fs.existsSync(atrisDir)) {
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        action: 'clean',
        error: 'atris/ folder not found. Run "atris init" first.',
      }, null, 2));
      process.exit(1);
    }
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const results = {
    staleTasks: [],
    brokenRefs: [],
    healedRefs: 0,
    healedRefDetails: [],
    unhealableRefs: [],
    archivedJournals: 0,
    cleanedSections: 0
  };

  // 0. Git working-tree hygiene scan (and atomic vault + reset on --apply)
  const { scanGitHygiene, vaultAndCleanCheckout, recoverInterruptedVault } = require('../lib/hygiene-vault');
  const graceMs = resolveGraceMinutes(options) * 60 * 1000;
  let gitHygiene = scanGitHygiene(cwd, { graceMs });
  let vaultOutcome = null;
  if (options.apply && !options.dryRun && gitHygiene.isGitRepo) {
    if (gitHygiene.actionableCount > 0) {
      vaultOutcome = vaultAndCleanCheckout(cwd, {
        graceMs,
        ...(options.quarantineRoot ? { quarantineRoot: options.quarantineRoot } : {}),
      });
      gitHygiene = vaultOutcome.scan;
    } else {
      const recovery = recoverInterruptedVault(cwd, {
        ...(options.quarantineRoot ? { quarantineRoot: options.quarantineRoot } : {}),
      });
      if (recovery.recovered.length > 0) {
        gitHygiene = scanGitHygiene(cwd, { graceMs });
        results.recoveredVaults = recovery.recovered;
      }
    }
  }
  results.gitHygiene = gitHygiene;
  results.vault = vaultOutcome;

  // 1. Check for stale tasks in TODO.md
  const staleTasks = findStaleTasks(atrisDir);
  results.staleTasks = staleTasks;

  // 2. Find and HEAL broken MAP.md references
  // Legacy mutators re-dirty HEAD after git vault/reset; --vault-only skips them.
  const runLegacyMutators = !options.vaultOnly;
  const {
    healed,
    unhealable,
    replacements,
    checked = 0,
    skipped = 0,
  } = runLegacyMutators
    ? healBrokenMapRefs(cwd, atrisDir, options.dryRun)
    : { healed: 0, unhealable: [], replacements: [], checked: 0, skipped: 0 };
  results.healedRefs = healed;
  results.checkedRefs = checked;
  results.skippedRefs = skipped;
  results.healedRefDetails = replacements;
  results.unhealableRefs = unhealable;

  // 2b. Let the repo refresh and validate its own MAP.md, if it ships scripts for it
  const mapScripts = runLegacyMutators ? runMapScripts(cwd, options.dryRun) : [];
  results.mapScripts = mapScripts;

  // 3. Archive old journals (>30 days)
  const archived = runLegacyMutators ? archiveOldJournals(atrisDir, options.dryRun) : 0;
  results.archivedJournals = archived;

  // 4. Clean empty sections in TODO.md
  const cleaned = runLegacyMutators ? cleanEmptySections(atrisDir, options.dryRun) : 0;
  results.cleanedSections = cleaned;

  // 5. Find stale wiki pages (source newer than last_compiled)
  const stalePages = findStalePages(cwd, atrisDir);
  results.stalePages = stalePages;

  // 6. Dead code report (report-only: deletion is a human/reviewed call)
  try {
    const { findDeadCode } = require('./slop');
    const dead = findDeadCode(cwd);
    results.deadFiles = dead.dead.map((f) => path.relative(cwd, f));
    results.testOnlyFiles = dead.testOnly.map((f) => path.relative(cwd, f));
  } catch { results.deadFiles = []; results.testOnlyFiles = []; }

  if (options.json) {
    console.log(JSON.stringify(cleanResultPayload(results, options, cwd), null, 2));
    return results;
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Clean                                                 │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Report results
  console.log('Results:');
  console.log('');

  const wikiNudge = wikiMetabolismNudge(cwd);
  if (wikiNudge) {
    console.log(wikiNudge);
    console.log('');
  }

  // Stale tasks
  if (staleTasks.length > 0) {
    console.log(`⚠ ${staleTasks.length} stale ${staleTasks.length === 1 ? 'task' : 'tasks'} (claimed >3 days, not completed):`);
    staleTasks.forEach(task => {
      console.log(`   • ${task.title.substring(0, 50)}${task.title.length > 50 ? '...' : ''}`);
    });
    console.log('');
  } else {
    console.log('✓ No stale tasks');
  }

  // Healed refs
  const countText = refCountText(checked, skipped);
  if (healed > 0) {
    const verb = options.dryRun ? 'would heal' : 'healed';
    console.log(`✓ ${verb} ${healed} MAP.md ${healed === 1 ? 'reference' : 'references'} (${countText})`);
    (results.healedRefDetails || []).slice(0, 3).forEach(ref => {
      console.log(`   • ${ref.old} -> ${ref.new}${ref.symbol ? ` (${ref.symbol})` : ''}`);
    });
    if ((results.healedRefDetails || []).length > 3) {
      console.log(`   ... and ${results.healedRefDetails.length - 3} more`);
    }
  }

  // Unhealable refs
  if (unhealable.length > 0) {
    console.log(`⚠ ${unhealable.length} MAP.md ${unhealable.length === 1 ? 'ref' : 'refs'} couldn't be healed (${countText}):`);
    unhealable.slice(0, 3).forEach(ref => {
      console.log(`   • ${unhealableLine(ref)}`);
    });
    if (unhealable.length > 3) {
      console.log(`   ... and ${unhealable.length - 3} more`);
    }
    console.log('');
  } else if (checked === 0) {
    console.log(`○ ${countText}, nothing to validate`);
  } else if (healed === 0) {
    console.log(`✓ all MAP.md refs valid (${countText})`);
  }

  // Repo-local map scripts
  mapScripts.forEach(step => console.log(mapScriptLine(step)));

  // Archived journals
  if (archived > 0) {
    const verb = options.dryRun ? 'Would archive' : 'Archived';
    console.log(`✓ ${verb} ${archived} old journal(s)`);
  } else {
    console.log('✓ No journals need archiving');
  }

  // Cleaned sections
  if (cleaned > 0) {
    const verb = options.dryRun ? 'Would clean' : 'Cleaned';
    console.log(`✓ ${verb} ${cleaned} empty section(s)`);
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');

  // Stale pages
  if (stalePages.length > 0) {
    console.log(`⚠ ${stalePages.length} stale ${stalePages.length === 1 ? 'page' : 'pages'} (source changed since last compiled):`);
    stalePages.forEach(sp => {
      console.log(`   • ${path.relative(cwd, sp.page)}: stale source: ${sp.staleSource}`);
    });
    console.log('');
  } else {
    console.log('✓ No stale wiki pages');
  }

  // Dead code
  if ((results.deadFiles || []).length > 0) {
    console.log(`⚠ ${results.deadFiles.length} dead ${results.deadFiles.length === 1 ? 'file' : 'files'} (unreachable and unreferenced, atris slop dead for detail):`);
    results.deadFiles.slice(0, 5).forEach((f) => console.log(`   • ${f}`));
    if (results.deadFiles.length > 5) console.log(`   ... and ${results.deadFiles.length - 5} more`);
    console.log('');
  } else {
    console.log('✓ No dead code');
  }

  // Git working-tree hygiene
  renderGitHygieneText(gitHygiene, vaultOutcome, options, results.recoveredVaults);

  const hasGitDirt = Boolean(gitHygiene && gitHygiene.isGitRepo && gitHygiene.remainingDirty > 0);
  const lockedFiles = collectPermissionLocked(vaultOutcome, results.recoveredVaults);
  const hasIssues = staleTasks.length > 0
    || unhealable.length > 0
    || stalePages.length > 0
    || (results.deadFiles || []).length > 0
    || hasGitDirt;
  if (hasIssues) {
    console.log('Manual action needed:');
    if (staleTasks.length > 0) {
      console.log('  • Delete stale tasks or finish them');
    }
    if (unhealable.length > 0) {
      console.log('  • Manually fix unhealable MAP.md refs');
    }
    if (stalePages.length > 0) {
      console.log('  • Re-compile stale pages (re-read sources, update content + last_compiled)');
    }
    if ((results.deadFiles || []).length > 0) {
      console.log('  • Delete dead files (atris slop dead)');
    }
    if (hasGitDirt) {
      if (gitHygiene.actionableCount > 0 && (!options.apply || options.dryRun)) {
        console.log(`  • Run "atris clean --apply" to vault and clean ${gitHygiene.actionableCount} dirty git ${gitHygiene.actionableCount === 1 ? 'file' : 'files'}`);
      } else if (lockedFiles.length > 0) {
        console.log(`  • ${gitHygiene.remainingDirty} dirty git ${gitHygiene.remainingDirty === 1 ? 'file' : 'files'} preserved on disk (including ${lockedFiles.length} permission-locked/immutable)`);
      } else {
        console.log(`  • ${gitHygiene.remainingDirty} dirty git ${gitHygiene.remainingDirty === 1 ? 'file' : 'files'} preserved on disk (active in-flight, unprovable, or concurrently modified)`);
      }
    }
  } else {
    console.log('Workspace is clean. Target state: 0 ✓');
  }
  console.log('');

  return results;
}

// Repo-local MAP.md maintenance scripts, run in order when the workspace ships them.
const MAP_SCRIPTS = [
  {
    file: 'refresh_map_active.py',
    ranLabel: 'Refreshed MAP.md active files',
    dryLabel: 'Would refresh MAP.md active files',
    failLabel: 'MAP.md active files refresh failed',
  },
  {
    file: 'validate_map.py',
    ranLabel: 'MAP.md validation passed',
    dryLabel: 'Would validate MAP.md',
    failLabel: 'MAP.md validation failed',
  },
];

/**
 * Run the workspace's own MAP.md scripts (scripts/refresh_map_active.py, then
 * scripts/validate_map.py) when they exist. Report-only: a failing script does
 * not stop clean.
 */
function runMapScripts(cwd, dryRun = false) {
  const steps = [];

  for (const script of MAP_SCRIPTS) {
    const scriptPath = path.join(cwd, 'scripts', script.file);
    if (!fs.existsSync(scriptPath)) continue;

    const step = { script: `scripts/${script.file}`, status: 'ok', detail: '' };

    if (dryRun) {
      step.status = 'would_run';
      steps.push(step);
      continue;
    }

    const proc = spawnSync('python3', [scriptPath], { cwd, encoding: 'utf8', env: process.env });
    if (proc.error) {
      step.status = 'skipped';
      step.detail = proc.error.code === 'ENOENT' ? 'python3 not available' : proc.error.message;
    } else if ((proc.status ?? 0) !== 0) {
      step.status = 'failed';
      step.detail = firstLine(proc.stderr) || firstLine(proc.stdout) || `exit ${proc.status}`;
    }

    steps.push(step);
  }

  return steps;
}

function firstLine(text) {
  if (!text) return '';
  return String(text).split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
}

function mapScriptLine(step) {
  const script = MAP_SCRIPTS.find(s => step.script.endsWith(s.file));
  if (step.status === 'would_run') return `✓ ${script.dryLabel} (${step.script})`;
  if (step.status === 'skipped') return `○ Skipped ${step.script}: ${step.detail}`;
  if (step.status === 'failed') return `✗ ${script.failLabel}: ${step.detail}`;
  return `✓ ${script.ranLabel}`;
}

function cleanResultPayload(results, options = {}, cwd = process.cwd()) {
  const gitHygiene = results.gitHygiene || {
    isGitRepo: false,
    dirtyCount: 0,
    actionableCount: 0,
    remainingDirty: 0,
    byClass: {},
    entries: [],
    topBundles: [],
  };
  const vaultOutcome = results.vault || null;
  const preserved = preservedHygieneEntries(gitHygiene);
  const hasGitDirt = Boolean(gitHygiene.isGitRepo && gitHygiene.remainingDirty > 0);

  const manualAction = [];
  if (results.staleTasks.length > 0) manualAction.push('Delete stale tasks or finish them');
  if (results.unhealableRefs.length > 0) manualAction.push('Manually fix unhealable MAP.md refs');
  if (results.stalePages.length > 0) manualAction.push('Re-compile stale pages');
  if ((results.deadFiles || []).length > 0) manualAction.push('Delete dead files (atris slop dead)');
  const lockedFiles = collectPermissionLocked(vaultOutcome, results.recoveredVaults);
  if (hasGitDirt) {
    if (gitHygiene.actionableCount > 0 && (!options.apply || options.dryRun)) {
      manualAction.push(`Run "atris clean --apply" to vault and clean ${gitHygiene.actionableCount} dirty git file(s)`);
    } else if (lockedFiles.length > 0) {
      manualAction.push(`${gitHygiene.remainingDirty} dirty git file(s) preserved on disk (including ${lockedFiles.length} permission-locked/immutable)`);
    } else {
      manualAction.push(`${gitHygiene.remainingDirty} dirty git file(s) preserved on disk (active in-flight, unprovable, or concurrently modified)`);
    }
  }

  const targetState = results.staleTasks.length
    + results.unhealableRefs.length
    + results.stalePages.length
    + (results.deadFiles || []).length
    + (hasGitDirt ? gitHygiene.remainingDirty : 0);

  return {
    ok: manualAction.length === 0,
    action: 'clean',
    dry_run: !!options.dryRun,
    apply: !!options.apply,
    vault_only: !!options.vaultOnly,
    target_state: targetState,
    results: {
      stale_tasks: {
        count: results.staleTasks.length,
        items: results.staleTasks,
      },
      map_refs: {
        checked_count: results.checkedRefs || 0,
        skipped_count: results.skippedRefs || 0,
        healed_count: results.healedRefs,
        verb: options.dryRun ? 'would_heal' : 'healed',
        items: results.healedRefDetails || [],
        unhealable_count: results.unhealableRefs.length,
        unhealable: results.unhealableRefs,
      },
      journals: {
        archived_count: results.archivedJournals,
        verb: options.dryRun ? 'would_archive' : 'archived',
      },
      sections: {
        cleaned_count: results.cleanedSections,
        verb: options.dryRun ? 'would_clean' : 'cleaned',
      },
      stale_pages: {
        count: results.stalePages.length,
        items: results.stalePages.map(page => ({
          page: path.relative(cwd, page.page),
          stale_source: page.staleSource,
        })),
      },
      dead_code: {
        count: (results.deadFiles || []).length,
        items: results.deadFiles || [],
        test_only: results.testOnlyFiles || [],
      },
      map_scripts: {
        count: (results.mapScripts || []).length,
        items: results.mapScripts || [],
      },
      git_hygiene: {
        is_git_repo: Boolean(gitHygiene.isGitRepo),
        dirty_count: gitHygiene.dirtyCount || 0,
        actionable_count: gitHygiene.actionableCount || 0,
        remaining_dirty: gitHygiene.remainingDirty || 0,
        by_class: gitHygiene.byClass || {},
        top_bundles: gitHygiene.topBundles || [],
        preserved: preserved.map((e) => ({ path: e.relPath, cls: e.cls })),
        vault: vaultOutcome ? {
          applied: Boolean(vaultOutcome.applied),
          vault_id: vaultOutcome.vaultId || null,
          refs: vaultOutcome.refs || null,
          quarantine_dir: vaultOutcome.quarantineDir || null,
          vaulted_count: vaultOutcome.receipt ? (vaultOutcome.receipt.vaulted_files || []).length : 0,
          quarantined_count: vaultOutcome.receipt ? (vaultOutcome.receipt.quarantine_files || []).length : 0,
          reset_stats: vaultOutcome.resetStats || null,
        } : null,
        ...((results.recoveredVaults || []).length > 0 ? { recovered_vaults: results.recoveredVaults } : {}),
        ...(lockedFiles.length > 0 ? { skipped_permission_locked: lockedFiles } : {}),
      },
    },
    manual_action: manualAction,
  };
}

/**
 * Find tasks claimed but not completed after 3+ days
 */
function findStaleTasks(atrisDir) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile) ? todoFile :
                       fs.existsSync(legacyFile) ? legacyFile : null;

  if (!taskFilePath) return [];

  const content = fs.readFileSync(taskFilePath, 'utf8');
  const staleTasks = [];

  const inProgressMatch = content.match(/## In Progress\n([\s\S]*?)(?=\n##|$)/);
  if (!inProgressMatch || !inProgressMatch[1].trim()) return [];

  const inProgressSection = inProgressMatch[1];
  const taskBlocks = inProgressSection.split(/\n### /).filter(b => b.trim());

  for (const block of taskBlocks) {
    const titleMatch = block.match(/Task:\s*(.+)/);
    const claimMatch = block.match(/\*\*Claimed by:\*\*\s*(.+?)(?:\s+at\s+(.+))?$/m);

    if (titleMatch) {
      const title = titleMatch[1].trim();
      const claimed = claimMatch ? claimMatch[0] : null;

      if (claimMatch && claimMatch[2]) {
        const claimDate = new Date(claimMatch[2]);
        const now = new Date();
        const daysSinceClaim = (now - claimDate) / (1000 * 60 * 60 * 24);

        if (daysSinceClaim > 3) {
          staleTasks.push({ title, claimed, daysSinceClaim: Math.floor(daysSinceClaim) });
        }
      } else if (claimed) {
        staleTasks.push({ title, claimed, daysSinceClaim: '?' });
      }
    }
  }

  return staleTasks;
}

/**
 * Find and heal broken MAP.md references (single-line AND range refs)
 * Detects both out-of-bounds AND drift (symbol moved to different line)
 * Returns { healed: number, unhealable: array }
 */
// The boot map routes; atris/refs/MAP-NOTES.md holds the deep file:line refs,
// or indexes area notes under atris/refs/map/ that hold them. Heal every one.
// Entries from a notes file carry `map` so reports can say where.
const MAP_NOTES_FILE = path.join('refs', 'MAP-NOTES.md');
const MAP_NOTES_DIR = path.join('refs', 'map');

function mapNoteFiles(atrisDir) {
  const files = [path.join(atrisDir, MAP_NOTES_FILE)];
  try {
    for (const name of fs.readdirSync(path.join(atrisDir, MAP_NOTES_DIR)).sort()) {
      if (name.endsWith('.md')) files.push(path.join(atrisDir, MAP_NOTES_DIR, name));
    }
  } catch { /* no area notes */ }
  return files.filter((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}

function refCountText(checked, skipped) {
  const noun = checked === 1 ? 'ref' : 'refs';
  const other = skipped > 0 ? `, skipped ${skipped} ${skipped === 1 ? 'path' : 'paths'} (other projects or git-ignored)` : '';
  return `checked ${checked} ${noun}${other}`;
}

function unhealableLine(ref) {
  // A plain path has no line of its own. Say where in the map it was written.
  if (ref.plain) return `${ref.file}: ${ref.reason} (${ref.map}:${ref.mapLine})`;
  return `${ref.file}:${ref.line}: ${ref.reason}`;
}

function healBrokenMapRefs(cwd, atrisDir, dryRun = false, homeDir = os.homedir()) {
  const mapFile = path.join(atrisDir, 'MAP.md');
  if (!fs.existsSync(mapFile)) return { healed: 0, unhealable: [], checked: 0, skipped: 0 };
  const result = healMapFileRefs(cwd, mapFile, dryRun, homeDir);
  for (const notesFile of mapNoteFiles(atrisDir)) {
    const notes = healMapFileRefs(cwd, notesFile, dryRun, homeDir);
    const map = path.relative(cwd, notesFile).split(path.sep).join('/');
    result.healed += notes.healed;
    result.checked += notes.checked;
    result.skipped += notes.skipped;
    result.unhealable = [...result.unhealable, ...notes.unhealable.map((entry) => ({ ...entry, map }))];
    result.replacements = [...(result.replacements || []), ...notes.replacements.map((entry) => ({ ...entry, map }))];
  }
  return result;
}

function healMapFileRefs(cwd, mapFile, dryRun, homeDir) {

  let mapContent = fs.readFileSync(mapFile, 'utf8');
  const unhealable = [];
  let healed = 0;
  let checked = 0;

  // Match both `file.js:123` and `file.js:123-456` with surrounding context
  // [^\S\n] = horizontal whitespace only (no newlines)
  // Required delimiter set, including the u2014 escape, prevents bleeding into adjacent refs on same line
  const refPattern = /(`?)([a-zA-Z0-9_~\-./\\]+\.(js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)(?:-(\d+))?(`?)([^\S\n]*[\(\[\u2014\-][^\S\n]*([^)\]\n]+))?/g;

  // Function Inventory form: `symbolName()` → `file:line[-line]`
  // Pre-scan to build a (file:line) → symbol map so refs with the symbol BEFORE them still verify.
  const preRefSymbols = {};
  const preRefPattern = /`([a-zA-Z_][a-zA-Z0-9_]*)\s*\(?\s*\)?`\s*(?:→|->)\s*`([a-zA-Z0-9_~\-./\\]+\.(?:js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)(?:-\d+)?`/g;
  let preMatch;
  while ((preMatch = preRefPattern.exec(mapContent)) !== null) {
    preRefSymbols[`${preMatch[2]}:${preMatch[3]}`] = preMatch[1];
  }

  // Cache file reads
  const fileCache = {};
  function readFileCached(filePath) {
    if (!fileCache[filePath]) {
      const expandedPath = filePath.startsWith('~/') || filePath.startsWith('~\\')
        ? path.join(homeDir, filePath.slice(2))
        : filePath;
      const fullPath = path.isAbsolute(expandedPath) ? expandedPath : path.join(cwd, expandedPath);
      if (!fs.existsSync(fullPath)) return null;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        fileCache[filePath] = { content, lines: content.split('\n') };
      } catch { return null; }
    }
    return fileCache[filePath];
  }

  const replacements = [];
  let match;

  while ((match = refPattern.exec(mapContent)) !== null) {
    const backtickBefore = match[1] || '';
    const filePath = match[2];
    const startLine = parseInt(match[4], 10);
    const endLine = match[5] ? parseInt(match[5], 10) : null;
    const backtickAfter = match[6] || '';
    const contextPart = match[8] || '';

    checked++;
    const file = readFileCached(filePath);
    if (!file) {
      unhealable.push({ file: filePath, line: startLine, reason: 'File not found' });
      continue;
    }

    let symbol = extractSymbol(contextPart);
    if (!symbol) symbol = preRefSymbols[`${filePath}:${startLine}`] || null;

    // Check if reference is still accurate
    const outOfBounds = startLine > file.lines.length || (endLine && endLine > file.lines.length);
    const drifted = symbol && startLine <= file.lines.length && !symbolAtLine(file.content, symbol, startLine);

    if (!outOfBounds && !drifted) continue;

    if (!symbol) {
      unhealable.push({ file: filePath, line: startLine, reason: 'No symbol to search for' });
      continue;
    }

    // Find where the symbol actually is now
    const newStart = findSymbolLine(file.content, symbol);
    if (!newStart) {
      // A "symbol" that appears nowhere in the file is often descriptive
      // prose from the annotation ("PATCH /api/...", "mission drain"), not
      // a code identifier. Suppress those for in-bounds refs to existing
      // files; still flag out-of-bounds refs and vanished identifiers
      // (camelCase/snake_case words were plausibly real symbols).
      const identifierLike = /[a-z][^\s]*[A-Z]|_/.test(symbol);
      if (outOfBounds || identifierLike) {
        unhealable.push({ file: filePath, line: startLine, reason: `Symbol "${symbol}" not found` });
      }
      continue;
    }

    if (endLine) {
      // Range ref: find new end by scanning for function end
      const originalSpan = endLine - startLine;
      const newEnd = findFunctionEnd(file.lines, newStart) || (newStart + originalSpan);
      const clampedEnd = Math.min(newEnd, file.lines.length);

      const oldRef = `${backtickBefore}${filePath}:${startLine}-${endLine}${backtickAfter}`;
      const newRef = `${backtickBefore}${filePath}:${newStart}-${clampedEnd}${backtickAfter}`;

      if (oldRef !== newRef) {
        replacements.push({ old: oldRef, new: newRef, symbol });
        healed++;
      }
    } else {
      // Single-line ref
      const oldRef = `${backtickBefore}${filePath}:${startLine}${backtickAfter}`;
      const newRef = `${backtickBefore}${filePath}:${newStart}${backtickAfter}`;

      if (oldRef !== newRef) {
        replacements.push({ old: oldRef, new: newRef, symbol });
        healed++;
      }
    }
  }

  // Plain backticked paths with no line number. Report only, never rewrite.
  const plain = checkPlainMapPaths(cwd, mapFile, mapContent);
  checked += plain.checked;
  unhealable.push(...plain.unhealable);

  // Apply replacements
  if (!dryRun && replacements.length > 0) {
    for (const r of replacements) {
      mapContent = mapContent.split(r.old).join(r.new);
    }
    fs.writeFileSync(mapFile, mapContent);
  }

  return { healed, unhealable, replacements, checked, skipped: plain.skipped };
}

// `folder/file.ext` with a slash and no `:line` suffix. The closing backtick must
// follow the extension. That keeps `file.js:12` and `file.jsonl` from matching here.
const PLAIN_PATH_PATTERN = /`((?:\.\.?\/)*[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)+\.(?:js|ts|py|go|rs|rb|java|c|cpp|h|hpp|md|json|yaml|yml))`/g;

// A plain path can be written from the project root, the map's own folder, or any
// folder between them. Each of those is a base the path is resolved against.
function plainPathBases(root, mapFile) {
  const bases = [root];
  let dir = path.dirname(path.resolve(mapFile));
  while (dir.startsWith(root + path.sep)) {
    bases.push(dir);
    dir = path.dirname(dir);
  }
  return bases;
}

function insideRoot(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Fenced code blocks hold examples, not navigation. Blank their lines, keeping
// every line number. The plain-path pass then never reads them.
function maskFencedBlocks(content) {
  let fence = null;
  return content.split('\n').map((line) => {
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (opener && opener[1][0] === fence.char && opener[1].length >= fence.length && opener[2].trim() === '') fence = null;
      return '';
    }
    if (opener && !(opener[1][0] === '`' && opener[2].includes('`'))) {
      fence = { char: opener[1][0], length: opener[1].length };
      return '';
    }
    return line;
  }).join('\n');
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

// Runtime files (state folders, logs) are written by the tools and are not in a
// fresh checkout. Paths the repo's own ignore rules cover are not dead refs.
function gitIgnoredPaths(cwd, paths) {
  if (paths.length === 0) return new Set();
  const out = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd, input: paths.join('\n'), encoding: 'utf8',
  });
  if (out.status !== 0 && out.status !== 1) return new Set();
  return new Set(String(out.stdout).split('\n').filter(Boolean));
}

// The first folder of a path, checked in the place it was resolved against. A path
// that climbs out of its base is judged by its first folder under the project root.
function firstFolderExists(root, base, target) {
  let anchor = base;
  let from = path.relative(base, target);
  if (from === '..' || from.startsWith('..' + path.sep)) {
    anchor = root;
    from = path.relative(root, target);
  }
  const parts = from.split(path.sep);
  return parts.length > 1 && isDirectory(path.join(anchor, parts[0]));
}

function checkPlainMapPaths(cwd, mapFile, content) {
  const root = path.resolve(cwd);
  const map = path.relative(root, path.resolve(mapFile)).split(path.sep).join('/');
  const bases = plainPathBases(root, mapFile);
  const scanned = maskFencedBlocks(content);
  const seen = new Set();
  const missing = [];
  let checked = 0;
  let skipped = 0;
  const pattern = new RegExp(PLAIN_PATH_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(scanned)) !== null) {
    const rel = match[1];
    if (seen.has(rel)) continue;
    seen.add(rel);
    // Anything that resolves outside the project belongs to another project.
    const candidates = bases
      .map((base) => ({ base, target: path.resolve(base, rel) }))
      .filter((candidate) => insideRoot(root, candidate.target));
    if (candidates.some((candidate) => fs.existsSync(candidate.target))) { checked++; continue; }
    // A path whose first folder is in none of its bases belongs to another project.
    const here = candidates
      .filter((candidate) => firstFolderExists(root, candidate.base, candidate.target))
      .map((candidate) => path.relative(root, candidate.target).split(path.sep).join('/'));
    if (here.length === 0) { skipped++; continue; }
    const mapLine = scanned.slice(0, match.index).split('\n').length;
    missing.push({ rel, mapLine, here });
  }
  const ignored = gitIgnoredPaths(root, missing.flatMap((entry) => entry.here));
  const unhealable = [];
  for (const { rel, mapLine, here } of missing) {
    if (here.every((candidate) => ignored.has(candidate))) { skipped++; continue; }
    checked++;
    unhealable.push({ file: rel, line: null, mapLine, map, reason: 'missing file', plain: true });
  }
  return { checked, skipped, unhealable };
}

/**
 * Check if a symbol is actually defined at or near a given line
 */
function symbolAtLine(fileContent, symbol, lineNum) {
  const lines = fileContent.split('\n');
  // Check a 5-line window around the referenced line
  const start = Math.max(0, lineNum - 3);
  const end = Math.min(lines.length, lineNum + 2);
  const escaped = escapeRegExp(symbol);
  const re = new RegExp(`\\b${escaped}\\b`);
  for (let i = start; i < end; i++) {
    if (re.test(lines[i])) return true;
  }
  return false;
}

/**
 * Find the end line of a function starting at startLine (1-indexed)
 * Tracks brace depth to find the matching closing brace
 */
function findFunctionEnd(lines, startLine) {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; foundOpen = true; }
      if (ch === '}') { depth--; }
    }
    if (foundOpen && depth === 0) {
      return i + 1; // 1-indexed
    }
  }

  return null;
}

/**
 * Extract a symbol name from context like "(interactiveEntry function)" or "Main entry" after punctuation
 */
function extractSymbol(context) {
  if (!context) return null;

  const original = context;

  // Clean up the context without stripping parentheses from a symbol ending in ().
  const unquoted = context.trim().replace(/`/g, '');
  const wrapper = unquoted.match(/^([\(\[])/)?.[1];
  let cleaned = unquoted
    .replace(/^[\(\[\u2014\-:]+\s*/, '')
    .trim();
  if (wrapper === '(') cleaned = cleaned.replace(/\)$/, '').trim();
  if (wrapper === '[') cleaned = cleaned.replace(/\]$/, '').trim();

  if (!cleaned) return null;

  const tokenMatch = cleaned.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\(\))?/);
  if (!tokenMatch) return null;

  const symbol = tokenMatch[1];
  const token = tokenMatch[0];
  const codeShaped = symbol.includes('_') || /[a-z][A-Z]/.test(symbol) || token.endsWith('()');
  if (codeShaped) return symbol;

  const isSingleWord = cleaned === symbol;
  const isBackticked = original.includes(`\`${symbol}\``);
  if (isSingleWord && isBackticked) return symbol;

  return null;
}

/**
 * Find the line number where a symbol is defined (strict patterns only)
 * Returns null if only loose matches found, prevents healing to wrong locations
 */
function findSymbolLine(fileContent, symbol) {
  const lines = fileContent.split('\n');
  const esc = escapeRegExp(symbol);

  // Strict definition patterns only, no loose fallback
  const patterns = [
    new RegExp(`^\\s*(async\\s+)?function\\s+${esc}\\s*\\(`),  // function name(
    new RegExp(`^\\s*(const|let|var)\\s+${esc}\\s*=`),          // const/let/var name =
    new RegExp(`^\\s*class\\s+${esc}\\b`),                      // class name
    new RegExp(`^\\s*${esc}\\s*[:(]`),                           // name: or name(
    new RegExp(`exports\\.${esc}\\s*=`),                         // exports.name =
    new RegExp(`^\\s*(async\\s+)?def\\s+${esc}\\s*\\(`),           // [async] def name( (Python)
  ];

  for (const pattern of patterns) {
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (pattern.test(lines[lineIdx])) {
        return lineIdx + 1;
      }
    }
  }

  return null;
}

/**
 * Find wiki pages whose sources have been modified after last_compiled.
 * Scans all .md files under atris/ for frontmatter with last_compiled + sources.
 */
function findStalePages(cwd, atrisDir) {
  const stalePages = [];
  const skippedDirs = new Set(['archive', 'runs', 'qa', 'node_modules', '.git']);
  const currentYear = new Date().getFullYear();

  function shouldSkipDir(dir, name) {
    if (skippedDirs.has(name)) return true;
    if (/^\d{4}$/.test(name) && path.basename(path.dirname(dir)) === 'logs') {
      return Number(name) < currentYear;
    }
    return false;
  }

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(fullPath, entry.name)) continue;
        scanDir(fullPath);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith('.md')) continue;
        const result = checkPageStaleness(cwd, fullPath);
        if (result) stalePages.push(result);
      }
    }
  }

  scanDir(atrisDir);
  return stalePages;
}

/**
 * When a source last changed. A checkout or rebase touches mtimes without
 * changing content, so a file git holds unchanged counts from its last commit.
 */
function contentChangedAt(sourcePath, mtime) {
  const dir = path.dirname(sourcePath);
  const name = path.basename(sourcePath);
  const status = spawnSync('git', ['status', '--porcelain', '--', name], { cwd: dir, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) return mtime;
  const log = spawnSync('git', ['log', '-1', '--format=%cI', '--', name], { cwd: dir, encoding: 'utf8' });
  const committed = log.status === 0 ? log.stdout.trim() : '';
  return committed ? new Date(committed) : mtime;
}

function looksLikePath(text) {
  if (!text || /\s/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  return text.includes('/') || /\.[A-Za-z0-9]+$/.test(text);
}

// A relative source can be written from the repo root, the page's own folder,
// or any folder in between (a brief citing "briefs/x.md" from the wiki root).
// The first place it exists wins; if none, the repo-root path is reported.
function resolveSource(cwd, pagePath, filePart) {
  if (path.isAbsolute(filePart)) return filePart;
  const root = path.resolve(cwd);
  const fromRoot = path.join(root, filePart);
  if (fs.existsSync(fromRoot)) return fromRoot;
  let dir = path.dirname(path.resolve(pagePath));
  while (dir.startsWith(root + path.sep)) {
    const candidate = path.join(dir, filePart);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return fromRoot;
}

/**
 * Parse frontmatter from a markdown file and check if any source is newer than last_compiled.
 * Returns { page, staleSource, compiledDate, sourceDate } or null if not stale.
 */
function checkPageStaleness(cwd, filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch { return null; }

  // Check for YAML frontmatter
  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return null;

  const frontmatter = content.substring(3, endIdx);

  // Parse last_compiled
  const compiledMatch = frontmatter.match(/last_compiled:\s*(\d{4}-\d{2}-\d{2})/);
  if (!compiledMatch) return null;

  const compiledDate = new Date(compiledMatch[1] + 'T23:59:59');

  // Parse sources list
  const sourcesMatch = frontmatter.match(/sources:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (!sourcesMatch) return null;

  const sources = sourcesMatch[1]
    .split('\n')
    .map(line => line.replace(/^\s+-\s+/, '').trim())
    .filter(Boolean);

  // Check each source's mtime against last_compiled.
  // Source entries can include a line range and/or a parenthesized annotation,
  // e.g. "bin/atris.js:199-340 (showHelp function)". Strip both before stat.
  for (const source of sources) {
    const filePart = source
      .replace(/\s*\([^)]*\)\s*$/, '')   // drop trailing "(annotation)"
      .replace(/:\d+(-\d+)?$/, '')        // drop trailing ":N" or ":N-M"
      .trim();
    // A plain-language source ("Voyage AI documentation") or a web link names
    // no file, so it can never be missing on disk. Only paths are checked.
    if (!looksLikePath(filePart)) continue;
    const sourcePath = resolveSource(cwd, filePath, filePart);
    try {
      const stat = fs.statSync(sourcePath);
      const changed = stat.mtime > compiledDate ? contentChangedAt(sourcePath, stat.mtime) : null;
      if (changed && changed > compiledDate) {
        return {
          page: filePath,
          staleSource: source,
          compiledDate: compiledMatch[1],
          sourceDate: localDay(changed)
        };
      }
    } catch {
      // Source file doesn't exist, that's also a staleness signal
      return {
        page: filePath,
        staleSource: source + ' (missing)',
        compiledDate: compiledMatch[1],
        sourceDate: 'N/A'
      };
    }
  }

  return null;
}

// A day can already be archived when a late entry lands in its journal.
// Renaming over the archive would erase it, so the late entry is added to the
// end instead, unless the archive already holds it word for word.
function moveIntoArchive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.renameSync(src, dest);
    return;
  }
  const late = fs.readFileSync(src, 'utf8');
  const kept = fs.readFileSync(dest, 'utf8');
  if (late.trim() && !kept.includes(late.trim())) {
    fs.writeFileSync(dest, `${kept.replace(/\n*$/, '\n')}\n${late}`);
  }
  fs.rmSync(src);
}

/**
 * Archive journals older than 30 days
 */
function archiveOldJournals(atrisDir, dryRun = false) {
  const logsDir = path.join(atrisDir, 'logs');
  if (!fs.existsSync(logsDir)) return 0;

  const archiveDir = path.join(logsDir, 'archive');
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let archived = 0;

  const yearFolders = fs.readdirSync(logsDir).filter(name => {
    const full = path.join(logsDir, name);
    return fs.statSync(full).isDirectory() && /^\d{4}$/.test(name) && name !== 'archive';
  });

  for (const year of yearFolders) {
    const yearDir = path.join(logsDir, year);
    const files = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]);
      if (fileDate < thirtyDaysAgo) {
        if (!dryRun) {
          const archiveYearDir = path.join(archiveDir, year);
          if (!fs.existsSync(archiveYearDir)) {
            fs.mkdirSync(archiveYearDir, { recursive: true });
          }
          const src = path.join(yearDir, file);
          const dest = path.join(archiveYearDir, file);
          moveIntoArchive(src, dest);
        }
        archived++;
      }
    }
  }

  return archived;
}

/**
 * Clean empty sections from TODO.md
 */
function cleanEmptySections(atrisDir, dryRun = false) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  if (!fs.existsSync(todoFile)) return 0;

  let content = fs.readFileSync(todoFile, 'utf8');
  let cleaned = 0;

  const emptyPatterns = [
    /\n### [^\n]+\n+\(empty\)\n*/gi,
    /\n### [^\n]+\n+\(No [^\)]+\)\n*/gi,
    /\n### [^\n]+\n+\(See [^\)]+\)\n*/gi
  ];

  for (const pattern of emptyPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      cleaned += matches.length;
      if (!dryRun) {
        content = content.replace(pattern, '\n');
      }
    }
  }

  if (cleaned > 0 && !dryRun) {
    content = content.replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(todoFile, content);
  }

  return cleaned;
}

module.exports = {
  cleanAtris,
  cleanResultPayload,
  parseCleanArgs,
  findStaleTasks,
  healBrokenMapRefs,
  unhealableLine,
  findStalePages,
  checkPageStaleness
};
